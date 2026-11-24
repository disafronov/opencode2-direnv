import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"

/**
 * Minimal stdio MCP server used by the integration tests.
 *
 * It records its process id and the value of DIRENV_TEST_VALUE so a test can
 * tell whether a process was started with the authorized environment and
 * whether recovery preserved or replaced an unrelated connection.
 */
const snapshot = process.argv[2]
if (snapshot) {
  writeFileSync(
    snapshot,
    `${JSON.stringify({
      pid: process.pid,
      value: process.env.DIRENV_TEST_VALUE ?? null,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
    })}\n`,
  )
}

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const tools = [
  {
    name: "environment_value",
    description: "Returns the value of DIRENV_TEST_VALUE in the server environment",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
]

const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined) return
  switch (message.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "direnv-test", version: "1.0.0" },
        },
      })
      return
    case "tools/list":
      send({ jsonrpc: "2.0", id: message.id, result: { tools } })
      return
    case "tools/call":
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: String(process.env.DIRENV_TEST_VALUE ?? "missing") }],
        },
      })
      return
    case "ping":
      send({ jsonrpc: "2.0", id: message.id, result: {} })
      return
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${String(message.method)}` },
      })
  }
})
