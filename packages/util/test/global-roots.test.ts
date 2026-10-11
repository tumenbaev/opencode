import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

const module = pathToFileURL(path.join(import.meta.dir, "../src/global-roots.ts")).href
const temporary = process.platform === "linux" && !process.env.OPENCODE_TEST_HOME ? "/tmp" : os.tmpdir()

describe("global roots", () => {
  test("uses XDG overrides", () => {
    const root = path.join(os.tmpdir(), "opencode-xdg-overrides")
    const env = {
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    }

    expect(run(env)).toEqual({
      data: path.join(env.XDG_DATA_HOME, "opencode"),
      cache: path.join(env.XDG_CACHE_HOME, "opencode"),
      config: path.join(env.XDG_CONFIG_HOME, "opencode"),
      state: path.join(env.XDG_STATE_HOME, "opencode"),
      tmp: path.join(temporary, "opencode"),
    })
  })

  test("empty XDG overrides use home directory defaults", () => {
    const home = path.join(os.tmpdir(), "opencode-xdg-home")

    expect(
      run({
        XDG_DATA_HOME: "",
        XDG_CACHE_HOME: "",
        XDG_CONFIG_HOME: "",
        XDG_STATE_HOME: "",
        ...(process.platform === "win32" ? { USERPROFILE: home } : { HOME: home }),
      }),
    ).toEqual({
      data: path.join(home, ".local", "share", "opencode"),
      cache: path.join(home, ".cache", "opencode"),
      config: path.join(home, ".config", "opencode"),
      state: path.join(home, ".local", "state", "opencode"),
      tmp: path.join(temporary, "opencode"),
    })
  })
  test("uses /tmp on Linux while preserving test-harness isolation", () => {
    if (process.platform !== "linux") return
    const directory = "/tmp/opencode-roots-test"
    expect(run({ TMPDIR: directory, OPENCODE_TEST_HOME: "" }).tmp).toBe("/tmp/opencode")
    expect(run({ TMPDIR: directory, OPENCODE_TEST_HOME: directory }).tmp).toBe(path.join(directory, "opencode"))
  })
})

function run(env: Record<string, string>) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { roots } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(roots("opencode")))`,
    ],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString())
}
