export * as SessionTrimming from "./session-trimming.js"

import { Schema } from "effect"
import { NonNegativeInt } from "./schema.js"

export const Result = Schema.Struct({
  status: Schema.Literals(["busy", "unchanged", "stale", "completed"]),
  beforeTokens: NonNegativeInt,
  afterTokens: NonNegativeInt,
  groups: NonNegativeInt,
}).annotate({
  identifier: "SessionTrimming.Result",
  description: "Outcome of manual context trimming. Busy results report zero tokens and groups.",
})
export interface Result extends Schema.Schema.Type<typeof Result> {}
