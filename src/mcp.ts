import { basename } from "node:path"
import type { Plugin as PluginApi } from "@opencode/plugin"

type Context = Parameters<PluginApi.Plugin["setup"]>[0]
type McpEditor = Parameters<Parameters<Context["mcp"]["transform"]>[0]>[0]

/** True when a local MCP command already enters direnv itself. */
export function isDirenvExecCommand(command: readonly string[] | undefined): boolean {
  const executable = command?.[0]
  return (
    command !== undefined &&
    command.length >= 2 &&
    executable !== undefined &&
    basename(executable) === "direnv" &&
    command[1] === "exec"
  )
}

/** The parts of an MCP server configuration this plugin reads. */
export interface McpServerConfigLike {
  readonly type: string
  readonly command?: readonly string[] | undefined
  readonly disabled?: boolean | undefined
}

/**
 * True when a server is an enabled local server whose command enters direnv.
 *
 * Remote servers, intentionally disabled servers, and local servers without an
 * explicit `direnv exec` wrapper are not affected by this plugin.
 */
export function isRecoverableDirenvServer(config: McpServerConfigLike): boolean {
  return config.type === "local" && config.disabled !== true && isDirenvExecCommand(config.command)
}

/**
 * Selects the servers that actually need a restart.
 *
 * Only a server that failed to start, or is still trying to start, can have been
 * held back by an unauthorized environment. Connected servers are left alone.
 */
export function selectServersToRecover(names: Iterable<string>, statuses: ReadonlyMap<string, string>): string[] {
  const selected: string[] = []
  for (const name of names) {
    const status = statuses.get(name)
    if (status === "failed" || status === "pending") selected.push(name)
  }
  return selected
}

/**
 * Restarts failed direnv-wrapped MCP servers after the environment becomes authorized.
 *
 * `ctx.mcp.reload()` only replays transforms and reconciles changed configuration;
 * an unchanged `direnv exec` command is not restarted by itself. This recorder
 * therefore registers one transform controlled by a temporary set of server
 * names. Reloading disconnects the selected servers, and reloading again after
 * clearing the set restores the original effective configuration and lets
 * OpenCode reconnect them.
 */
export class McpRecovery {
  private readonly names = new Set<string>()
  private suspended = new Set<string>()
  private rebuilding: Promise<void> | undefined

  constructor(private readonly context: Pick<Context, "mcp">) {}

  /** Registers the configuration transform. It does not touch servers by itself. */
  async start(): Promise<void> {
    await this.context.mcp.transform((editor) => this.apply(editor))
  }

  /** Restarts failed or pending direnv-wrapped servers, if any are affected. */
  async recover(): Promise<void> {
    if (this.rebuilding !== undefined) return this.rebuilding
    this.rebuilding = this.run().finally(() => {
      this.rebuilding = undefined
    })
    return this.rebuilding
  }

  private apply(editor: McpEditor): void {
    this.names.clear()
    for (const [name, config] of editor.list()) {
      if (isRecoverableDirenvServer(config)) this.names.add(name)
    }
    for (const name of this.suspended) {
      const config = editor.get(name)
      if (config?.type !== "local" || config.disabled === true) continue
      editor.update(name, (draft) => {
        draft.disabled = true
      })
    }
  }

  private async run(): Promise<void> {
    if (this.names.size === 0) return
    const servers = await this.context.mcp.list()
    const statuses = new Map(servers.data.map((server) => [server.name, server.status.status]))
    const selected = selectServersToRecover(this.names, statuses)
    if (selected.length === 0) return

    let failure: unknown
    this.suspended = new Set(selected)
    try {
      await this.context.mcp.reload()
    } catch (error) {
      failure = error
    } finally {
      // Always clear the temporary overrides, even when the first reload fails.
      // The second reload restores the original effective configuration.
      this.suspended = new Set()
      try {
        await this.context.mcp.reload()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
}
