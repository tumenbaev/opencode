import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: "",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const files =
            path.basename(info.location) === "SKILL.md"
              ? yield* ripgrep.find({
                  cwd: dir,
                  pattern: "!**/SKILL.md",
                  hidden: true,
                  follow: false,
                  signal: ctx.abort,
                  limit: 11,
                })
              : []

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              "<skill_content>",
              info.content.trim(),
              ...(files.length === 0
                ? []
                : [
                    "",
                    `Base directory for this skill: ${dir}`,
                    ...(files.length > 10 ? ["Note: file list is sampled."] : []),
                    "",
                    "<skill_files>",
                    files
                      .slice(0, 10)
                      .map((file) => `<file>${path.resolve(dir, file.path)}</file>`)
                      .join("\n"),
                    "</skill_files>",
                  ]),
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
