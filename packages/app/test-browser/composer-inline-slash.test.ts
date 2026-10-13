import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createComposerEditor } from "@/composer/editor/interaction"
import type { ComposerPersistedState, ComposerPrompt, ComposerSuggestion } from "@/composer/types"

const server: ComposerSuggestion = { id: "custom.review", kind: "command", label: "/review", trigger: "review" }
const local: ComposerSuggestion = { id: "review", kind: "command", label: "/review", trigger: "review", local: true }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

function setup() {
  return createRoot((dispose) => {
    const store = createStore<ComposerPersistedState>({ prompt: [], cursor: 0, context: { items: [] } })
    const selected: string[] = []
    const editor = document.createElement("div")
    editor.tabIndex = 0
    document.body.append(editor)
    const controller = createComposerEditor({
      store,
      commands: () => [server, local],
      context: () => [],
      searchContextFiles: () => [],
      onSuggestionSelect: (item) => () => {
        selected.push(item.id)
      },
      view: { submit: { stopping: () => false, onSubmit() {}, onStop() {} } },
    })
    controller.setEditor(editor)
    createComputed(() => {
      editor.textContent = controller.value()
    })

    return {
      controller,
      state: store[0],
      editor,
      selected,
      cleanup() {
        dispose()
        editor.remove()
      },
    }
  })
}

test("embedded suggestions exclude local actions, while leading commands and the menu retain them", async () => {
  const value = setup()
  const { controller } = value
  try {
    controller.onInput("/", [{ type: "text", content: "/", start: 0, end: 1 }], 1)
    await frame()
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review", "review"])
    controller.onInput("use /", [{ type: "text", content: "use /", start: 0, end: 5 }], 5)
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review"])
    await frame()
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review"])
    controller.onCursor(0)
    expect(controller.state.popover.type).toBe("closed")
    controller.onCursor(5)
    await frame()
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review"])

    controller.onInput("/", [{ type: "text", content: "/", start: 0, end: 1 }], 1)
    await frame()
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review", "review"])
    controller.dispatch({ type: "popover.select", item: local })
    expect(value.selected).toEqual(["review"])
    expect(controller.value()).toBe("")

    controller.onInput("existing", [{ type: "text", content: "existing", start: 0, end: 8 }], 8)
    controller.openCommands()
    await frame()
    expect(controller.state.popover.type).toBe("command-menu")
    expect(controller.suggestions().map((item) => item.id)).toEqual(["custom.review", "review"])
  } finally {
    value.cleanup()
  }
})

test.each([
  { text: "use /one /remainder later", cursor: 12, result: "use /one /review later", caret: 16, key: "Tab" },
  { text: "اشرح\t/re", cursor: 8, result: "اشرح\t/review ", caret: 13, key: "Enter" },
])("completes only the active token and restores the caret: $text", async (row) => {
  const value = setup()
  try {
    const prompt: ComposerPrompt = [
      { type: "file", path: "one", content: "@one", start: 0, end: 4 },
      { type: "text", content: ` ${row.text}`, start: 4, end: 5 + row.text.length },
      {
        type: "image",
        id: "image",
        filename: "diagram.png",
        mime: "image/png",
        blob: { id: "blob", url: "blob:test" },
      },
    ]
    value.controller.onInput(`@one ${row.text}`, prompt, 5 + row.cursor)
    await frame()
    expect(value.controller.onKeyDown(new KeyboardEvent("keydown", { key: row.key, cancelable: true }))).toBe(true)
    await frame()
    expect(value.controller.value()).toBe(`@one ${row.result}`)
    expect(value.state.prompt).toEqual([
      prompt[0],
      { type: "text", content: ` ${row.result}`, start: 4, end: 5 + row.result.length },
      prompt[2],
    ])
    expect(value.state.cursor).toBe(5 + row.caret)
    const selection = window.getSelection()!
    expect(selection.anchorNode).toBe(value.editor.firstChild)
    expect(selection.anchorOffset).toBe(5 + row.caret)
    expect(value.controller.state.popover.type).toBe("closed")
    value.controller.onCursor(5 + row.caret)
    expect(value.controller.state.popover.type).toBe("closed")
    expect(value.selected).toEqual([])
  } finally {
    value.cleanup()
  }
})
