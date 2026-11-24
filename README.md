# opencode2-direnv

An OpenCode V2 server plugin that lets a connected client authorize a project's
`direnv` environment through OpenCode's native permission prompt.

The plugin is an authorization bridge. It does not load, export, or manage
environment variables. Shell integration and explicitly configured
`direnv exec .` wrappers for local MCP servers remain responsible for using the
environment.

## Requirements

- **OpenCode V2**. Validated against OpenCode `2.4.1`.
- **direnv** on the `PATH` of the OpenCode server process. Validated against
  `2.32.1` and `2.38.2`.
- POSIX server platforms. Windows is not tested.

OpenCode V1 and the V1 plugin API are not supported.

## Installation

Add the plugin to the project or global OpenCode V2 configuration:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode2-direnv"],
}
```

A local checkout can be loaded by path after building it:

```jsonc
{
  "plugins": ["/home/me/src/opencode2-direnv"],
}
```

Local MCP servers that need the environment must be configured explicitly:

```jsonc
{
  "mcp": {
    "servers": {
      "example": {
        "type": "local",
        "command": ["direnv", "exec", "/path/to/project", "example-mcp-server"],
        "cwd": "/path/to/project",
      },
    },
  },
}
```

## Authorization behavior

Before each admitted user prompt, the plugin runs `direnv status` in
`ctx.location.directory` and distinguishes these states:

| State                                 | Behavior                                                        |
| ------------------------------------- | --------------------------------------------------------------- |
| No `.envrc` or `.env`                 | Continue without a prompt.                                      |
| Environment already authorized        | Continue without a prompt.                                      |
| Authorization required                | Request `direnv.allow` through OpenCode's permission interface. |
| Explicit direnv denial                | Do not prompt and do not override it.                           |
| `direnv` missing                      | Log one diagnostic and continue without authorization.          |
| Unrelated `direnv` failure or timeout | Log one diagnostic and continue without authorization.          |

When the user approves the permission prompt, the plugin:

1. Re-reads `direnv status`.
2. Verifies that direnv's own authorization identity (`allowPath`, derived from
   the resolved `.envrc` content) has not changed while the prompt was open.
3. Runs `direnv allow` in the project directory.
4. Verifies that the environment is authorized with the same identity.
5. Recovers failed direnv-wrapped MCP servers.

If the user rejects the prompt, the environment stays unchanged and the user
prompt continues normally.

### Permission details

- The action is `direnv.allow` and the resource is the project directory.
- The prompt text states that approval lets OpenCode execute project-controlled
  shell code from `.envrc` on the server.
- `save: []` is passed to `ctx.permission.assert()`, so **Always allow** has the
  same practical effect as **Allow once**: no rule is persisted.
- An `evaluate` hook forces `ask` for `direnv.allow`, even when a configured rule
  would allow it. An explicit `deny` never reaches the hook, so configured
  denials remain final.
- Authorization is performed by the plugin directly, never by a model.
- Concurrent prompts for the same directory share one authorization attempt.
  Different directories are never combined.

The project directory is fixed to the plugin instance's OpenCode location.
The plugin does not search for `.envrc` files elsewhere.

## MCP recovery

After a successful authorization, the plugin restarts only local MCP servers
that satisfy all of these conditions:

- The effective configuration is not disabled.
- The command explicitly starts with `direnv exec` (including an absolute path
  to the `direnv` executable).
- The connection status is `failed` or `pending`.

Remote servers, unrelated local servers, intentionally disabled servers, and
already connected servers are left untouched.

Recovery uses only the public plugin API:

1. A registered `ctx.mcp.transform()` marks the selected servers as temporarily
   disabled.
2. `ctx.mcp.reload()` disconnects them.
3. The temporary marks are cleared.
4. `ctx.mcp.reload()` restores the original configuration and reconnects them.

Both reloads cover the whole selected set. Temporary marks are cleared even if
recovery fails, and recovery operations within one location are serialized.
OpenCode's request-time MCP catalog flush makes the recovered tools available
to the model request that follows the prompt hook.

## Known limitations

### Automatic permission approval modes

OpenCode's `--auto` flag and the TUI's auto-accept mode reply to permission
requests on the user's behalf. The server API does not expose whether a reply
came from a human, so the plugin cannot distinguish an automatic approval from
an interactive one.

**Security implication:** while one of those modes is active, a project's
`.envrc` can be authorized without a human seeing the confirmation, and
approving `.envrc` means executing project-controlled shell code on the server.
Do not enable auto-approval when direnv authorization must be explicit. The
plugin does not try to detect or override these modes. A normal non-interactive
`opencode run` auto-rejects the request and does not authorize direnv, and
unattended automation requests fail closed.

### Already connected MCP servers

An MCP server that is already connected keeps the environment it started with.
If an authorized `.envrc` changes, OpenCode asks for authorization again, but
the plugin intentionally does not restart connected servers. Reconnect that
server if it must observe the new environment.

### direnv versions prior to 2.33

Those versions have no distinct deny state. `direnv deny` only removes an allow
record, so the environment appears as needing authorization rather than
explicitly denied.

### Other limits

- **No environment injection.** `direnv allow` records authorization; the plugin
  does not export variables or wrap commands.
- **No watchers.** Authorization is rechecked on prompt admission, not in the
  background.

## Security notes

- Environment values, `.envrc` contents, and direnv stderr are never logged.
- `direnv` is run without a shell, with a timeout and bounded output.
- State from a previously loaded direnv environment is removed from the child
  environment before running `direnv status` or `direnv allow`.
- Approving the prompt executes project-controlled code on the server. Treat it
  like any other permission that runs shell code.

## Development

```bash
npm install
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:integration
```

Integration tests need an OpenCode V2 executable and direnv:

```bash
OPENCODE2_BIN=/path/to/opencode2 \
DIRENV_BIN=/path/to/direnv \
npm run test:integration
```

The suite builds and packs the plugin, starts a real OpenCode V2 server with
isolated XDG directories, uses temporary project directories and a synthetic
stdio MCP server, and drives a local OpenAI-compatible fake model. It does not
need credentials or a paid model API.

## Tested versions

| Component | Version        |
| --------- | -------------- |
| OpenCode  | 2.4.1          |
| direnv    | 2.32.1, 2.38.2 |
| Node.js   | 24–26          |

The prompt hook (`ctx.session.hook("prompt")`) is the authorization entry point.
MCP recovery uses the transform plus two-reload procedure described above.
