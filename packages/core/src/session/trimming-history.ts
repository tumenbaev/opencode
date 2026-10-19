export * as TrimmingHistory from "./trimming-history.js"

import type { SessionMessage } from "@opencode/schema/session-message"
import { Token } from "../util/token.js"
import { SessionRecentText } from "./recent-text.js"

/** Text only: no attachments, UI metadata, or opaque provider state reaches the reviewer. */
export type ReviewRecord =
  | { readonly type: "tool"; readonly name: string; readonly input: string; readonly output: string }
  | {
      readonly type:
        | "reasoning"
        | "synthetic"
        | "system"
        | "skill"
        | "shell"
        | "location-switched"
        | "model-switched"
        | "compaction"
      readonly text: string
    }

export type Target = { readonly messageID: SessionMessage.ID; readonly parts?: ReadonlyArray<number> }

export type Group = {
  readonly before: string
  readonly content: ReadonlyArray<ReviewRecord>
  readonly after: string
  readonly targets: ReadonlyArray<Target>
  readonly beforeTokens: number
}

const recordText = (record: ReviewRecord) =>
  record.type === "tool" ? `${record.name}\n${record.input}\n${record.output}` : record.text

const toolRecord = (part: SessionMessage.AssistantTool): ReviewRecord => {
  const state = part.state
  const content = state.status === "completed" || state.status === "error" ? state.content : undefined
  return {
    type: "tool",
    name: part.name,
    input: typeof state.input === "string" ? state.input : JSON.stringify(state.input),
    output: [
      ...(state.status === "error" ? [state.error.message] : []),
      ...(content?.flatMap((item) => (item.type === "text" ? [item.text] : [])) ?? []),
    ].join("\n"),
  }
}

const subagent = (part: SessionMessage.AssistantTool) =>
  part.name === "subagent" &&
  (part.state.status === "streaming" || part.state.input.background !== true) &&
  // Foreground work can be backgrounded while blocked. Its acknowledgement is not a result anchor.
  !(part.state.status === "completed" && part.state.metadata?.status === "running")

const partRecord = (part: SessionMessage.AssistantContent): ReviewRecord | undefined => {
  if (part.type === "tool") return subagent(part) ? undefined : toolRecord(part)
  if (part.type === "reasoning" && part.text.length > 0) return { type: "reasoning", text: part.text }
}

const standalone = (message: SessionMessage.Info): ReviewRecord | undefined => {
  if (message.contextReplacement !== undefined) return
  switch (message.type) {
    case "synthetic":
      if (message.metadata?.source === "subagent") return
      return { type: message.type, text: message.text }
    case "system":
    case "skill":
      return { type: message.type, text: message.text }
    case "shell":
      if (message.metadata?.background === true) return
      return { type: "shell", text: `Command:\n${message.command}\n\nOutput:\n${message.output?.output ?? ""}` }
    case "location-switched":
      return { type: message.type, text: `The working directory has been changed to ${message.location.directory}.` }
    case "model-switched":
      return {
        type: message.type,
        text: `Model selected: ${message.model.providerID}/${message.model.id}${message.model.variant ? `#${message.model.variant}` : ""}`,
      }
    case "compaction":
      if (message.status !== "completed" || message.native?.messages !== undefined) return
      return {
        type: "compaction",
        text: [message.summary, SessionRecentText.kept(message)].filter(Boolean).join("\n\n"),
      }
  }
}

type Entry = { readonly anchor: string } | { readonly record: ReviewRecord; readonly target: Target }

function* entries(messages: ReadonlyArray<SessionMessage.Info>): Iterable<Entry> {
  for (const message of messages) {
    // Never rediscover a retained original, even when it has subagent/shell metadata.
    if (message.contextReplacement !== undefined) {
      if (message.contextReplacement.length > 0) yield { anchor: message.contextReplacement }
      continue
    }
    if (message.type === "user") {
      yield { anchor: message.text }
      continue
    }
    if (message.type === "synthetic" && message.metadata?.source === "subagent") {
      yield { anchor: message.text }
      continue
    }
    if (message.type === "assistant") {
      for (const [index, part] of message.content.entries()) {
        if (part.type === "text" && part.text.length > 0) {
          yield { anchor: part.text }
          continue
        }
        if (part.type === "tool" && subagent(part)) {
          yield { anchor: recordText(toolRecord(part)) }
          continue
        }
        const record = partRecord(part)
        if (record) yield { record, target: { messageID: message.id, parts: [index] } }
      }
      continue
    }
    const record = standalone(message)
    if (record) yield { record, target: { messageID: message.id } }
    // Idle, agent selection and opaque/running compaction bookkeeping are transparent.
  }
}

/** Anchors delimit intervals; missing surrounding text at either end is simply empty. */
export const groups = (messages: ReadonlyArray<SessionMessage.Info>): ReadonlyArray<Group> => {
  const result: Group[] = []
  let before = ""
  let content: ReviewRecord[] = []
  let targets: Target[] = []
  let beforeTokens = 0
  for (const entry of entries(messages)) {
    if ("anchor" in entry) {
      if (beforeTokens >= 4_000) {
        result.push({ before, content, after: entry.anchor, targets, beforeTokens })
      }
      before = entry.anchor
      content = []
      targets = []
      beforeTokens = 0
      continue
    }
    content.push(entry.record)
    beforeTokens += Token.estimate(recordText(entry.record))
    const previous = targets.at(-1)
    if (previous?.messageID === entry.target.messageID && previous.parts && entry.target.parts) {
      targets[targets.length - 1] = { messageID: previous.messageID, parts: [...previous.parts, ...entry.target.parts] }
    } else targets.push(entry.target)
  }
  if (beforeTokens >= 4_000) result.push({ before, content, after: "", targets, beforeTokens })
  return result
}

/** Effective readable history, not stale provider usage. Attachments and opaque native windows are unmeasured. */
export const estimate = (messages: ReadonlyArray<SessionMessage.Info>): number => {
  let total = 0
  for (const entry of entries(messages))
    total += Token.estimate("anchor" in entry ? entry.anchor : recordText(entry.record))
  return total
}

const clearProviderState = (part: SessionMessage.AssistantContent): SessionMessage.AssistantContent => {
  const { native: _, ...rest } = part
  return rest
}

/** Pure atomic application of one event. Invalid/stale/anchor targets leave the entire group untouched. */
export const apply = (
  messages: ReadonlyArray<SessionMessage.Info>,
  targets: ReadonlyArray<Target>,
  note: string,
): ReadonlyArray<SessionMessage.Info> => {
  if (targets.length === 0) return messages
  const selected = new Map<SessionMessage.ID, Target>()
  let previous = -1
  for (const target of targets) {
    const index = messages.findIndex((message) => message.id === target.messageID)
    const message = messages[index]
    if (!message || index <= previous || message.contextReplacement !== undefined) return messages
    previous = index
    if (target.parts === undefined) {
      if (!standalone(message)) return messages
    } else {
      if (message.type !== "assistant" || target.parts.length === 0) return messages
      let last = -1
      for (const part of target.parts) {
        if (!Number.isInteger(part) || part <= last || !message.content[part] || !partRecord(message.content[part]))
          return messages
        last = part
      }
    }
    selected.set(message.id, target)
  }
  const first = targets[0]
  return messages.map((original) => {
    // Every existing measurement includes history from before this edit, not just the edited response's usage.
    const message =
      original.type === "assistant" && original.tokens && !original.contextInvalidated
        ? { ...original, contextInvalidated: true }
        : original
    const target = selected.get(message.id)
    if (!target) return message
    const replacement = target === first ? note : ""
    if (message.type !== "assistant") return { ...message, contextReplacement: replacement }
    const parts = new Set(target.parts)
    const content = message.content.flatMap((part, index): SessionMessage.AssistantContent[] => {
      if (!parts.has(index)) return [clearProviderState(part)]
      return index === target.parts?.[0] && replacement.length > 0 ? [{ type: "text", text: replacement }] : []
    })
    // A response-level continuation token and all part signatures describe the original response, not this edit.
    const { native: _, ...rest } = message
    return { ...rest, content }
  })
}
