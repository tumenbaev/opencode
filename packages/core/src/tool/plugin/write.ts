/**
 * Model-facing file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { FileWrite } from "../../file-write.js"
import { Flag } from "../../flag.js"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "The path to the file to write",
  }),
  content: Schema.String.annotate({ description: "The content to write to the file" }),
})

export const Output = Schema.String
export type Output = typeof Output.Type

/** Deferred write UX integrations remain visible at the model-facing seam. */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after LSP runtime exists.

export const Plugin = {
  id: "opencode.tool.write",
  effect: Effect.fn("WriteTool.Plugin")(function* (ctx: Context) {
    const fileWrite = yield* FileWrite.Service
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const flags = yield* Flag.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: flags.resolve(loaded.entries).full_codemode.enabled
            ? { codemode: true, pinned: true, permission: "edit" }
            : { codemode: false, permission: "edit" },
          description:
            "Write a file to the filesystem. Overwrites existing file. Read an existing file first before writing.",
          input: Input,
          output: Output,
          execute: (input, context) =>
            fileWrite.write(input, context).pipe(
              Effect.map((written) => ({
                output: `${written.existed ? "Wrote" : "Created"} file successfully: ${written.resource}`,
              })),
              Effect.mapError((error) => new ToolFailure({ message: `Unable to write ${input.path}`, error })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
