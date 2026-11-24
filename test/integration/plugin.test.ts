import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { OpenCode } from "@opencode/client"
import { parseStatus, type DirenvStatus } from "../../src/direnv.js"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))
const mcpFixture = join(repositoryRoot, "test", "fixtures", "mcp-server.mjs")
const nodeBinary = process.execPath
const serverPassword = "integration-test-password"

interface Project {
  readonly directory: string
  readonly wrappedSnapshot: string
  readonly plainSnapshot: string
}

interface ProjectOptions {
  readonly envrc?: string
  readonly authorization?: "allow" | "deny" | "none"
  readonly wrappedMcp?: boolean
  readonly plainMcp?: boolean
  readonly disabledMcp?: boolean
  readonly remoteMcp?: boolean
  readonly permissions?: ReadonlyArray<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>
}

interface PermissionAsk {
  readonly sessionID: string
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
  readonly message?: string | undefined
  readonly directory?: string | undefined
}

interface ToolRequest {
  readonly tools: readonly string[]
}

let root: string
let binDirectory: string
let pluginPath: string
let helperPath: string
let toolsDirectory: string
let direnvBinary: string
let opencodeBinary: string
let server: ReturnType<typeof spawn> | undefined
let client: ReturnType<typeof OpenCode.make>
let serverLogs = ""
let direnvEnvironment: Record<string, string>
let fakeLlm: ReturnType<typeof createServer> | undefined
let fakeLlmUrl: string
const permissionAsks: PermissionAsk[] = []

function which(name: string): string | undefined {
  const path = process.env.PATH
  if (!path) return undefined
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function resolveOpencodeBinary(): string {
  const configured = process.env.OPENCODE2_BIN
  if (configured) {
    if (!existsSync(configured)) throw new Error(`OPENCODE2_BIN does not exist: ${configured}`)
    const version = spawnSync(configured, ["--version"], { encoding: "utf8" })
    if (!/v?2\.\d+\.\d+/.test(version.stdout ?? "")) {
      throw new Error(`OPENCODE2_BIN is not OpenCode V2: ${configured}`)
    }
    return configured
  }
  const opencode2 = which("opencode2")
  if (opencode2) return opencode2
  const opencode = which("opencode")
  if (opencode) {
    const version = spawnSync(opencode, ["--version"], { encoding: "utf8" })
    if (/v?2\.\d+\.\d+/.test(version.stdout ?? "")) return opencode
  }
  throw new Error("OpenCode V2 was not found. Set OPENCODE2_BIN to an OpenCode 2 executable.")
}

function resolveDirenvBinary(): string {
  const binary = process.env.DIRENV_BIN ?? which("direnv")
  if (!binary) throw new Error("direnv was not found. Set DIRENV_BIN to the direnv executable.")
  return binary
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function createHelperPlugin(directory: string): string {
  const helperDirectory = join(directory, "helper-plugin")
  mkdirSync(helperDirectory, { recursive: true })
  writeJson(join(helperDirectory, "package.json"), {
    name: "opencode2-direnv-test-helper",
    version: "0.0.0",
    type: "module",
    exports: { ".": "./index.js" },
  })
  writeFileSync(
    join(helperDirectory, "index.js"),
    `import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Model, Provider } from "@opencode/plugin"

const providerID = Provider.ID.make("direnvtest")
const modelID = Model.ID.make("echo")

export default {
  id: "opencode2-direnv-test-helper",
  async setup(ctx) {
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Direnv Test",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: process.env.DIRENV_TEST_LLM_URL },
        },
        models: [{ ...Model.Info.default(providerID, modelID), name: "Echo" }],
      })
    })
    await ctx.session.hook("context", (event) => {
      const directory = process.env.DIRENV_TEST_TOOLS_DIR
      if (!directory) return
      mkdirSync(directory, { recursive: true })
      writeFileSync(
        join(directory, event.sessionID + ".json"),
        JSON.stringify({ model: event.model, tools: Object.keys(event.tools) }),
      )
    })
  },
}
`,
  )
  return helperDirectory
}

function createProject(name: string, options: ProjectOptions = {}): Project {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  if (options.envrc !== undefined) writeFileSync(join(directory, ".envrc"), options.envrc)

  const wrappedSnapshot = join(directory, "wrapped-snapshot.json")
  const plainSnapshot = join(directory, "plain-snapshot.json")
  const servers: Record<string, unknown> = {}
  if (options.wrappedMcp !== false) {
    servers.wrapped = {
      type: "local",
      command: ["direnv", "exec", directory, nodeBinary, mcpFixture, wrappedSnapshot],
      protocol: "legacy",
      codemode: false,
      cwd: directory,
    }
  }
  if (options.plainMcp) {
    servers.plain = {
      type: "local",
      command: [nodeBinary, mcpFixture, plainSnapshot],
      protocol: "legacy",
      codemode: false,
      cwd: directory,
    }
  }
  if (options.disabledMcp) {
    servers.disabled = {
      type: "local",
      command: ["direnv", "exec", directory, nodeBinary, mcpFixture],
      protocol: "legacy",
      codemode: false,
      disabled: true,
      cwd: directory,
    }
  }
  if (options.remoteMcp) servers.remote = { type: "remote", url: "http://127.0.0.1:1/mcp" }

  writeJson(join(directory, "opencode.json"), {
    $schema: "https://opencode.ai/config.json",
    plugins: [pluginPath, helperPath],
    mcp: { servers },
  })

  if (options.authorization === "allow") runDirenv("allow", directory)
  if (options.authorization === "deny") {
    // Older direnv versions can only remove an existing allow file, while
    // newer ones record an explicit denial for the path.
    runDirenv("allow", directory)
    runDirenv("deny", directory)
  }

  return { directory, wrappedSnapshot, plainSnapshot }
}

function runDirenv(command: "allow" | "deny", directory: string): void {
  const result = spawnSync(direnvBinary, [command], {
    cwd: directory,
    env: direnvEnvironment,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`direnv ${command} failed: ${result.stderr}`)
}

function direnvStatus(directory: string): DirenvStatus {
  const result = spawnSync(direnvBinary, ["status"], {
    cwd: directory,
    env: direnvEnvironment,
    encoding: "utf8",
  })
  if (result.status !== 0) throw new Error(`direnv status failed: ${result.stderr}`)
  return parseStatus(result.stdout)
}

function readSnapshot(path: string): { pid?: number; value?: string | null } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { pid?: number; value?: string | null }
  } catch {
    return undefined
  }
}

async function waitFor<T>(
  operation: () => Promise<T | undefined | false> | T | undefined | false,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const started = Date.now()
  let last: unknown
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await operation()
      if (value) return value
      last = value
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${label}; last result: ${String(last)}\n${serverLogs.slice(-4_000)}`)
}

async function waitForStatus(directory: string, kind: DirenvStatus["kind"], allowPath?: string): Promise<void> {
  await waitFor(() => {
    const status = direnvStatus(directory)
    if (status.kind !== kind) return false
    if (allowPath === undefined) return true
    return "allowPath" in status && status.allowPath === allowPath
  }, `${directory} direnv ${kind}`)
}

async function waitForMcp(directory: string, name: string, status: string): Promise<void> {
  await waitFor(async () => {
    const list = await client.mcp.list({ location: { directory } })
    return list.data.some((server) => server.name === name && server.status.status === status)
  }, `${name} ${status}`)
}

async function waitForTools(sessionID: string): Promise<ToolRequest> {
  const path = join(toolsDirectory, `${sessionID}.json`)
  return waitFor(() => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ToolRequest
    } catch {
      return false
    }
  }, `tools for ${sessionID}`)
}

async function createSession(directory: string, permissions?: ProjectOptions["permissions"]): Promise<string> {
  const session = await client.session.create({
    title: "authorization",
    location: { directory },
    model: { providerID: "direnvtest", id: "echo" },
    ...(permissions === undefined ? {} : { permissions }),
  })
  return session.id
}

async function waitForAsk(sessionID: string): Promise<PermissionAsk> {
  return waitFor(() => permissionAsks.find((ask) => ask.sessionID === sessionID), `permission request for ${sessionID}`)
}

async function reply(ask: PermissionAsk, decision: "once" | "always" | "reject"): Promise<void> {
  await client.permission.reply({ sessionID: ask.sessionID, requestID: ask.id, decision })
}

async function prompt(sessionID: string): Promise<void> {
  await client.session.prompt({ sessionID, text: "Run the test turn." })
}

async function promptWithApproval(sessionID: string, decision: "once" | "always" | "reject"): Promise<void> {
  const admission = prompt(sessionID)
  const ask = await waitForAsk(sessionID)
  await reply(ask, decision)
  await admission
}

async function freePort(): Promise<number> {
  const listener = createNetServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  if (address === null || typeof address === "string") throw new Error("could not allocate a test port")
  return address.port
}

async function startFakeLlm(): Promise<string> {
  const serverInstance = createServer((request, response) => {
    request.resume()
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "echo",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      response.write(chunk({ role: "assistant", content: "ok" }, null))
      response.write(chunk({}, "stop"))
      response.write("data: [DONE]\n\n")
      response.end()
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => serverInstance.listen(port, "127.0.0.1", resolve))
  fakeLlm = serverInstance
  return `http://127.0.0.1:${port}/v1`
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), "opencode2-direnv-integration-"))
  binDirectory = join(root, "bin")
  mkdirSync(binDirectory, { recursive: true })
  toolsDirectory = join(root, "tools")
  mkdirSync(toolsDirectory, { recursive: true })

  opencodeBinary = resolveOpencodeBinary()
  direnvBinary = resolveDirenvBinary()
  symlinkSync(direnvBinary, join(binDirectory, "direnv"))

  // Pack the plugin so the suite verifies the published entry point, not the
  // working tree.
  const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr}`)
  const tarball = join(root, pack.stdout.trim().split("\n").at(-1) ?? "")
  if (!existsSync(tarball)) throw new Error(`npm pack did not produce ${tarball}`)
  const packed = join(root, "packed")
  mkdirSync(packed, { recursive: true })
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", packed], { encoding: "utf8" })
  if (extract.status !== 0) throw new Error(`could not extract ${tarball}: ${extract.stderr}`)
  pluginPath = join(packed, "package")
  if (!existsSync(join(pluginPath, "dist", "index.js"))) throw new Error("packed plugin has no dist/index.js")
  helperPath = createHelperPlugin(root)

  const data = join(root, "xdg", "data")
  const state = join(root, "xdg", "state")
  const cache = join(root, "xdg", "cache")
  const config = join(root, "xdg", "config")
  for (const directory of [data, state, cache, config]) mkdirSync(directory, { recursive: true })

  direnvEnvironment = {
    ...process.env,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    DIRENV_LOG_FORMAT: "",
  } as Record<string, string>
  for (const key of ["DIRENV_DIR", "DIRENV_FILE", "DIRENV_DIFF", "DIRENV_WATCHES", "DIRENV_IN_ENVRC"]) {
    delete direnvEnvironment[key]
  }

  fakeLlmUrl = await startFakeLlm()
  const port = await freePort()
  const environment: Record<string, string> = {
    ...direnvEnvironment,
    PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    OPENCODE_SERVER_PASSWORD: serverPassword,
    DIRENV_TEST_LLM_URL: fakeLlmUrl,
    DIRENV_TEST_TOOLS_DIR: toolsDirectory,
    OPENCODE_DISABLE_MODELS_FETCH: "1",
  }
  delete environment.OPENCODE_PASSWORD

  server = spawn(opencodeBinary, ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk: Buffer) => (serverLogs += chunk.toString()))
  server.stderr?.on("data", (chunk: Buffer) => (serverLogs += chunk.toString()))

  client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
  })

  await waitFor(async () => {
    try {
      await client.server.info()
      return true
    } catch {
      return false
    }
  }, "OpenCode server")
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "permission.asked") continue
        permissionAsks.push({
          sessionID: event.data.sessionID,
          id: event.data.id,
          action: event.data.action,
          resources: event.data.resources,
          message: event.data.message,
          directory: event.location?.directory,
        })
      }
    } catch {
      // The server is shutting down.
    }
  })()
})

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([once(server, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  if (fakeLlm) await new Promise<void>((resolve) => fakeLlm?.close(() => resolve()))
  if (root) rmSync(root, { recursive: true, force: true })
})

test("a project without a direnv environment is not prompted", async () => {
  const project = createProject("unmanaged", { wrappedMcp: false })
  const sessionID = await createSession(project.directory)
  await prompt(sessionID)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === sessionID),
    false,
  )
  assert.equal(direnvStatus(project.directory).kind, "unmanaged")
  const tools = await waitForTools(sessionID)
  assert.equal(
    tools.tools.some((tool) => tool.includes("environment_value")),
    false,
  )
})

test("an already authorized environment is used without a prompt", async () => {
  const project = createProject("authorized", {
    envrc: "export DIRENV_TEST_VALUE=authorized\n",
    authorization: "allow",
  })
  await waitForMcp(project.directory, "wrapped", "connected")
  const sessionID = await createSession(project.directory)
  await prompt(sessionID)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === sessionID),
    false,
  )
  const tools = await waitForTools(sessionID)
  assert.ok(tools.tools.some((tool) => tool.includes("environment_value")))
  assert.equal(readSnapshot(project.wrappedSnapshot)?.value, "authorized")
})

test("missing authorization is granted through the permission prompt and MCP tools are available immediately", async () => {
  const project = createProject("approve", {
    envrc: "export DIRENV_TEST_VALUE=approved\n",
    plainMcp: true,
    disabledMcp: true,
    remoteMcp: true,
  })
  await waitForMcp(project.directory, "wrapped", "failed")
  await waitForMcp(project.directory, "plain", "connected")
  const plainPid = readSnapshot(project.plainSnapshot)?.pid

  const sessionID = await createSession(project.directory)
  const admission = prompt(sessionID)
  const ask = await waitForAsk(sessionID)
  assert.equal(ask.action, "direnv.allow")
  assert.deepEqual(ask.resources, [project.directory])
  assert.ok(ask.message?.includes(project.directory))
  assert.match(ask.message ?? "", /shell code/i)
  await reply(ask, "once")
  await admission

  await waitForStatus(project.directory, "authorized")
  await waitForMcp(project.directory, "wrapped", "connected")
  const tools = await waitForTools(sessionID)
  assert.ok(tools.tools.some((tool) => tool.includes("environment_value")))
  assert.equal(readSnapshot(project.wrappedSnapshot)?.value, "approved")

  // Unrelated and intentionally disabled servers are preserved.
  assert.equal(readSnapshot(project.plainSnapshot)?.pid, plainPid)
  const servers = await client.mcp.list({ location: { directory: project.directory } })
  assert.equal(servers.data.find((item) => item.name === "disabled")?.status.status, "disabled")
  assert.notEqual(servers.data.find((item) => item.name === "remote")?.status.status, "connected")
})

test("rejecting the prompt leaves direnv unauthorized and the turn continues", async () => {
  const project = createProject("reject", { envrc: "export DIRENV_TEST_VALUE=rejected\n" })
  await waitForMcp(project.directory, "wrapped", "failed")
  const sessionID = await createSession(project.directory)
  await promptWithApproval(sessionID, "reject")
  assert.equal(direnvStatus(project.directory).kind, "needs-authorization")
  await waitForMcp(project.directory, "wrapped", "failed")
  const tools = await waitForTools(sessionID)
  assert.equal(
    tools.tools.some((tool) => tool.includes("environment_value")),
    false,
  )
})

test("rejecting with feedback leaves direnv unauthorized", async () => {
  const project = createProject("reject-feedback", { envrc: "export DIRENV_TEST_VALUE=rejected\n" })
  const sessionID = await createSession(project.directory)
  const admission = prompt(sessionID)
  const ask = await waitForAsk(sessionID)
  await client.permission.reply({
    sessionID: ask.sessionID,
    requestID: ask.id,
    decision: "reject",
    message: "Not this project.",
  })
  await admission
  assert.equal(direnvStatus(project.directory).kind, "needs-authorization")
})

test("Always allow does not persist a permission rule", async () => {
  const project = createProject("always", { envrc: "export DIRENV_TEST_VALUE=always\n" })
  const sessionID = await createSession(project.directory)
  await promptWithApproval(sessionID, "always")
  await waitForStatus(project.directory, "authorized")

  const saved = await client.permission.saved.list({})
  assert.equal(
    saved.some((entry) => entry.action === "direnv.allow"),
    false,
  )

  // A later change requires a fresh confirmation even though "always" was used.
  writeFileSync(join(project.directory, ".envrc"), "export DIRENV_TEST_VALUE=always-changed\n")
  const nextSession = await createSession(project.directory)
  await promptWithApproval(nextSession, "once")
  await waitForStatus(project.directory, "authorized")
})

test("an explicit OpenCode denial is preserved", async () => {
  const project = createProject("denied-by-opencode", { envrc: "export DIRENV_TEST_VALUE=denied\n" })
  const sessionID = await createSession(project.directory, [{ action: "direnv.allow", resource: "*", effect: "deny" }])
  await prompt(sessionID)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === sessionID),
    false,
  )
  assert.equal(direnvStatus(project.directory).kind, "needs-authorization")
})

test("an explicit direnv denial is not overridden", async (t) => {
  const project = createProject("denied-by-direnv", {
    envrc: "export DIRENV_TEST_VALUE=denied\n",
    authorization: "deny",
  })
  if (direnvStatus(project.directory).kind !== "denied") {
    t.skip("this direnv version has no explicit deny state")
    return
  }
  const sessionID = await createSession(project.directory)
  await prompt(sessionID)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === sessionID),
    false,
  )
  assert.equal(direnvStatus(project.directory).kind, "denied")
})

test("a changed environment requires renewed authorization", async () => {
  const project = createProject("renew", {
    envrc: "export DIRENV_TEST_VALUE=first\n",
    authorization: "allow",
  })
  await waitForMcp(project.directory, "wrapped", "connected")
  const first = await createSession(project.directory)
  await prompt(first)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === first),
    false,
  )
  await waitFor(() => readSnapshot(project.wrappedSnapshot)?.value === "first", "initial MCP environment")

  writeFileSync(join(project.directory, ".envrc"), "export DIRENV_TEST_VALUE=second\n")
  const second = await createSession(project.directory)
  await promptWithApproval(second, "once")
  await waitForStatus(project.directory, "authorized")

  // A connected MCP server keeps the environment it started with. The plugin
  // only restarts failed or pending servers, so the next prompt must not ask
  // for authorization again.
  const third = await createSession(project.directory)
  await prompt(third)
  assert.equal(
    permissionAsks.some((ask) => ask.sessionID === third),
    false,
  )
})

test("an environment change while approval is pending cancels authorization", async () => {
  const project = createProject("pending-change", {
    envrc: "export DIRENV_TEST_VALUE=before\n",
  })
  const sessionID = await createSession(project.directory)
  const admission = prompt(sessionID)
  await waitForAsk(sessionID)
  writeFileSync(join(project.directory, ".envrc"), "export DIRENV_TEST_VALUE=after\n")
  await reply(await waitForAsk(sessionID), "once")
  await admission
  assert.equal(direnvStatus(project.directory).kind, "needs-authorization")
  await waitForMcp(project.directory, "wrapped", "failed")
})

test("concurrent requests for one project share a single prompt", async () => {
  const project = createProject("concurrent", { envrc: "export DIRENV_TEST_VALUE=concurrent\n" })
  const first = await createSession(project.directory)
  const second = await createSession(project.directory)
  const firstAdmission = prompt(first)
  const secondAdmission = prompt(second)
  const ask = await waitFor(
    () => permissionAsks.find((entry) => entry.resources[0] === project.directory),
    "shared permission request",
  )
  await reply(ask, "once")
  await Promise.all([firstAdmission, secondAdmission])
  await waitForStatus(project.directory, "authorized")
  const asksForProject = permissionAsks.filter((entry) => entry.resources[0] === project.directory)
  assert.equal(asksForProject.length, 1)
})

test("two project directories remain isolated", async () => {
  const alpha = createProject("alpha", { envrc: "export DIRENV_TEST_VALUE=alpha\n" })
  const beta = createProject("beta", { envrc: "export DIRENV_TEST_VALUE=beta\n" })
  const alphaSession = await createSession(alpha.directory)
  await promptWithApproval(alphaSession, "once")
  await waitForStatus(alpha.directory, "authorized")
  assert.equal(direnvStatus(beta.directory).kind, "needs-authorization")

  const betaSession = await createSession(beta.directory)
  await promptWithApproval(betaSession, "reject")
  assert.equal(direnvStatus(beta.directory).kind, "needs-authorization")
  await waitForMcp(alpha.directory, "wrapped", "connected")
  await waitFor(() => readSnapshot(alpha.wrappedSnapshot)?.value === "alpha", "alpha MCP environment")
})

test("unattended execution cannot silently authorize direnv", async () => {
  const project = createProject("unattended", {
    envrc: "export DIRENV_TEST_VALUE=unattended\n",
    wrappedMcp: false,
  })
  const data = join(root, "unattended-xdg", "data")
  const config = join(root, "unattended-xdg", "config")
  const cache = join(root, "unattended-xdg", "cache")
  for (const directory of [data, config, cache]) mkdirSync(directory, { recursive: true })

  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      opencodeBinary,
      ["run", "--standalone", "--model", "direnvtest/echo", "--print-logs", "hello"],
      {
        cwd: project.directory,
        env: {
          ...direnvEnvironment,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
          XDG_DATA_HOME: data,
          XDG_CONFIG_HOME: config,
          XDG_CACHE_HOME: cache,
          DIRENV_TEST_LLM_URL: fakeLlmUrl,
          DIRENV_TEST_TOOLS_DIR: toolsDirectory,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          PWD: project.directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let output = ""
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()))
    child.once("error", reject)
    child.once("exit", (code) => resolve({ code, output }))
  })

  // A non-interactive run auto-rejects the permission request. The plugin must
  // not turn that rejection into an authorization.
  assert.match(result.output, /direnv\.allow/)
  assert.match(result.output, /auto-rejecting/)
  assert.equal(direnvStatus(project.directory).kind, "needs-authorization")
})
