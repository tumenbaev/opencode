export * as CommandPlugin from "./command.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import { extension } from "mime-types"
import { Bus } from "../bus.js"
import { Location } from "../location.js"
import { Mcp } from "../mcp/index.js"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: "opencode.command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const mcp = yield* Mcp.Service
    const bus = yield* Bus.Service
    const loaded = { prompts: [] as Mcp.Prompt[] }
    yield* bus.subscribe(Mcp.PromptsChanged).pipe(
      Stream.runForEach(() =>
        mcp.prompts().pipe(
          Effect.tap((prompts) => Effect.sync(() => (loaded.prompts = prompts))),
          Effect.andThen(ctx.command.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.prompts = yield* mcp.prompts()
    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "init",
        description: "guided AGENTS.md setup",
        execute: (input) =>
          ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: append(PROMPT_INITIALIZE.replace("${path}", location.project.directory), input.prompt.text),
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
      editor.add({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        execute: (input) =>
          ctx.session
            .prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: append(PROMPT_REVIEW.replace("${path}", location.project.directory), input.prompt.text),
              delivery: input.delivery,
            })
            .pipe(Effect.asVoid),
      })
      for (const prompt of loaded.prompts) {
        editor.add({
          name: mcpCommandName(prompt.server, prompt.name),
          description: prompt.description,
          execute: (input) =>
            Effect.gen(function* () {
              const args = parseArguments(input.prompt.text)
              const result = yield* mcp.prompt({
                server: prompt.server,
                name: prompt.name,
                args: Object.fromEntries(
                  (prompt.arguments ?? []).map((argument, index, declared) => [
                    argument.name,
                    index === declared.length - 1 ? args.slice(index).join(" ") : (args[index] ?? ""),
                  ]),
                ),
              })
              if (!result) return yield* Effect.fail(new Error(`MCP prompt not found: ${prompt.server}:${prompt.name}`))
              const images = result.messages.flatMap(({ content }) => (content.type === "image" ? [content] : []))
              yield* ctx.session.prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: result.messages
                  .map((message) => promptMessageText(message.content))
                  .join("\n")
                  .trim(),
                files: images.length
                  ? [
                      ...(input.prompt.files ?? []),
                      ...images.map((image, index) => ({
                        uri: `data:${image.mimeType};base64,${image.data}`,
                        name: `mcp-image-${index + 1}.${extension(image.mimeType) || "bin"}`,
                      })),
                    ]
                  : input.prompt.files,
                delivery: input.delivery,
              })
            }).pipe(Effect.asVoid),
        })
      }
    })
  }),
})

function append(template: string, input: string) {
  const value = input.trim()
  if (template.includes("$ARGUMENTS")) return template.replaceAll("$ARGUMENTS", () => value)
  return [template, value].filter(Boolean).join("\n\n")
}

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((argument) => argument.replace(quoteTrimRegex, ""))
}

function promptMessageText(content: unknown) {
  if (typeof content === "string") return content
  if (!content || typeof content !== "object") return ""
  if (!("type" in content) || content.type !== "text") return ""
  if (!("text" in content) || typeof content.text !== "string") return ""
  return content.text
}

function mcpCommandName(server: string, prompt: string) {
  return `${sanitize(server)}:${sanitize(prompt)}`
}

function sanitize(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const quoteTrimRegex = /^["']|["']$/g
