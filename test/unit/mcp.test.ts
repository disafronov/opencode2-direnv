import assert from "node:assert/strict"
import { test } from "node:test"
import { isDirenvExecCommand, isRecoverableDirenvServer, selectServersToRecover } from "../../src/mcp.js"

test("detects commands that already enter direnv", () => {
  assert.equal(isDirenvExecCommand(["direnv", "exec", "/project", "node", "server.js"]), true)
  assert.equal(isDirenvExecCommand(["/usr/local/bin/direnv", "exec", "/project", "node"]), true)
  assert.equal(isDirenvExecCommand(["direnv", "allow"]), false)
  assert.equal(isDirenvExecCommand(["npx", "direnv", "exec"]), false)
  assert.equal(isDirenvExecCommand(["direnv"]), false)
  assert.equal(isDirenvExecCommand(undefined), false)
})

test("only enabled local direnv-wrapped servers are recoverable", () => {
  assert.equal(
    isRecoverableDirenvServer({ type: "local", command: ["direnv", "exec", "/project", "node", "server.js"] }),
    true,
  )
  assert.equal(
    isRecoverableDirenvServer({
      type: "local",
      command: ["direnv", "exec", "/project", "node", "server.js"],
      disabled: true,
    }),
    false,
  )
  assert.equal(isRecoverableDirenvServer({ type: "remote" }), false)
  assert.equal(isRecoverableDirenvServer({ type: "local", command: ["node", "server.js"] }), false)
})

test("only failed or pending servers are recovered", () => {
  const statuses = new Map([
    ["failed", "failed"],
    ["pending", "pending"],
    ["connected", "connected"],
    ["disabled", "disabled"],
  ])
  assert.deepEqual(selectServersToRecover(["failed", "pending", "connected", "disabled", "unknown"], statuses), [
    "failed",
    "pending",
  ])
  assert.deepEqual(selectServersToRecover(["connected", "unknown"], statuses), [])
})
