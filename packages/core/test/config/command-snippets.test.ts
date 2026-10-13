import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { Agent } from "@opencode/core/agent"
import { Command } from "@opencode/core/command"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance/service"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Plugin } from "@opencode/core/plugin/service"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { CommandExecution } from "@opencode/core/session/command-execution"
import { StepFailedError } from "@opencode/core/session/error"
import { Skill } from "@opencode/core/skill"
import { Model } from "@opencode/schema/model"
import type { PromptInput } from "@opencode/schema/prompt-input"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, LocationServiceMap.node, Instance.node, FSUtil.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    Watcher.node.replace(Watcher.configured({ enabled: false })),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)
const model = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })

function project() {
  return Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, "opencode.json"),
        JSON.stringify({
          commands: {
            short: { template: "longer text" },
            args: { template: "[$ARGUMENTS][$1][$2]" },
            empty: { template: "" },
            nested: { template: "literal /short @missing.txt" },
            configured: { template: "only text", agent: "missing", model: "test/other", subagent: true },
            counted: { template: "!`printf x >> count; printf ready`" },
            direct: { template: "Direct /short $ARGUMENTS" },
            winner: { template: "JSON loser" },
          },
        }),
      ),
    )
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".opencode/commands/winner.md"), "Markdown winner"))
    yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".opencode/commands/nested/docs.md"), "Path snippet"))
    yield* Effect.promise(() =>
      Bun.write(
        path.join(tmp.path, ".opencode/skills/example/SKILL.md"),
        "---\nname: example\ndescription: Example\n---\nSkill body",
      ),
    )
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      location: { directory: AbsolutePath.make(tmp.path) },
      agent: Agent.ID.make("build"),
      model,
    })
    return { tmp, session, sessions }
  })
}

describe("config command snippets through prompt admission", () => {
  it.live("expands exact whitespace tokens once with empty arguments, config precedence, and no recursion or settings", () =>
    Effect.gen(function* () {
      const { session, sessions } = yield* project()
      const text =
        "/short try\t/short\n/args /empty /nested/docs /winner /nested /configured /unknown /short, (/short) x/short /short/child /init"
      const input = { sessionID: session.id, text, resume: false, delivery: "queue" as const }
      const admitted = yield* sessions.prompt(input)
      expect(admitted.payload.text).toBe(
        "/short try\tlonger text\n[][][]  Path snippet Markdown winner literal /short @missing.txt only text /unknown /short, (/short) x/short /short/child /init",
      )
      expect(admitted.payload.files).toBeUndefined()
      expect(admitted.payload.agents).toBeUndefined()
      expect(admitted.payload.skills).toBeUndefined()
      expect(admitted.delivery).toBe("queue")
      expect(input.text).toBe(text)
      expect(yield* sessions.get(session.id)).toMatchObject({ agent: "build", model })
      expect((yield* sessions.list({ parentID: session.id })).data).toEqual([])
    }),
  )

  it.live("allows a token after leading whitespace but leaves a token at position zero alone", () =>
    Effect.gen(function* () {
      const { session, sessions } = yield* project()
      expect((yield* sessions.prompt({ sessionID: session.id, text: " /short", resume: false })).payload.text).toBe(
        " longer text",
      )
      expect((yield* sessions.prompt({ sessionID: session.id, text: "/short", resume: false })).payload.text).toBe("/short")
    }),
  )

  it.live("evaluates shell interpolation once per distinct name per submission", () =>
    Effect.gen(function* () {
      const { tmp, session, sessions } = yield* project()
      const fs = yield* FSUtil.Service
      for (let submission = 1; submission <= 2; submission++) {
        const admitted = yield* sessions.prompt({ sessionID: session.id, text: "Use /counted /counted", resume: false })
        expect(admitted.payload.text).toBe("Use ready ready")
        expect(yield* fs.readFileString(path.join(tmp.path, "count"))).toBe("x".repeat(submission))
      }
    }),
  )

  it.live("reconciles resubmission with the same message ID before rerunning shell interpolation", () =>
    Effect.gen(function* () {
      const { tmp, session, sessions } = yield* project()
      const fs = yield* FSUtil.Service
      const input = {
        sessionID: session.id,
        id: SessionMessage.ID.create(),
        text: "Use /counted /counted",
        resume: false,
        delivery: "queue" as const,
      }
      const first = yield* sessions.prompt(input)
      expect(first.payload.text).toBe("Use ready ready")
      expect(yield* fs.readFileString(path.join(tmp.path, "count"))).toBe("x")
      const second = yield* sessions.prompt(input)
      expect(second).toEqual(first)
      expect(yield* fs.readFileString(path.join(tmp.path, "count"))).toBe("x")
      expect(yield* sessions.inbox(session.id)).toEqual([first])
    }),
  )

  it.live("preserves attachments, skips overlapping mentions, and remaps original offsets across multiple spans", () =>
    Effect.gen(function* () {
      const { session, sessions } = yield* project()
      const instances = yield* Instance.Service
      const skill = yield* Plugin.awaitActivation.pipe(
        Effect.andThen(Skill.Service),
        Effect.flatMap((skills) => skills.list()),
        instances.provide(session),
      )
      const example = skill.find((item) => item.name === "example")
      if (!example) return yield* Effect.die("Missing fixture skill")
      const text = "@before /short @file /empty @agent /short @skill /short /short /short"
      const mention = (value: string, start = text.indexOf(value)) => ({ start, end: start + value.length, text: value })
      const protectedStart = text.indexOf("/short", text.indexOf("@skill"))
      const input: PromptInput.Prompt = {
        text,
        files: [
          { uri: "data:text/plain,first", name: "first", mention: mention("@before") },
          { uri: "data:text/plain,content", name: "file", description: "kept", mention: mention("@file") },
          { uri: "data:text/plain,protected", mention: mention("/short", protectedStart) },
          { uri: "data:text/plain,unmentioned" },
        ],
        agents: [
          { name: "build", mention: mention("@agent") },
          // A partial overlap is protected too.
          { name: "build", mention: mention("short", protectedStart + 8) },
        ],
        skills: [{ id: example.id, mention: mention("@skill") }],
      }
      const admitted = yield* sessions.prompt({ sessionID: session.id, ...input, resume: false })
      const output = "@before longer text @file  @agent longer text @skill /short /short longer text"
      expect(admitted.payload.text).toBe(output)
      const mentions = [
        ...(admitted.payload.files ?? []),
        ...(admitted.payload.agents ?? []),
        ...(admitted.payload.skills ?? []),
      ].flatMap((item) => (item.mention ? [item.mention] : []))
      for (const item of mentions) expect(output.slice(item.start, item.end)).toBe(item.text)
      expect(admitted.payload.files).toHaveLength(4)
      expect(admitted.payload.files?.[0]?.mention).toEqual(mention("@before"))
      expect(admitted.payload.files?.[1]).toMatchObject({ name: "file", description: "kept", data: "Y29udGVudA==" })
      expect(admitted.payload.files?.[3]?.mention).toBeUndefined()
      expect(admitted.payload.agents?.map((item) => item.name)).toEqual(["build", "build"])
      expect(admitted.payload.skills?.[0]).toMatchObject({ id: example.id, name: "example" })
      expect(admitted.payload.skills?.[0]?.text).toContain("Skill body")
      expect(input.text).toBe(text)
      expect(input.files?.[2]?.mention).toEqual(mention("/short", protectedStart))
    }),
  )

  it.live("guards direct commands through the real session/host/prepare path without leaking to later submissions", () =>
    Effect.gen(function* () {
      const { session, sessions } = yield* project()
      const instances = yield* Instance.Service
      const guarded: boolean[] = []
      yield* Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "prompt", () =>
          Effect.gen(function* () {
            guarded.push(yield* CommandExecution)
          }),
        )
        // Even non-config command definitions must be protected.
        const commands = yield* Command.Service
        yield* commands.transform((editor) =>
          editor.add({
            name: "external",
            execute: (input) =>
              sessions.prompt({ sessionID: input.sessionID, text: "External /short", resume: false }).pipe(Effect.asVoid),
          }),
        )
      }).pipe(instances.provide(session))
      yield* sessions.command({ sessionID: session.id, command: "direct", text: "argument /short" })
      yield* sessions.command({ sessionID: session.id, command: "external", text: "" })
      expect((yield* sessions.inbox(session.id)).map((item) => (item.type === "user" ? item.payload.text : ""))).toEqual([
        "Direct /short argument /short",
        "External /short",
      ])
      const admitted = yield* sessions.prompt({ sessionID: session.id, text: "Normal /short", resume: false })
      expect(admitted.payload.text).toBe("Normal longer text")
      expect(guarded).toEqual([true, true, false])
      expect(yield* CommandExecution).toBe(false)
    }),
  )

  it.live("rejects failed preparation without admitting a message or mutating the request", () =>
    Effect.gen(function* () {
      const { tmp, session, sessions } = yield* project()
      const fs = yield* FSUtil.Service
      const instances = yield* Instance.Service
      yield* Plugin.awaitActivation.pipe(instances.provide(session))
      // A missing interpolation cwd produces a real process-spawn failure.
      yield* fs.remove(tmp.path, { recursive: true })
      const input = { sessionID: session.id, text: "Try /short /counted", resume: false }
      const exit = yield* sessions.prompt(input).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasFails(exit.cause)).toBe(true)
      expect(Cause.hasDies(exit.cause)).toBe(false)
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(StepFailedError)
      expect(error instanceof Error ? error.message : "").toContain("Shell interpolation failed")
      expect(yield* sessions.inbox(session.id)).toEqual([])
      expect(yield* sessions.context(session.id)).toEqual([])
      expect(input.text).toBe("Try /short /counted")
    }),
  )

  it.live("does not recover unrelated prompt-hook defects as typed preparation failures", () =>
    Effect.gen(function* () {
      const { session, sessions } = yield* project()
      const instances = yield* Instance.Service
      const defect = new Error("Unexpected hook bug")
      yield* Effect.gen(function* () {
        yield* Plugin.awaitActivation
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("session", "prompt", () => Effect.die(defect))
      }).pipe(instances.provide(session))
      const exit = yield* sessions.prompt({ sessionID: session.id, text: "Try /short", resume: false }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return
      expect(Cause.hasFails(exit.cause)).toBe(false)
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.squash(exit.cause)).toBe(defect)
      expect(yield* sessions.inbox(session.id)).toEqual([])
    }),
  )
})
