import { Plugin } from "@opencode/plugin"
import { allowEnvironment, probeDirenv, readStatus, type DirenvStatus, type Environment } from "./direnv.js"
import { McpRecovery } from "./mcp.js"

const PLUGIN_ID = "opencode2-direnv"
const LOG_PREFIX = `[${PLUGIN_ID}]`

/** Dedicated permission action used for the direnv authorization prompt. */
export const DIRENV_ALLOW_ACTION = "direnv.allow"

type LogLevel = "info" | "warn"

/**
 * Emits each distinct diagnostic once per plugin instance. The prompt hook runs
 * for every user prompt, so repeated warnings about an unchanged condition would
 * otherwise flood the server log.
 */
class Diagnostics {
  private lastKey: string | undefined

  report(key: string, level: LogLevel, message: string): void {
    if (key === this.lastKey) return
    this.lastKey = key
    const line = `${LOG_PREFIX} ${message}`
    if (level === "warn") console.warn(line)
    else console.info(line)
  }
}

/** Describes why a status does not require or allow an authorization attempt. */
function statusDiagnostic(status: DirenvStatus, directory: string): { key: string; message: string } | undefined {
  switch (status.kind) {
    case "unmanaged":
    case "authorized":
      return undefined
    case "denied":
      return {
        key: "denied",
        message: `direnv access is explicitly denied for ${directory}; the plugin will not override it`,
      }
    case "needs-authorization":
      return undefined
    case "error":
      return { key: `status:${status.message}`, message: `${status.message} (${directory})` }
  }
}

const plugin = Plugin.define({
  id: PLUGIN_ID,

  async setup(context) {
    const directory = context.location.directory
    const environment: Environment = process.env
    const diagnostics = new Diagnostics()

    const availability = probeDirenv(environment)
    if (!availability.available) {
      diagnostics.report(
        "missing",
        "warn",
        `direnv executable was not found on PATH; direnv authorization is disabled for ${directory}`,
      )
      return
    }

    const binary = availability.binary
    const recovery = new McpRecovery(context)
    await recovery.start()

    // Force an interactive confirmation for this action even when configured
    // rules would allow it. An explicit `deny` is final and never reaches a
    // hook, so an explicit denial is preserved.
    await context.permission.hook("evaluate", (event) => {
      if (event.action !== DIRENV_ALLOW_ACTION) return
      const target = event.resources[0] ?? directory
      event.effect = "ask"
      event.message = `Authorize direnv for ${target}? Approving lets OpenCode execute project-controlled shell code from this directory's .envrc on the server.`
    })

    let inFlight: Promise<void> | undefined

    const recoverMcp = async (): Promise<void> => {
      try {
        await recovery.recover()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.report(
          `mcp:${message}`,
          "warn",
          `failed to restart direnv-wrapped MCP servers for ${directory}: ${message}`,
        )
      }
    }

    /** Runs one authorization attempt. It never throws into prompt admission. */
    const authorize = async (sessionID: string): Promise<void> => {
      try {
        const status = await readStatus(binary, directory, environment)
        const diagnostic = statusDiagnostic(status, directory)
        if (diagnostic !== undefined) {
          diagnostics.report(diagnostic.key, "warn", diagnostic.message)
          return
        }
        if (status.kind !== "needs-authorization") return

        // Remember direnv's own identity for the content being approved. If the
        // file changes while the prompt is open, the identity no longer matches.
        const identity = status.allowPath
        try {
          await context.permission.assert({
            sessionID,
            action: DIRENV_ALLOW_ACTION,
            resources: [directory],
            // Never persist an approval rule: "Always allow" must behave like
            // "Allow once" and the confirmation is required again next time.
            save: [],
          })
        } catch {
          diagnostics.report("declined", "info", `direnv authorization for ${directory} was not granted`)
          return
        }

        const current = await readStatus(binary, directory, environment)
        if (current.kind === "authorized" && current.allowPath === identity) {
          await recoverMcp()
          return
        }
        if (current.kind !== "needs-authorization" || current.allowPath !== identity) {
          diagnostics.report(
            "changed",
            "warn",
            `the direnv environment for ${directory} changed while approval was pending; it was not authorized`,
          )
          return
        }

        const allowed = await allowEnvironment(binary, directory, environment)
        if (!allowed.ok) {
          diagnostics.report(`allow:${allowed.message}`, "warn", `${allowed.message} (${directory})`)
          return
        }

        const verified = await readStatus(binary, directory, environment)
        if (verified.kind !== "authorized" || verified.allowPath !== identity) {
          diagnostics.report("verify", "warn", `direnv authorization could not be verified for ${directory}`)
          return
        }

        await recoverMcp()
      } catch (error) {
        // A permission denial, a missing session, or an unexpected failure must
        // not abort prompt admission. The environment simply stays unauthorized.
        const message = error instanceof Error ? error.message : String(error)
        diagnostics.report(`authorize:${message}`, "warn", `direnv authorization failed for ${directory}: ${message}`)
      }
    }

    /** Serializes authorization for this location. */
    const authorizeOnce = (sessionID: string): Promise<void> => {
      if (inFlight !== undefined) return inFlight
      inFlight = authorize(sessionID).finally(() => {
        inFlight = undefined
      })
      return inFlight
    }

    // Prompt admission is the earliest point that has a session, runs before
    // model execution, and can still be answered by the client without
    // deadlocking: the permission request is published as an event and the
    // admission waits for its reply.
    await context.session.hook("prompt", async (event) => {
      await authorizeOnce(event.sessionID)
    })
  },
})

export default plugin
