import assert from "node:assert/strict"
import { test } from "node:test"
import { McpRecovery } from "../../src/mcp.js"

/**
 * Builds a structural fake of the plugin MCP context. The real editor and
 * context types are generic over schema classes; the recovery code only needs
 * the members exercised here, so the fake is cast at the test boundary.
 */
function fakeContext(status: "failed" | "pending" | "connected" | "disabled") {
  const reloads: string[] = []
  const transforms: Array<(editor: unknown) => void> = []
  let disabled: boolean | undefined
  let failFirstReload = false
  let failSecondReload = false
  let reloadCount = 0

  const editor = {
    list: () => [["wrapped", { type: "local", command: ["direnv", "exec", "/project", "node", "server.js"] }]] as const,
    get: () => ({ type: "local" as const, command: ["direnv", "exec", "/project", "node", "server.js"], disabled }),
    update: (_name: string, update: (draft: { disabled?: boolean | undefined }) => void) => {
      const draft: { disabled?: boolean | undefined } = { disabled }
      update(draft)
      disabled = draft.disabled
    },
  }

  const replay = () => {
    disabled = undefined
    for (const transform of transforms) transform(editor)
  }

  const context = {
    mcp: {
      list: async () => ({ data: [{ name: "wrapped", status: { status } }] }),
      transform: async (callback: (editor: unknown) => void) => {
        transforms.push(callback)
        callback(editor)
        return { dispose: async () => {} }
      },
      reload: async () => {
        replay()
        reloads.push(disabled === true ? "disabled" : "original")
        reloadCount++
        if (failFirstReload) {
          failFirstReload = false
          throw new Error("reload failed")
        }
        if (failSecondReload && reloadCount % 2 === 0) {
          failSecondReload = false
          throw new Error("reload failed")
        }
      },
    },
  }

  return {
    context: context as unknown as ConstructorParameters<typeof McpRecovery>[0],
    reloads,
    failFirst: () => {
      failFirstReload = true
    },
    failSecond: () => {
      failSecondReload = true
    },
  }
}

test("recovery disconnects and restores the selected servers with two reloads", async () => {
  const fake = fakeContext("failed")
  const recovery = new McpRecovery(fake.context)
  await recovery.start()
  await recovery.recover()
  assert.deepEqual(fake.reloads, ["disabled", "original"])
})

test("recovery also handles a pending server", async () => {
  const fake = fakeContext("pending")
  const recovery = new McpRecovery(fake.context)
  await recovery.start()
  await recovery.recover()
  assert.deepEqual(fake.reloads, ["disabled", "original"])
})

test("connected and disabled servers are not restarted", async () => {
  for (const status of ["connected", "disabled"] as const) {
    const fake = fakeContext(status)
    const recovery = new McpRecovery(fake.context)
    await recovery.start()
    await recovery.recover()
    assert.deepEqual(fake.reloads, [], status)
  }
})

test("temporary overrides are cleared when the first reload fails", async () => {
  const fake = fakeContext("failed")
  fake.failFirst()
  const recovery = new McpRecovery(fake.context)
  await recovery.start()
  await assert.rejects(recovery.recover(), /reload failed/)
  assert.deepEqual(fake.reloads, ["disabled", "original"])

  await recovery.recover()
  assert.deepEqual(fake.reloads, ["disabled", "original", "disabled", "original"])
})

test("temporary overrides are cleared when the second reload fails", async () => {
  const fake = fakeContext("failed")
  fake.failSecond()
  const recovery = new McpRecovery(fake.context)
  await recovery.start()
  await assert.rejects(recovery.recover(), /reload failed/)
  assert.deepEqual(fake.reloads, ["disabled", "original"])

  // A later recovery must start from the original configuration, not from a
  // leaked temporary override.
  await recovery.recover()
  assert.deepEqual(fake.reloads, ["disabled", "original", "disabled", "original"])
})

test("concurrent recovery calls share one operation", async () => {
  const fake = fakeContext("failed")
  const recovery = new McpRecovery(fake.context)
  await recovery.start()
  await Promise.all([recovery.recover(), recovery.recover()])
  assert.deepEqual(fake.reloads, ["disabled", "original"])
})
