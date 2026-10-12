import { describe, expect, test } from "bun:test"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"

const entry = (name: string, pinned = false): CodeModeCatalog.Tool => ({
  type: "tool",
  name,
  description: "Hidden description",
  signature: `tools.${name}({ q: string }): Promise<string>`,
  pinned,
})

const summary = (tools: CodeModeCatalog.Inventory["tools"], budget?: number) =>
  CodeModeCatalog.summarize({ tools }, budget === undefined ? {} : { budget })

describe("CodeModeCatalog", () => {
  test("lists all names in canonical order regardless of budget, pinning, or namespace nesting", () => {
    const tools: CodeModeCatalog.Inventory["tools"] = [
      entry("z.last", true),
      { type: "namespace", name: "a", description: "Hidden namespace", tools: [entry("tool-name"), entry("first", true)] },
      entry("middle"),
    ]
    for (const budget of [0, 1, 2_000]) {
      const catalog = summary(tools, budget)
      expect(catalog.total).toBe(4)
      expect(catalog.namespaces.flatMap((namespace) => namespace.tools)).toEqual([
        "a.first", "a.tool-name", "middle", "z.last",
      ])
      const text = CodeModeInstructions.render(catalog)
      expect(text.split("## Code Mode tools (call only inside `execute`)\n\n")[1]).toBe(
        "- a.first\n- a.tool-name\n- middle\n- z.last",
      )
      expect(text).toContain("call the native `describe` tool")
      expect(text).not.toContain("Hidden")
      expect(text).not.toContain("Promise")
      expect(text).not.toContain("search")
    }
  })

  test("does not render signatures even for large inventories or lookups", () => {
    const tools = Array.from({ length: 10_000 }, (_, index): CodeModeCatalog.Tool => ({
      ...entry(`bulk.tool${index}`),
      get signature() {
        throw new Error("signature should not be rendered")
      },
    }))
    const catalog = summary(tools, 0)
    expect(catalog.total).toBe(10_000)
    expect(catalog.namespaces[0]?.entries).toHaveLength(10_000)
    expect(CodeModeCatalog.lookup({ tools })("bulk.tool0")).toEqual({ path: "bulk.tool0", line: "- bulk.tool0" })
  })
})

describe("CodeModeInstructions", () => {
  test("handles empty catalogs and the first arrival", () => {
    expect(CodeModeInstructions.render(summary([]))).toContain("No Code Mode tools are currently available")
    const text = CodeModeInstructions.update(summary([]), summary([entry("notes.echo")]))
    expect(text).toContain("This catalog supersedes the previous Code Mode tool catalog.")
    expect(text).toContain("- notes.echo")
    expect(text).toContain("native `describe`")
  })

  test("shows all additions and exact removed expressions without exposing signatures", () => {
    const stable = Array.from({ length: 100 }, (_, index) => entry(`stable.tool${index}`))
    const previous = summary([...stable, entry("context7.resolve-library-id")])
    const current = summary([...stable, entry("notes.echo"), entry("notes.list")])
    const text = CodeModeInstructions.update(previous, current)!
    expect(text).toContain("- notes.echo\n- notes.list")
    expect(text).toContain('tools.context7["resolve-library-id"]')
    expect(text).not.toContain("Promise")
    expect(text).not.toContain("search")
  })

  test("gives every new name even when the former update budget would be exceeded", () => {
    const bulk = Array.from({ length: 300 }, (_, index) => entry(`bulk.tool${index}`))
    const text = CodeModeInstructions.update(summary([entry("stable.echo")]), summary([entry("stable.echo"), ...bulk]))!
    const lines = text.split("\n")
    for (const tool of bulk) expect(lines).toContain(`- ${tool.name}`)
    expect(text).not.toContain("search")
  })

  test("replaces an upstream partial or signature-based catalog before claiming completeness", () => {
    const current = summary([entry("notes.echo"), entry("notes.list")])
    const old = {
      ...current,
      namespaces: current.namespaces.map((namespace) => ({ ...namespace, entries: namespace.entries.slice(0, 1) })),
    }
    const text = CodeModeInstructions.update(old, current)!
    expect(text).toContain("supersedes the previous")
    expect(text).toContain("- notes.echo\n- notes.list")
    const oldFull = {
      ...current,
      namespaces: current.namespaces.map((namespace) => ({
        ...namespace,
        entries: namespace.entries.map((item) => ({ ...item, line: "old signature" })),
      })),
    }
    expect(CodeModeInstructions.update(oldFull, current)).toContain("supersedes the previous")
  })

  test("returns no update for reordered registrations or changed hidden details", () => {
    const a = entry("notes.a")
    const b = entry("notes.b")
    expect(
      CodeModeInstructions.update(summary([a, b]), summary([b, { ...a, description: "Changed", pinned: true }])),
    ).toBeUndefined()
  })
})
