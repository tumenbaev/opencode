export * as CodeModeCatalog from "./catalog.js"

import { Schema } from "effect"

export type Tool = {
  readonly type: "tool"
  readonly name: string
  readonly description: string
  readonly signature: string
  readonly pinned?: boolean
}

export type Namespace = {
  readonly type: "namespace"
  readonly name: string
  readonly description?: string
  readonly tools: ReadonlyArray<Tool | Namespace>
}

export type Inventory = { readonly tools: ReadonlyArray<Tool | Namespace> }

const Listing = Schema.Struct({ path: Schema.String, line: Schema.String })
export type Listing = typeof Listing.Type

const NamespaceSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  tools: Schema.Array(Schema.String),
  entries: Schema.Array(Listing),
})
export type NamespaceSummary = typeof NamespaceSummary.Type

export const Summary = Schema.Struct({ total: Schema.Number, namespaces: Schema.Array(NamespaceSummary) })
export type Summary = typeof Summary.Type

// Kept for callers of the upstream API; names are always complete regardless of budget.
export type Options = { readonly budget?: number }

export function summarize(inventory: Inventory, _options: Options = {}): Summary {
  const flattened = flatten(inventory.tools)
  const namespaces = [...Map.groupBy(flattened.tools, (path) => path.split(".", 1)[0] ?? path)]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, paths]) => {
      const tools = paths.toSorted()
      return { name, tools, entries: tools.map((path) => ({ path, line: `- ${path}` })) }
    })
  return { total: flattened.tools.length, namespaces }
}

/** Looks up a canonical name without rendering the tool's signature. */
export function lookup(inventory: Inventory) {
  const tools = new Set(flatten(inventory.tools).tools)
  return (path: string) => (tools.has(path) ? { path, line: `- ${path}` } : undefined)
}

function flatten(entries: ReadonlyArray<Tool | Namespace>, path: ReadonlyArray<string> = []) {
  const tools: string[] = []
  for (const entry of entries) {
    const next = [...path, entry.name]
    if (entry.type === "tool") tools.push(next.join("."))
    else tools.push(...flatten(entry.tools, next).tools)
  }
  return { tools }
}

export function namespaceLine(namespace: NamespaceSummary, shown = namespace.entries.length) {
  const count = namespace.tools.length === 1 ? "1 tool" : `${namespace.tools.length} tools`
  const label =
    shown === namespace.tools.length ? count : shown === 0 ? `${count}, none shown` : `${count}, ${shown} shown`
  return `- ${namespace.name} (${label})${namespace.description === undefined ? "" : ` // ${namespace.description}`}`
}

export function cost(text: string) {
  return Math.round(text.length / 4)
}
