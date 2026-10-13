import { beforeEach, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { directory, json, worktree } from "../fixture/tui-client"

beforeEach(() => {
  takeDraft(undefined)
})

test("inline slash offers server commands, not local UI actions", async () => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/command")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
          data: [
            { name: "review", description: "Server review command" },
            { name: "theme", description: "Server theme command" },
          ],
        })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("Please /")
  const frame = await setup.waitForFrame((frame) => frame.includes("Server review command"))
  expect(frame).not.toContain("Switch theme")
  expect(frame).toContain("Server theme command")
  setup.mockInput.pressTab()
  await setup.waitForFrame((frame) => frame.includes("Please /review ") && !frame.includes("Server review command"))
  const editor = setup.renderer.currentFocusedEditor
  expect(editor).toBeInstanceOf(TextareaRenderable)
  if (!(editor instanceof TextareaRenderable)) throw new Error("Missing prompt textarea")
  expect(editor.plainText).toBe("Please /review ")
  expect(editor.cursorOffset).toBe(15)

  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.mockInput.typeText("Please /theme")
  const inline = await setup.waitForFrame((frame) => frame.includes("Server theme command"))
  expect(inline).not.toContain("Switch theme")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Server theme command"))
  expect(editor.plainText).toBe("Please /theme ")

  setup.mockInput.pressKey("c", { ctrl: true })
  await setup.mockInput.typeText("/theme")
  await setup.waitForFrame((frame) => frame.includes("Switch theme"))
})

test.each([" ", "\n"])("inline slash replaces the entire nested token and preserves a %j suffix", async (separator) => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/command")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
          data: [{ name: "team/review", description: "Nested server command" }],
        })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText(`中文 /team/remainder${separator}keep suffix`)
  const editor = setup.renderer.currentFocusedEditor
  expect(editor).toBeInstanceOf(TextareaRenderable)
  if (!(editor instanceof TextareaRenderable)) throw new Error("Missing prompt textarea")
  editor.cursorOffset = 13 // After "中文 /team/re", before the rest of the token.
  await setup.mockInput.typeText("v")
  await setup.waitForFrame((frame) => frame.includes("Nested server command"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Nested server command"))
  expect(editor.plainText).toBe(`中文 /team/review${separator}keep suffix`)
  expect(editor.cursorOffset).toBe(17)
})

test.each(["Tab", "Enter"])("inline slash dismisses stale suggestions after caret movement (%s)", async (key) => {
  await using setup = await createAppFixture({
    fetch: (url) => {
      if (url.pathname === "/api/command")
        return json({
          location: { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } },
          data: [{ name: "other", description: "Other server command" }],
        })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("Use /review /oth")
  await setup.waitForFrame((frame) => frame.includes("Other server command"))
  const editor = setup.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Missing prompt textarea")
  editor.cursorOffset = 9
  if (key === "Tab") setup.mockInput.pressTab()
  else setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes("Other server command"))
  expect(editor.plainText).toBe("Use /review /oth")
  expect(editor.cursorOffset).toBe(9)
})
