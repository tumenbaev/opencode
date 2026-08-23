import { describe, expect, test } from "bun:test"
import type { PromptInputV2PersistedState, PromptInputV2Suggestion } from "./types"
import { createPromptInputV2InteractionState, transitionPromptInputV2 } from "./machine"

const command: PromptInputV2Suggestion = {
  id: "review",
  kind: "command",
  label: "/review",
}

function persisted(value = "", cursor = value.length): PromptInputV2PersistedState {
  return {
    prompt: [{ type: "text", content: value, start: 0, end: value.length }],
    cursor,
    context: { items: [] },
  }
}

describe("prompt input v2 interaction machine", () => {
  test("opens embedded inline commands at the cursor", () => {
    const state = createPromptInputV2InteractionState()
    const value = "explain /re later"
    const open = transitionPromptInputV2(state, { type: "input.changed", value, persist: false }, persisted(value, 11))
    const closed = transitionPromptInputV2(
      state,
      { type: "input.changed", value: "explain/re", persist: false },
      persisted("explain/re"),
    )

    expect(open.state.popover).toEqual({ type: "command-inline", query: "re", index: 8 })
    expect(closed.state.popover).toEqual({ type: "closed" })
  })

  test("completes nested slash command names", () => {
    const value = "please /review/ later"
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value, persist: false },
      persisted(value, 15),
    )
    const item = { ...command, label: "/review/nested" }
    const selected = transitionPromptInputV2(open.state, { type: "popover.select", item }, persisted(value, 15))

    expect(open.state.popover).toEqual({ type: "command-inline", query: "review/", index: 7 })
    expect(selected.commands).toContainEqual({ type: "draft.setText", value: "please /review/nested later" })
  })

  test("preserves inline command prefix and suffix with one separator", () => {
    const value = "explain /relater"
    const input = persisted(value, 11)
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value, persist: false },
      input,
    )
    const selected = transitionPromptInputV2(open.state, { type: "popover.select", item: command }, input)

    expect(selected.commands).toContainEqual({ type: "draft.setText", value: "explain /review later" })
  })

  test("opens inline commands from the command control with the trigger index", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "command-inline", query: "", index: 0 })
  })

  test("opens context completion at the cursor", () => {
    const value = "alpha @sr omega"
    const input = persisted(value)
    input.cursor = 9

    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value, persist: false },
      input,
    )

    expect(result.state.popover).toEqual({ type: "context", query: "sr" })
  })

  test("enters shell mode from an initial exclamation mark", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "input.changed", value: "!", persist: false },
      persisted("!"),
    )

    expect(result.state.mode).toBe("shell")
    expect(result.commands).toContainEqual({ type: "draft.setText", value: "" })
  })

  test("leaves shell mode with escape", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Escape", ctrl: false, composing: false, ids: [] },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("leaves shell mode with backspace when empty", () => {
    const state = { ...createPromptInputV2InteractionState(), mode: "shell" as const }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "Backspace", ctrl: false, composing: false, ids: [], empty: true },
      persisted(),
    )

    expect(result.state.mode).toBe("normal")
    expect(result.handled).toBeTrue()
  })

  test("closes a popover with ctrl-g before stopping a run", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "first" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "g", ctrl: true, composing: false, ids: ["first"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "closed" })
    expect(result.handled).toBeTrue()
  })

  test("opens the searchable command menu for a populated draft", () => {
    const result = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )

    expect(result.state.popover).toEqual({ type: "command-menu", query: "" })
    expect(result.state.focus).toBe("command-search")
  })

  test("prepends a menu command and preserves existing text as arguments", () => {
    const open = transitionPromptInputV2(
      createPromptInputV2InteractionState(),
      { type: "commands.open" },
      persisted("existing text"),
    )
    const selected = transitionPromptInputV2(
      open.state,
      { type: "popover.select", item: command },
      persisted("existing text"),
    )

    expect(selected.commands).toContainEqual({ type: "draft.setText", value: "/review existing text" })
    expect(selected.state.popover).toEqual({ type: "closed" })
  })

  test("stores selected context files as prompt file parts", () => {
    const item: PromptInputV2Suggestion = {
      id: "src/index.ts",
      kind: "file",
      label: "index.ts",
      path: "src/index.ts",
    }
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "index" },
    }

    const selected = transitionPromptInputV2(state, { type: "popover.select", item }, persisted("@index"))

    expect(selected.commands).toContainEqual({ type: "mention.add", item })
  })

  test("loops active popover items with arrow keys", () => {
    const state = {
      ...createPromptInputV2InteractionState(),
      popover: { type: "context" as const, query: "", activeID: "second" },
    }
    const result = transitionPromptInputV2(
      state,
      { type: "key.down", key: "ArrowDown", ctrl: false, composing: false, ids: ["first", "second"] },
      persisted(),
    )

    expect(result.state.popover).toEqual({ type: "context", query: "", activeID: "first" })
    expect(result.handled).toBeTrue()
  })
})
