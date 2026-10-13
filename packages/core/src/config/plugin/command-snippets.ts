import type { SessionPrompt } from "@opencode/plugin/effect/session"
import { Effect } from "effect"

// All spans refer to the original submission, never to evaluated template text.
export const expandSnippets = Effect.fn("ConfigCommandPlugin.expandSnippets")(function* (
  prompt: SessionPrompt["prompt"],
  templates: ReadonlyMap<string, string>,
  evaluate: (template: string) => Effect.Effect<string, Error>,
) {
  const attachments = [...(prompt.files ?? []), ...(prompt.agents ?? []), ...(prompt.skills ?? [])]
  const spans: { start: number; end: number; text: string }[] = []
  const evaluated = new Map<string, string>()
  for (const match of prompt.text.matchAll(/\S+/g)) {
    const start = match.index
    const token = match[0]
    if (start === 0 || !token.startsWith("/")) continue
    const name = token.slice(1)
    const template = templates.get(name)
    if (template === undefined) continue
    const end = start + token.length
    if (attachments.some(({ mention }) => mention && start < mention.end && end > mention.start)) continue
    let text = evaluated.get(name)
    if (text === undefined) {
      text = yield* evaluate(template)
      evaluated.set(name, text)
    }
    spans.push({ start, end, text })
  }
  if (spans.length === 0) return

  // Commit only after every template succeeds; preserve all attachment data.
  let cursor = 0
  const chunks: string[] = []
  for (const span of spans) {
    chunks.push(prompt.text.slice(cursor, span.start), span.text)
    cursor = span.end
  }
  chunks.push(prompt.text.slice(cursor))
  prompt.text = chunks.join("")
  for (const { mention } of attachments) {
    if (!mention) continue
    const shift = spans.reduce(
      (total, span) => total + (span.end <= mention.start ? span.text.length - (span.end - span.start) : 0),
      0,
    )
    mention.start += shift
    mention.end += shift
  }
})
