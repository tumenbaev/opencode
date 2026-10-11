export * as GrepTool from "./grep.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { RelativePath } from "../../schema.js"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "The regex pattern or literal text to search for in file contents",
    }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "The file or directory to search in. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum number of matching lines to return (default: ${FileSystem.DEFAULT_SEARCH_LIMIT})`,
  }),
})

export const Output = Schema.Array(FileSystem.Match)
type EncodedOutput = typeof Output.Encoded

/** Format raw search matches into concise model content. */
export const toModelContent = (matches: EncodedOutput, truncated = false) => {
  const lines = matches.length === 0 ? ["No matches found"] : [`Found ${matches.length} matches`]
  let current = ""
  for (const match of matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${matches.length} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description:
            "Content search that supports ripgrep regular-expression syntax.\nReturns file paths and line numbers with matches.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
              const target = yield* access.resolve({ path: input.path ?? "." })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  literal: input.literal,
                  caseSensitive: input.caseSensitive,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const root = target.absolute
              const type = yield* Environment.typeFollowing(environment.files, root).pipe(
                Effect.catchTag("Environment.NotFound", () =>
                  Effect.fail(new ToolFailure({ message: `Search path does not exist: ${input.path ?? "."}` })),
                ),
              )
              const cwd = type === "directory" ? root : path.dirname(root)
              const limit = input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT
              const matches = yield* ripgrep
                .grep({
                  cwd,
                  pattern: input.pattern,
                  file: type === "file" ? path.basename(root) : undefined,
                  include: input.include,
                  literal: input.literal,
                  caseSensitive: input.caseSensitive,
                  limit: limit + 1,
                })
                .pipe(
                  Effect.timeoutOrElse({
                    duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new ToolFailure({
                          message: `Search timed out after ${FileSystem.DEFAULT_SEARCH_TIMEOUT_MS / 1_000} seconds. Consider using a more specific path or pattern.`,
                        }),
                      ),
                  }),
                  Effect.map((result) =>
                    result.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(location.directory, path.resolve(cwd, match.entry.path)),
                          ),
                        }),
                      }),
                    ),
                  ),
                )
              return { matches: matches.slice(0, limit), truncated: matches.length > limit }
            }).pipe(
              Effect.map((result) => ({
                output: result.matches,
                content: toModelContent(
                  result.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                  })),
                  result.truncated,
                ),
                metadata: { matches: result.matches.length, truncated: result.truncated },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof Ripgrep.InvalidPatternError
                    ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                    : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
