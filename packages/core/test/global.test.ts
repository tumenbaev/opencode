import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("expands only leading TMPDIR path tokens", () => {
    for (const token of ["${TMPDIR}", "$TMPDIR"]) {
      expect(path.normalize(Global.expandTmpPath(`${token}/opencode/scratch.txt`))).toBe(
        path.join(Global.Path.tmp, "scratch.txt"),
      )
      expect(Global.expandTmpPath(token)).toBe(path.dirname(Global.Path.tmp))
    }
    for (const value of ["$HOME/opencode", "$TMPDIR_OTHER/opencode", "a/$TMPDIR/opencode", "{$TMPDIR}/opencode"]) {
      expect(Global.expandTmpPath(value)).toBe(value)
    }
  })

  test("uses the OS fallback when TMPDIR is unset at startup", async () => {
    const env = { ...process.env }
    delete env.TMPDIR
    const child = Bun.spawn([process.execPath, "--eval", `
      const { Global } = await import("./src/global.ts")
      const path = await import("node:path")
      const os = await import("node:os")
      if (path.normalize(Global.expandTmpPath("$TMPDIR/opencode")) !== Global.Path.tmp) process.exit(1)
      if (path.dirname(Global.Path.tmp) !== os.tmpdir()) process.exit(2)
    `], { cwd: path.resolve(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
  })

  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "opencode"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
