import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

/** Upper bound for every direnv subprocess started by the plugin. */
export const DIRENV_TIMEOUT_MS = 15_000

/** Refuse unexpectedly large output instead of buffering it without a bound. */
const MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * Direnv control variables that describe a previously loaded environment.
 *
 * A server started from a shell with direnv loaded inherits these values. They
 * describe the server's environment, not the project being inspected, and make
 * `direnv status` and `direnv allow` operate on stale state.
 */
const STALE_STATE_VARIABLES = ["DIRENV_DIR", "DIRENV_FILE", "DIRENV_DIFF", "DIRENV_WATCHES", "DIRENV_IN_ENVRC"] as const

/** Minimal process environment type shared by the plugin. */
export type Environment = Readonly<Record<string, string | undefined>>

/**
 * The authorization state of the environment that applies to a directory.
 *
 * `allowPath` is direnv's own authorization identity: the hash of the resolved
 * `.envrc` (or `.env`) content. It changes whenever the environment changes and
 * therefore distinguishes "same request" from "the file changed while the user
 * was deciding".
 */
export type DirenvStatus =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "authorized"; readonly allowPath: string }
  | { readonly kind: "needs-authorization"; readonly allowPath: string }
  | { readonly kind: "denied"; readonly allowPath: string }
  | { readonly kind: "error"; readonly message: string }

/** Result of one bounded direnv invocation. */
export interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly timedOut: boolean
  readonly overflowed: boolean
  readonly errorCode?: string
}

interface CommandOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

/**
 * Builds the environment for a direnv subprocess.
 *
 * State from a previously loaded environment is removed, and direnv's stderr
 * logging is suppressed. Direnv can print exported variable values on stderr;
 * this plugin never reads or logs them, and an empty format keeps them out of
 * the server log even when a child inherits stderr.
 */
export function environmentForDirenv(environment: Environment): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) result[key] = value
  }
  for (const key of STALE_STATE_VARIABLES) delete result[key]
  result.DIRENV_LOG_FORMAT = ""
  return result
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves an executable name against an explicit `PATH` without a shell. */
export function findExecutable(name: string, path: string | undefined): string | undefined {
  if (!path) return undefined
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** Resolves the direnv executable for this server process, if installed. */
export function probeDirenv(environment: Environment = process.env): string | undefined {
  return findExecutable("direnv", environment.PATH)
}

/**
 * Runs a command directly, without a shell, and bounds its lifetime and output.
 *
 * `execFile` supplies the timeout, output limit, and kill handling. Direnv's
 * `status` and `allow` commands only inspect or record the RC file; they do not
 * evaluate it, so killing the direct child is sufficient. Stderr is never read
 * or logged because direnv diagnostics may contain environment values.
 */
export function runCommand(binary: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DIRENV_TIMEOUT_MS
  const maxBuffer = options.maxOutputBytes ?? MAX_OUTPUT_BYTES

  return new Promise<CommandResult>((resolve) => {
    execFile(
      binary,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ code: 0, stdout, timedOut: false, overflowed: false })
          return
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ code: null, stdout: "", timedOut: false, overflowed: true })
          return
        }
        if (typeof error.code === "string" && error.code.length > 0) {
          // A spawn failure such as ENOENT, not an exit code.
          resolve({ code: null, stdout: "", timedOut: false, overflowed: false, errorCode: error.code })
          return
        }
        if (error.killed === true) {
          // The only signal this helper sends is the timeout SIGKILL.
          resolve({ code: null, stdout: "", timedOut: true, overflowed: false })
          return
        }
        resolve({
          code: typeof error.code === "number" ? error.code : null,
          stdout: "",
          timedOut: false,
          overflowed: false,
        })
      },
    )
  })
}

/**
 * Parses the plain-text output of `direnv status`.
 *
 * The text form is used instead of `direnv status --json` because it includes
 * `allowPath`, which is needed to detect changes while approval is pending.
 * Direnv 2.33 changed the `allowed` value from a boolean to an integer enum
 * (`0` allowed, `1` not allowed, `2` denied); both forms are accepted.
 */
export function parseStatus(output: string): DirenvStatus {
  let found = false
  let allowed: string | undefined
  let allowPath: string | undefined
  let unmanaged = false

  for (const line of output.split(/\r?\n/)) {
    if (line === "No .envrc or .env found") {
      unmanaged = true
      continue
    }
    if (line.startsWith("Found RC path ")) {
      found = true
      continue
    }
    if (line.startsWith("Found RC allowed ")) {
      allowed = line.slice("Found RC allowed ".length).trim()
      continue
    }
    if (line.startsWith("Found RC allowPath ")) {
      allowPath = line.slice("Found RC allowPath ".length).trim()
    }
  }

  if (!found) {
    return unmanaged ? { kind: "unmanaged" } : { kind: "error", message: "direnv status output was not recognized" }
  }
  if (allowed === undefined || allowPath === undefined || allowPath.length === 0) {
    return { kind: "error", message: "direnv status did not report authorization details" }
  }

  switch (allowed) {
    case "true":
    case "0":
      return { kind: "authorized", allowPath }
    case "false":
    case "1":
      return { kind: "needs-authorization", allowPath }
    case "2":
      return { kind: "denied", allowPath }
    default:
      return { kind: "error", message: "direnv status reported an unknown authorization state" }
  }
}

/** Resolves the current direnv authorization state for one directory. */
export async function readStatus(
  binary: string,
  directory: string,
  environment: Environment,
  timeoutMs = DIRENV_TIMEOUT_MS,
): Promise<DirenvStatus> {
  const result = await runCommand(binary, ["status"], {
    cwd: directory,
    env: environmentForDirenv(environment),
    timeoutMs,
  })
  if (result.errorCode === "ENOENT") return { kind: "error", message: "direnv executable was not found" }
  if (result.timedOut) return { kind: "error", message: "direnv status timed out" }
  if (result.overflowed) return { kind: "error", message: "direnv status produced too much output" }
  if (result.code !== 0) {
    return {
      kind: "error",
      message: result.code === null ? "direnv status failed to run" : `direnv status exited with code ${result.code}`,
    }
  }
  return parseStatus(result.stdout)
}

/** Result of one authorization attempt. */
export type AllowResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** Runs `direnv allow` in one project directory. */
export async function allowEnvironment(
  binary: string,
  directory: string,
  environment: Environment,
  timeoutMs = DIRENV_TIMEOUT_MS,
): Promise<AllowResult> {
  const result = await runCommand(binary, ["allow"], {
    cwd: directory,
    env: environmentForDirenv(environment),
    timeoutMs,
  })
  if (result.errorCode === "ENOENT") return { ok: false, message: "direnv executable was not found" }
  if (result.timedOut) return { ok: false, message: "direnv allow timed out" }
  if (result.overflowed) return { ok: false, message: "direnv allow produced too much output" }
  if (result.code !== 0) {
    return {
      ok: false,
      message: result.code === null ? "direnv allow failed to run" : `direnv allow exited with code ${result.code}`,
    }
  }
  return { ok: true }
}
