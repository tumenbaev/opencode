import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Permission } from "@opencode/core/permission"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { Config } from "@opencode/core/config"
import { ManagedPolicy } from "@opencode/core/managed-policy"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { Tool } from "@opencode/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@opencode/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"
import { registerIntegrationPolicy } from "./fixture/policy"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Skill.node, Permission.node],
})

const sessionID = Session.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  for (const count of [0, 1, 10, 11]) {
    it.live(`formats minimal content with ${count} companion files`, () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const directory = tmp.path
            const hidden = path.join(directory, ".resources")
            yield* Effect.promise(() => fs.mkdir(hidden))
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(path.join(directory, "SKILL.md"), "unused"),
                // Nested SKILL.md files and directories must not count as companions.
                fs.writeFile(path.join(hidden, "SKILL.md"), "unused"),
                ...Array.from({ length: count }, (_, index) =>
                  fs.writeFile(path.join(hidden, `.guide-${index}.md`), "reference"),
                ),
              ]),
            )
            const skill = Skill.Info.make({
              id: Skill.ID.make("minimal"),
              name: Skill.Name.make("Do not inject this name"),
              path: AbsolutePath.make(path.join(directory, "SKILL.md")),
              content: "  # Instructions\n\nUse the guidance.\n",
            })
            const fsUtil = yield* FSUtil.Service
            const expected =
              count === 0
                ? "<skill_content>\n# Instructions\n\nUse the guidance.\n</skill_content>"
                : `<skill_content>\n# Instructions\n\nUse the guidance.\n\nBase directory: ${directory}\n</skill_content>`
            expect(yield* Skill.prepare(fsUtil, skill)).toEqual({ directory, output: expected })
            expect(
              Skill.toModelOutput(
                skill,
                Array.from({ length: count }, (_, index) => path.join(hidden, `.guide-${index}.md`)),
              ),
            ).toBe(expected)
          }).pipe(Effect.provide(AppNodeBuilder.build(FSUtil.node))),
        ),
      ),
    )
  }

  it.effect("refuses a policy-blocked skill before authorization or content preparation", () =>
    Effect.gen(function* () {
      const skills = yield* Skill.Service
      const managed = yield* ManagedPolicy.Service
      const tools = yield* Tool.Service
      // This path does not exist; an attempted content scan would fail the test.
      yield* skills.transform((editor) =>
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make("private"),
            name: Skill.Name.make("Private"),
            path: AbsolutePath.make("/unavailable/private/SKILL.md"),
            content: "Private instructions",
          }),
        ),
      )
      yield* managed.set({ statements: [{ action: "integration.use", resource: "skill:private", effect: "deny" }] })
      yield* registerIntegrationPolicy({ skill: skills })
      expect(
        yield* executeTool(tools, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-policy-denied-skill", name: "skill", input: { id: "private" } },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Unable to load skill private" } })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode, Skill.node, Config.node, ManagedPolicy.node]), [
          Config.node.replace(Config.testLayer()),
          Permission.node.replace(permissionLayer({ assert: () => Effect.die("Blocked skill reached authorization") })),
          Image.node.replace(imagePassthrough),
        ]),
      ),
    ),
  )

  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            path: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const assertions: Permission.AssertInput[] = []
          let deny = false
          const permission = permissionLayer({
            assert: (input) =>
              Effect.sync(() => assertions.push(input)).pipe(
                Effect.andThen(
                  deny
                    ? Effect.fail(
                        new Permission.BlockedError({
                          rules: [],
                          permission: input.action,
                          resources: input.resources,
                        }),
                      )
                    : Effect.void,
                ),
              ),
          })
          const skills = Layer.mock(Skill.Service, {
            get: (id) => Effect.succeed(current.find((skill) => skill.id === id)),
            list: () => Effect.succeed(current),
          })
          const skillToolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode]), [
            Permission.node.replace(permission),
            Skill.node.replace(skills),
            Image.node.replace(imagePassthrough),
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: "",
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
            })
            expect(Skill.toModelOutput(info, [reference])).toBe(
              `<skill_content>\n# Effect\n\nGuidance\n\nBase directory: ${directory}\n</skill_content>`,
            )
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "completed",
              output: { name: "Effect", directory, output: Skill.toModelOutput(info, [reference]) },
              content: [{ type: "text", text: Skill.toModelOutput(info, [reference]) }],
              metadata: { name: "Effect", directory },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Unable to load skill missing" },
            })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "permission.rejected", message: "Permission denied: skill" },
            })
            deny = false
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
              description: "Public guidance",
              path: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.path, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: "<skill_content>\nPublic\n</skill_content>" }],
            })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
