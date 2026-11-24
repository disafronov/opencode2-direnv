import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  environmentForDirenv,
  findExecutable,
  parseStatus,
  probeDirenv,
  readStatus,
  runCommand,
} from "../../src/direnv.js"

test("a directory without an environment is unmanaged", () => {
  assert.deepEqual(parseStatus("No .envrc or .env loaded\nNo .envrc or .env found\n"), { kind: "unmanaged" })
})

test("direnv 2.32 reports authorization as a boolean", () => {
  const allowed = [
    "Loaded RC path /project/.envrc",
    "Loaded RC allowed true",
    "Loaded RC allowPath /data/allow/abc",
    "Found RC path /project/.envrc",
    "Found RC allowed true",
    "Found RC allowPath /data/allow/abc",
  ].join("\n")
  assert.deepEqual(parseStatus(allowed), { kind: "authorized", allowPath: "/data/allow/abc" })

  const blocked = allowed.replaceAll("allowed true", "allowed false")
  assert.deepEqual(parseStatus(blocked), { kind: "needs-authorization", allowPath: "/data/allow/abc" })
})

test("direnv 2.33 and newer reports authorization as an integer enum", () => {
  const status = (allowed: string) =>
    ["Found RC path /project/.envrc", `Found RC allowed ${allowed}`, "Found RC allowPath /data/allow/abc"].join("\n")

  assert.deepEqual(parseStatus(status("0")), { kind: "authorized", allowPath: "/data/allow/abc" })
  assert.deepEqual(parseStatus(status("1")), { kind: "needs-authorization", allowPath: "/data/allow/abc" })
  assert.deepEqual(parseStatus(status("2")), { kind: "denied", allowPath: "/data/allow/abc" })
})

test("the loaded environment does not affect the found one", () => {
  const output = [
    "Loaded RC path /old/.envrc",
    "Loaded RC allowed true",
    "Loaded RC allowPath /data/allow/old",
    "Found RC path /new/.envrc",
    "Found RC allowed false",
    "Found RC allowPath /data/allow/new",
  ].join("\n")
  assert.deepEqual(parseStatus(output), { kind: "needs-authorization", allowPath: "/data/allow/new" })
})

test("unexpected status output is an error, not an authorization decision", () => {
  assert.deepEqual(parseStatus(""), { kind: "error", message: "direnv status output was not recognized" })
  assert.deepEqual(parseStatus("Found RC path /project/.envrc\nFound RC allowed true\n"), {
    kind: "error",
    message: "direnv status did not report authorization details",
  })
  assert.deepEqual(parseStatus("Found RC path /p\nFound RC allowed maybe\nFound RC allowPath /data/allow/abc"), {
    kind: "error",
    message: "direnv status reported an unknown authorization state",
  })
})

test("the direnv environment drops state from a previously loaded environment", () => {
  const source = {
    PATH: "/bin",
    DIRENV_DIR: "-/old",
    DIRENV_FILE: "/old/.envrc",
    DIRENV_DIFF: "secret",
    DIRENV_WATCHES: "secret",
    DIRENV_IN_ENVRC: "1",
    KEEP: "value",
  }
  const result = environmentForDirenv(source)
  assert.equal(result.PATH, "/bin")
  assert.equal(result.KEEP, "value")
  assert.equal(result.DIRENV_LOG_FORMAT, "")
  assert.equal("DIRENV_DIR" in result, false)
  assert.equal("DIRENV_FILE" in result, false)
  assert.equal("DIRENV_DIFF" in result, false)
  assert.equal("DIRENV_WATCHES" in result, false)
  assert.equal("DIRENV_IN_ENVRC" in result, false)
  assert.equal(source.DIRENV_DIR, "-/old")
})

test("findExecutable resolves an executable on PATH", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const executable = join(directory, "tool")
    writeFileSync(executable, "#!/bin/sh\nexit 0\n")
    chmodSync(executable, 0o755)
    assert.equal(findExecutable("tool", `${directory}:/bin`), executable)
    assert.equal(findExecutable("missing", directory), undefined)
    assert.equal(findExecutable("tool", undefined), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("a missing direnv executable is reported as unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    assert.equal(probeDirenv({ PATH: directory }), undefined)
    assert.equal(probeDirenv({}), undefined)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("an unrelated direnv failure is reported as an error, not as authorization", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const binary = join(directory, "direnv")
    writeFileSync(binary, "#!/bin/sh\nexit 3\n")
    chmodSync(binary, 0o755)
    assert.deepEqual(await readStatus(binary, directory, { PATH: directory }), {
      kind: "error",
      message: "direnv status exited with code 3",
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("subprocess timeouts are bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      cwd: directory,
      env: process.env,
      timeoutMs: 100,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.equal(result.stdout, "")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("subprocess output is bounded", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
      cwd: directory,
      env: process.env,
      maxOutputBytes: 1024,
    })
    assert.equal(result.overflowed, true)
    assert.equal(result.code, null)
    assert.equal(result.stdout, "")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("subprocess spawn failures are reported without throwing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const result = await runCommand(join(directory, "missing"), [], { cwd: directory, env: process.env })
    assert.equal(result.errorCode, "ENOENT")
    assert.equal(result.code, null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("subprocess exit codes are reported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode2-direnv-unit-"))
  try {
    const binary = join(directory, "fail")
    writeFileSync(binary, "#!/bin/sh\nexit 3\n")
    chmodSync(binary, 0o755)
    const result = await runCommand(binary, [], { cwd: directory, env: process.env })
    assert.equal(result.code, 3)
    assert.equal(result.timedOut, false)
    assert.equal(result.overflowed, false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
