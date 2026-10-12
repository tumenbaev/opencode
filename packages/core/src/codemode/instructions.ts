export * as CodeModeInstructions from "./instructions.js"

import { toolExpression } from "@opencode/codemode"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import { CodeModeCatalog } from "./catalog.js"

// prettier-ignore
const prompt = `# Code Mode

The tools listed below cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

To obtain a tool’s full description and callable signature, call the native \`describe\` tool.

The catalog is complete. Do not guess tool names.

## Code Mode tools (call only inside \`execute\`)`

export function render(catalog: CodeModeCatalog.Summary) {
  if (catalog.total === 0)
    return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool."

  const tools = catalog.namespaces.flatMap((namespace) => namespace.entries.map((entry) => entry.path)).sort()
  return `${prompt}\n\n${tools.map((path) => `- ${path}`).join("\n")}`
}

export function update(
  previous: CodeModeCatalog.Summary,
  current: CodeModeCatalog.Summary,
  _lookup?: (path: string) => CodeModeCatalog.Listing | undefined,
) {
  const replacement = `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n${render(current)}`
  // A previous upstream catalog may have omitted names; replace it before claiming completeness.
  if (
    current.total === 0 ||
    previous.total === 0 ||
    previous.namespaces.some(
      (namespace) =>
        namespace.entries.length !== namespace.tools.length ||
        namespace.entries.some((entry) => entry.line !== `- ${entry.path}`),
    )
  )
    return replacement

  const before = new Set(previous.namespaces.flatMap((namespace) => namespace.tools))
  const after = new Set(current.namespaces.flatMap((namespace) => namespace.tools))
  const added = [...after].filter((path) => !before.has(path)).sort()
  const removed = [...before].filter((path) => !after.has(path)).sort()
  const parts = ["The Code Mode tool catalog has changed."]
  if (added.length > 0)
    parts.push(
      ["New tools are available in addition to those previously listed:", ...added.map((path) => `- ${path}`)].join("\n"),
    )
  if (removed.length > 0)
    parts.push(
      `The following tools are no longer available and must not be called: ${removed.map(toolExpression).join(", ")}.`,
    )
  if (parts.length === 1) return undefined
  const delta = parts.join("\n\n")
  return delta.length < replacement.length ? delta : replacement
}

const key = Instructions.Key.make("core/codemode")
const codec = Schema.toCodecJson(CodeModeCatalog.Summary)

export const make = (inventory?: CodeModeCatalog.Inventory): Instructions.List => {
  const catalog = inventory === undefined ? Instructions.removed : CodeModeCatalog.summarize(inventory)
  return Instructions.make({
    key,
    codec,
    read: Effect.succeed(catalog),
    render: {
      initial: render,
      changed: (previous, current) => update(previous, current),
      removed: () => "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.",
    },
  })
}
