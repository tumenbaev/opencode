import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { AIError, InvalidRequestError, LanguageModel, LLMEvent } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import path from "path"
import { Money } from "@opencode/schema/money"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { JobTable } from "@opencode/core/job/sql"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SubagentReport } from "@opencode/core/session/execution/subagent-report"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SubagentJob } from "@opencode/core/session/subagent-job"
import { SubagentCompletion } from "@opencode/core/session/subagent-completion"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Permission } from "@opencode/core/permission"
import { SubagentTool } from "@opencode/core/tool/plugin/subagent"
import { Tool } from "@opencode/core/tool"
import { tmpdirScoped } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const childText = "child final response"
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const overrideModel = Model.Ref.make({
  id: Model.ID.make("override"),
  providerID: Provider.ID.make("test"),
  variant: Model.VariantID.make("fast"),
})
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      // One completed answer per admitted prompt batch: a continuation adds a user prompt, so it
      // must produce a fresh answer instead of reusing the first turn's.
      const completedInbox = new Map<Session.ID, number>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        const admitted = (yield* SessionInbox.list(db, sessionID)).filter((item) => item.type === "user").length
        if (completedInbox.get(sessionID) === admitted) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completedInbox.set(sessionID, admitted)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
        if ((yield* store.get(sessionID))?.title?.includes("budget"))
          yield* bus.publish(SessionEvent.ContextBudgetReached, { sessionID })
      })
      return SessionExecution.Service.of({
        maintenance: (_id, effect) => effect.pipe(Effect.map(Option.some)),
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, Database.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  name: "test/subagent-plugins",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* registerToolPlugin(
        SubagentTool.Plugin,
        { session: { hook: (name, callback, options) => hooks.register("session", name, callback, options) } },
        (name, callback) => hooks.register("tool", name, callback),
      )
    }),
  ),
  deps: [
    Agent.node,
    Config.node,
    Model.node,
    Permission.node,
    Session.node,
    Job.node,
    SubagentJob.node,
    Tool.node,
    PluginHooks.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  SessionStore.node,
])
const replacements = [
  SessionExecution.node.replace(executionNode),
  Global.node.replace(tempGlobalLayer),
  offlineModels,
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(
  AppNodeBuilder.build(nodes, [...replacements, PluginSupervisor.node.replace(subagentPluginSupervisor)]),
)
const completionLLM = TestLLM.testLayer({ fallback: TestLLM.text(childText, "completion") })
const completionIt = testEffect(
  Layer.merge(
    completionLLM,
    AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      PluginSupervisor.node.replace(subagentPluginSupervisor),
      LayerNodePlatform.llmClient.replace(completionLLM),
      SessionRunnerModel.node.replace(
        Layer.succeed(SessionRunnerModel.Service, {
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(
                LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
                {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 200_000, output: 32_000 },
                },
              ),
            ),
        }),
      ),
    ]),
  ),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Plugin.Service.use((plugins) => plugins.awaitActivation).pipe(Effect.provide(locations.get(location)))
    yield* Provider.Service.use((providers) =>
      providers.transform((editor) => {
        editor.models.update(overrideModel.providerID, overrideModel.id, (model) => {
          model.variants = [{ id: Model.VariantID.make("fast") }]
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("plain"), () => {})
        editor.models.update(Provider.ID.make("test"), Model.ID.make("painter"), (model) => {
          model.type = "image"
        })
        editor.models.update(Provider.ID.make("test"), Model.ID.make("classifier"), (model) => {
          model.type = "decision"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((editor) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        editor.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        editor.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        editor.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        editor.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

describe("SubagentTool", () => {
  it.live("keeps child completion guidance request-local even without the subagent tool", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
          })
          const child = yield* sessions.create({ parentID: parent.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const hooks = yield* PluginHooks.Service.pipe(Effect.provide(locations.get(parent.location)))
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const shared = { description: SubagentTool.description, input: { type: "object" as const } }
          expect(SubagentTool.description).toBe(
            "Use it to delegate discrete pieces of work. Always provide highly detailed task description with comprehensive context and out of scope items. Subagent starts with NO context: it knows only what you put in the prompt. Each call waits for the child's current turn to finish; launch independent calls in parallel.",
          )
          const event = (sessionID: Session.ID, tools: SessionHooks["context"]["tools"]): SessionHooks["context"] => ({
            sessionID,
            agent: toolIdentity.agent,
            model: parentModel,
            system: [],
            messages: [],
            tools,
            options: {},
          })
          const instruction =
            "Complete the assigned task before returning your final result. Run finite checks in the foreground, or wait for their results."
          for (const hook of ["context", "compaction", "generate"] as const) {
            const childEvent = event(child.id, { [SubagentTool.name]: { ...shared } })
            const childTool = childEvent.tools[SubagentTool.name]
            yield* hooks.trigger("session", hook, childEvent)
            expect(childEvent.tools[SubagentTool.name]).toBe(childTool)
            expect(childEvent.system.map((part) => part.text)).toEqual([instruction])
            expect(childEvent.tools[SubagentTool.name]?.description).toContain("Available subagents:")
            expect(childEvent.tools[SubagentTool.name]?.description).not.toMatch(/end your response|Keep working|poll/)
            const withoutTool = event(grandchild.id, {})
            yield* hooks.trigger("session", hook, withoutTool)
            expect(withoutTool.system.map((part) => part.text)).toEqual([instruction])
            const parentEvent = event(parent.id, { [SubagentTool.name]: { ...shared } })
            yield* hooks.trigger("session", hook, parentEvent)
            expect(parentEvent.system).toEqual([])
            expect(shared.description).toBe(SubagentTool.description)
          }
          expect(
            (yield* registry.snapshot()).definitions.find((tool) => tool.name === SubagentTool.name)?.description,
          ).toBe(SubagentTool.description)
        }),
      ),
    ),
  )

  it.live("guards exhausted reuse without blocking fresh children or already admitted work", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const bus = yield* Bus.Service
          const jobs = yield* Job.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const child = yield* sessions.create({
            parentID: parent.id,
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* sessions.prompt({ sessionID: child.id, text: "already admitted", resume: false })
          const inbox = yield* sessions.inbox(child.id)
          yield* bus.publish(SessionEvent.ContextBudgetReached, { sessionID: child.id })
          const progress: Tool.Metadata[] = []
          const call = (sessionID?: Session.ID) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              progress: (update) => Effect.sync(() => progress.push(update)),
              call: {
                type: "tool-call" as const,
                id: "call-budget",
                name: SubagentTool.name,
                input: {
                  agent: "reviewer",
                  description: "budget review",
                  prompt: "review",
                  ...(sessionID === undefined ? {} : { sessionID }),
                },
              },
            })
          expect(yield* call(child.id)).toEqual({
            status: "error",
            error: { type: "tool.execution", message: SubagentCompletion.CONTEXT_BUDGET_NOTICE },
          })
          expect(progress).toEqual([])
          expect(yield* sessions.inbox(child.id)).toEqual(inbox)
          expect(yield* sessions.get(child.id)).toMatchObject({ agent: "fallback", model: parentModel })
          expect(yield* jobs.get(child.id)).toBeUndefined()
          // The latch does not cut off direct prompts or work admitted before it was set.
          yield* sessions.prompt({ sessionID: child.id, text: "direct user prompt", resume: false })
          yield* SessionExecution.Service.use((execution) => execution.resume(child.id))
          expect(
            SubagentCompletion.text(
              (yield* sessions.context(child.id)).findLast((message) => message.type === "assistant"),
            ),
          ).toBe(childText)

          const fresh = yield* call()
          const freshID = outputSessionID(fresh.metadata)
          expect(freshID).not.toBe(child.id)
          expect(fresh).toMatchObject({ status: "completed", output: { status: "completed" } })

          const store = yield* SessionStore.Service
          const delivered: string[] = []
          const report = SubagentReport.make({
            store,
            jobs,
            inbox: {
              admit: (request) =>
                Effect.sync(() => {
                  if (request.item.type === "synthetic") delivered.push(request.item.payload.text)
                }),
            },
            draining: Effect.succeed(new Set()),
            wake: () => Effect.void,
          })
          report.started(child.id, { startedSeq: 0 })
          const settlement = yield* report.prepare(child.id, { type: "succeeded" })
          yield* settlement.commit()
          const marker = (yield* jobs.pendingBackground).find((item) => item.id === child.id)
          expect(marker?.output).toBe(`${childText}\n\n${SubagentCompletion.CONTEXT_BUDGET_NOTICE}`)
          yield* settlement.deliver
          expect(delivered).toEqual([expect.stringContaining(marker?.output ?? "missing report")])
          if (!marker || marker.recovery.kind !== "subagent") return yield* Effect.die("Expected subagent report")
          const replayed: string[] = []
          yield* SubagentCompletion.deliver(
            { synthetic: (input) => Effect.sync(() => void replayed.push(input.text)) },
            { completeBackground: () => Effect.void },
            { ...marker, recovery: marker.recovery },
          )
          expect(replayed).toEqual(delivered)
        }),
      ),
    ),
  )

  completionIt.live("admits one durable completion across live delivery and restart replay", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
            model: parentModel,
            title: "Completion recipient",
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* Deferred.make<Job.Background>()
          const notifications: SessionMessage.ID[] = []
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID !== parent.id || event.data.item.type !== "synthetic") return
              notifications.push(event.data.inboxID)
              const marker = (yield* jobs.pendingBackground).find((job) => job.notificationID === event.data.inboxID)
              // The marker must survive until admission commits, not merely until delivery starts.
              expect(marker?.status).toBe("completed")
              if (marker) yield* Deferred.succeed(admitted, marker)
            }),
          )

          const result = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-completion-replay",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review" },
            },
          })
          const marker = yield* Deferred.await(admitted)
          yield* jobs.pendingBackground.pipe(Effect.repeat({ until: (pending) => pending.length === 0 }))
          yield* sessions.wait(parent.id)
          const messages = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(messages).toEqual([
            expect.objectContaining({
              id: marker.notificationID,
              description: "background review",
              text: `<subagent sessionID="${outputSessionID(result.metadata)}" state="completed" description="background review">\n${childText}\n</subagent>`,
              metadata: {
                source: "subagent",
                childID: outputSessionID(result.metadata),
                agent: "reviewer",
                state: "completed",
              },
            }),
          ])

          // Reproduce a crash after admission but before acknowledgment using the real persisted row.
          const database = yield* Database.Service
          yield* database.db
            .insert(JobTable)
            .values({
              notification_id: marker.notificationID,
              id: marker.id,
              session_id: parent.id,
              child_session_id: outputSessionID(result.metadata),
              kind: marker.recovery.kind,
              title: "background review",
              status: marker.status,
              output: marker.output ?? null,
              error: marker.error ?? null,
              recovery: marker.recovery,
            })
            .run()
          const restart = yield* SessionRestart.Service
          yield* restart.resumeSuspendedSessions
          yield* sessions.wait(parent.id)
          expect(notifications).toEqual([marker.notificationID])
          expect((yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")).toEqual(
            messages,
          )
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  productionIt.live("registers globally while resolving agents from the caller location", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect((yield* registry.snapshot()).definitions.map((tool) => tool.name)).toContain(SubagentTool.name)
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
          })
        }),
      ),
    ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", prompt: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "opencode.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", prompt: "should run" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining("finished its current turn") }],
          })
          expect(settled.metadata).toEqual({
            sessionID: outputSessionID(settled.metadata),
            status: "completed",
          })
          const text = settled.output.output
          expect(text).toContain("Results arrive in <subagent> messages")
          expect(text).not.toMatch(/sleep|poll|ask the subagent for status|end your response|Work on non-overlapping/)
          expect((yield* sessions.get(outputSessionID(settled.metadata))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("starts a child session and acknowledges its finished turn", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this", model: "", sessionID: "" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining("finished its current turn") }],
          })
          const child = yield* sessions.get(outputSessionID(settled.metadata))
          expect(settled.output).toMatchObject({ sessionID: child.id, status: "completed" })
          expect(settled.output.output).toContain(`sessionID: ${child.id}`)
          expect(settled.output.output).toContain("Results arrive in <subagent> messages")
          expect(settled.output.output).toContain("Reports list any background work still running")
          expect(settled.output.output).not.toMatch(/end your response|Work on non-overlapping/)
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "completed" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "You are a subagent spawned by another session.\nreview this",
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", prompt: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", prompt: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          expect(first.output.status).toBe("completed")
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue this",
                sessionID: childID,
                model: "",
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
          expect(second).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: childID, status: "completed" },
          })
        }),
      ),
    ),
  )

  it.live("waits for a running child after steering it", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const child = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const prompted = yield* Deferred.make<void>()
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            event.data.sessionID === child.id && event.data.item.type === "user"
              ? Deferred.succeed(prompted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          )
          yield* jobs.start({ id: child.id, type: SubagentTool.name, run: Effect.never })

          const pending = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-running-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                prompt: "continue while running",
                sessionID: child.id,
              },
            },
          }).pipe(Effect.forkScoped({ startImmediately: true }))

          yield* Deferred.await(prompted)
          expect(pending.pollUnsafe()).toBeUndefined()
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "continue while running",
          )
          expect((yield* jobs.get(child.id))?.status).toBe("running")
          yield* jobs.cancel(child.id)
          expect(yield* Fiber.join(pending)).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: child.id, status: "completed" },
          })
        }),
      ),
    ),
  )

  completionIt.live("follow-ups join the running child and notify once", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const llm = yield* TestLLM.Test
          const gate = yield* llm.gate()
          const childStarted = yield* Deferred.make<Session.ID>()
          const steered = yield* Deferred.make<void>()
          let prompts = 0
          yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
            Effect.gen(function* () {
              if (event.data.sessionID === parent.id || event.data.item.type !== "user") return
              if (++prompts === 3) yield* Deferred.succeed(steered, undefined)
            }),
          )
          const delivered = yield* bus.subscribe(SessionEvent.InboxDelivered).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          const call = (id: string, input: { sessionID?: Session.ID }) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              progress: (update) => Deferred.succeed(childStarted, outputSessionID(update)).pipe(Effect.asVoid),
              call: {
                type: "tool-call",
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: id, ...input },
              },
            }).pipe(Effect.forkScoped({ startImmediately: true }))

          const launched = yield* call("call-launch", {})
          const childID = yield* Deferred.await(childStarted)
          yield* gate.started
          const steering = yield* call("call-steer", { sessionID: childID })
          const followed = yield* call("call-steer-again", { sessionID: childID })
          yield* Deferred.await(steered)
          for (const pending of [launched, steering, followed]) expect(pending.pollUnsafe()).toBeUndefined()

          yield* gate.release
          for (const pending of [launched, steering, followed])
            expect(yield* Fiber.join(pending)).toMatchObject({
              metadata: { sessionID: childID, status: "completed" },
            })
          yield* Fiber.join(delivered)
          yield* sessions.wait(parent.id)
          const notices = (yield* sessions.context(parent.id))
            .filter((message) => message.type === "synthetic")
            .filter((message) => message.metadata?.source === "subagent")
          expect(notices).toHaveLength(1)
          expect(notices[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )

  completionIt.live("cancels the child when the waiting tool receives a user stop", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      const gate = yield* llm.gate()
      const stopped = yield* Deferred.make<void>()
      const childStarted = yield* Deferred.make<Session.ID>()
      const locations = yield* LocationServiceMap.Service
      const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(fixture.parent.location)))
      const pending = yield* executeTool(registry, {
        sessionID: fixture.parent.id,
        ...toolIdentity,
        cancel: Deferred.await(stopped),
        progress: (update) => Deferred.succeed(childStarted, outputSessionID(update)).pipe(Effect.asVoid),
        call: {
          type: "tool-call",
          id: "call-user-stop",
          name: SubagentTool.name,
          input: { agent: "reviewer", description: "review", prompt: "review" },
        },
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      const childID = yield* Deferred.await(childStarted)
      yield* gate.started
      expect(pending.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(stopped, undefined)
      expect(yield* Fiber.join(pending)).toMatchObject({
        metadata: { sessionID: childID, status: "completed" },
      })
      yield* fixture.sessions.wait(childID)
      yield* gate.release
      yield* fixture.sessions.wait(fixture.parent.id)
      expect(yield* fixture.notices).toEqual([
        expect.objectContaining({ text: expect.stringContaining('state="cancelled"') }),
      ])
    }),
  )

  completionIt.live("interrupting the waiting tool leaves the child recoverable", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      const gate = yield* llm.gate()
      const childStarted = yield* Deferred.make<Session.ID>()
      const locations = yield* LocationServiceMap.Service
      const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(fixture.parent.location)))
      const pending = yield* executeTool(registry, {
        sessionID: fixture.parent.id,
        ...toolIdentity,
        cancel: Effect.never,
        progress: (update) => Deferred.succeed(childStarted, outputSessionID(update)).pipe(Effect.asVoid),
        call: {
          type: "tool-call",
          id: "call-interrupted-wait",
          name: SubagentTool.name,
          input: { agent: "reviewer", description: "review", prompt: "review" },
        },
      }).pipe(Effect.forkScoped({ startImmediately: true }))
      const childID = yield* Deferred.await(childStarted)
      yield* gate.started
      yield* Fiber.interrupt(pending)
      const jobs = yield* Job.Service
      expect(yield* jobs.isCancelled(childID)).toBe(false)
      expect((yield* jobs.get(childID))?.status).toBe("running")
      expect(yield* jobs.pendingBackground).toMatchObject([{ id: childID, status: "running" }])
      yield* gate.release
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)
      expect(yield* fixture.notices).toEqual([expect.objectContaining({ text: expect.stringContaining(childText) })])
    }),
  )

  it.live("rejects unrelated children and switches agents on continuation", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const switched = yield* sessions.create({
            parentID: parent.id,
            title: "fallback review",
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", prompt: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-malformed-child-id",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "follow up", prompt: "continue", sessionID: "placeholder" },
              },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: expect.stringContaining('sessionID: Expected a string starting with "ses"') },
          })
          expect(yield* call(parent.id, "call-parent-id")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${parent.id} is not a child of the current session`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a child of the current session`,
            },
          })
          expect(yield* call(switched.id, "call-switched-child")).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "reviewer",
            model: childModel,
          })
          // Switching to an agent without a configured model keeps the child's current model.
          expect(yield* call(switched.id, "call-modelless-switch", "fallback")).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "fallback",
            model: childModel,
          })
        }),
      ),
    ),
  )

  // Fork subagents use the agent's model rather than per-call overrides.
  it.live.skip("runs the child on an explicitly requested model", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
              },
            })

          // The requested model beats the agent's configured model.
          const spawned = yield* call("call-override", { model: "test/override#fast", sessionID: "" })
          expect(spawned).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { status: "completed" },
          })
          const child = yield* sessions.get(outputSessionID(spawned.metadata))
          expect(child).toMatchObject({ agent: "reviewer", model: overrideModel })

          // Continuing with a model switches the existing child even when the agent is unchanged.
          const continued = yield* call("call-override-continue", { sessionID: child.id, model: "test/override" })
          expect(continued).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: child.id, status: "completed" },
          })
          expect((yield* sessions.get(child.id)).model).toEqual({
            id: overrideModel.id,
            providerID: overrideModel.providerID,
            variant: Model.VariantID.make("default"),
          })

          const failures = [
            ["not-a-ref", 'Invalid model "not-a-ref". Use "providerID/modelID" or "providerID/modelID#variant".'],
            ["test/missing", 'Model "test/missing" is not available. Use the models tool to see what is available.'],
            ["test/override#slow", 'Variant "slow" is not available for "test/override". Available: fast.'],
            ["test/plain#high", 'Model "test/plain" has no variants. Omit the variant.'],
            [
              "test/painter",
              'Model "test/painter" is an image model; subagents need a chat model. Use the models tool to find one.',
            ],
            [
              "test/classifier",
              'Model "test/classifier" is a decision model; subagents need a chat model. Use the models tool to find one.',
            ],
          ] as const
          for (const [model, message] of failures) {
            expect(yield* call(`call-${model}`, { model })).toEqual({
              status: "error",
              error: { type: "tool.execution", message },
            })
          }
        }),
      ),
    ),
  )

  it.live("omits model from the tool schema and ignores per-call model overrides", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
              },
            })

          const definition = (yield* registry.snapshot()).definitions.find((tool) => tool.name === SubagentTool.name)
          expect(definition?.inputSchema.properties).not.toHaveProperty("model")
          expect(definition?.inputSchema.properties).toHaveProperty("sessionID")

          const spawned = yield* call("call-override", { model: "test/override#fast", sessionID: "" })
          expect(spawned).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { status: "completed" },
          })
          const child = yield* sessions.get(outputSessionID(spawned.metadata))
          expect(child).toMatchObject({ agent: "reviewer", model: childModel })

          const continued = yield* call("call-override-continue", { sessionID: child.id, model: "test/override" })
          expect(continued).toMatchObject({
            status: "completed",
            output: { status: "completed" },
            metadata: { sessionID: child.id, status: "completed" },
          })
          expect((yield* sessions.get(child.id)).model).toEqual(child.model)

          const fallback = yield* call("call-fallback-override", { agent: "fallback", model: "not-a-ref" })
          expect(fallback).toMatchObject({ status: "completed", output: { status: "completed" } })
          expect((yield* sessions.get(outputSessionID(fallback.metadata))).model).toEqual(
            (yield* sessions.get(parent.id)).model,
          )
        }),
      ),
    ),
  )

  completionIt.live("notifies once when background work completes", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const jobs = yield* Job.Service
          const bus = yield* Bus.Service
          const admitted = yield* bus.subscribe(SessionEvent.InboxEnqueued).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id && event.data.item.type === "synthetic"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )
          const delivered = yield* bus.subscribe(SessionEvent.InboxDelivered).pipe(
            Stream.filter((event) => event.data.sessionID === parent.id),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          )

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-background-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "background review", prompt: "review" },
            },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled.metadata).toMatchObject({
            status: "completed",
          })
          expect(settled.metadata).toEqual({ sessionID: childID, status: "completed" })
          expect(settled.content).toEqual([{ type: "text", text: expect.stringContaining(`sessionID: ${childID}`) }])

          const admission = Array.from(yield* Fiber.join(admitted))[0]
          expect(admission?.data.item.type).toBe("synthetic")
          if (admission?.data.item.type !== "synthetic") return yield* Effect.die("Expected synthetic inbox item")
          expect(admission?.data.item.payload.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(admission?.data.item.payload).toMatchObject({
            description: "background review",
            metadata: {
              source: "subagent",
              childID,
              agent: "reviewer",
              state: "completed",
            },
          })
          yield* Fiber.join(delivered).pipe(Effect.timeout("2 seconds"))
          yield* sessions.wait(parent.id)
          const synthetic = (yield* sessions.context(parent.id)).filter((message) => message.type === "synthetic")
          expect(synthetic).toHaveLength(1)
          expect(synthetic[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
          expect(synthetic[0]?.text).toContain(childText)
          expect(yield* jobs.pendingBackground).toEqual([])
        }),
      ),
    ),
  )
})

/** A parent with the subagent tool registered, its child calls, and every synthetic notice it received. */
const reportingFixture = () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const sessions = yield* Session.Service
    const parent = yield* sessions.create({ location, model: parentModel })
    yield* withSubagent(parent.location)
    const locations = yield* LocationServiceMap.Service
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
    const call = (id: string, input: Record<string, unknown> = {}) =>
      executeTool(registry, {
        sessionID: parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call" as const,
          id,
          name: SubagentTool.name,
          input: { agent: "reviewer", description: "review", prompt: "review this", ...input },
        },
      })
    // A notice is either still queued or already delivered to the parent; count both.
    const notices = Effect.gen(function* () {
      const pending = (yield* sessions.inbox(parent.id)).flatMap((item) =>
        item.type === "synthetic" ? [{ text: item.payload.text, metadata: item.payload.metadata }] : [],
      )
      const delivered = (yield* sessions.context(parent.id)).flatMap((message) =>
        message.type === "synthetic" ? [{ text: message.text, metadata: message.metadata }] : [],
      )
      return [...pending, ...delivered]
    })
    return { parent, sessions, call, notices }
  })

describe("SubagentTool reporting", () => {
  completionIt.live("reports the child's final answer to the parent", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const settled = yield* fixture.call("call-report")
      const childID = outputSessionID(settled.metadata)

      expect(settled).toMatchObject({
        status: "completed",
        output: { status: "completed" },
        metadata: { sessionID: childID, status: "completed" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(1)
      expect(reports[0]?.text).toContain(`<subagent sessionID="${childID}" state="completed"`)
      expect(reports[0]?.text).toContain(childText)
    }),
  )

  completionIt.live("reports only the current busy period when an idle child is continued", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      yield* llm.push(TestLLM.text("first answer", "first"))

      const first = yield* fixture.call("call-first")
      const childID = outputSessionID(first.metadata)
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)
      const firstReports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(firstReports).toHaveLength(1)
      expect(firstReports[0]?.text).toContain("first answer")

      const second = yield* fixture.call("call-second", { sessionID: childID })
      expect(second).toMatchObject({
        status: "completed",
        output: { status: "completed" },
        metadata: { sessionID: childID, status: "completed" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(2)
      expect(reports[1]?.text).toContain(childText)
      expect(reports[1]?.text).not.toContain("first answer")
    }),
  )

  completionIt.live("reports a child runner failure to the parent", () =>
    Effect.gen(function* () {
      const fixture = yield* reportingFixture()
      const llm = yield* TestLLM.Test
      yield* llm.push(
        TestLLM.failAfter(
          new AIError({ reason: new InvalidRequestError({ message: "provider exploded" }) }),
          LLMEvent.textStart({ id: "failed" }),
        ),
      )

      const settled = yield* fixture.call("call-failing-child", { description: "fail review" })
      const childID = outputSessionID(settled.metadata)
      expect(settled).toMatchObject({
        status: "completed",
        output: { status: "completed" },
        metadata: { sessionID: childID, status: "completed" },
      })
      yield* fixture.sessions.wait(childID)
      yield* fixture.sessions.wait(fixture.parent.id)

      const reports = (yield* fixture.notices).filter((notice) => notice.metadata?.["source"] === "subagent")
      expect(reports).toHaveLength(1)
      expect(reports[0]?.text).toContain(`<subagent sessionID="${childID}" state="error"`)
      expect(reports[0]?.text).toContain("provider exploded")
    }),
  )
})

describe("SubagentJob cancellation", () => {
  it.live("interrupts the child only for an explicit cancel and preserves shutdown claims", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const scope = yield* Scope.make()
      const cancelStarted = yield* Deferred.make<void>()
      const shutdownStarted = yield* Deferred.make<void>()
      const cancelChild = Session.ID.make("ses_job_cancel_child")
      const shutdownChild = Session.ID.make("ses_job_shutdown_child")
      const interrupts: Session.ID[] = []
      const interrupted = new Set<Session.ID>()
      const claimed = new Set<Session.ID>()
      const execution = SessionExecution.Service.of({
        active: Effect.succeed(new Set<Session.ID>()),
        isActive: () => Effect.succeed(false),
        maintenance: (_id, effect) => effect.pipe(Effect.map(Option.some)),
        resume: (sessionID) =>
          Effect.sync(() => claimed.add(sessionID)).pipe(
            Effect.andThen(
              sessionID === cancelChild
                ? Deferred.succeed(cancelStarted, undefined)
                : Deferred.succeed(shutdownStarted, undefined),
            ),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.add(sessionID))),
          ),
        wake: () => Effect.void,
        interrupt: (sessionID) =>
          Effect.sync(() => {
            interrupts.push(sessionID)
            claimed.delete(sessionID)
            return true
          }),
        awaitIdle: () => Effect.void,
      })
      const jobs = yield* Job.make.pipe(Scope.provide(scope), Effect.provideService(Database.Service, database))
      const context = yield* Layer.buildWithScope(
        SubagentJob.layer.pipe(
          Layer.provide(Layer.succeed(SessionExecution.Service, execution)),
          Layer.provide(Layer.succeed(Job.Service, jobs)),
        ),
        scope,
      )
      const subagents = Context.get(context, SubagentJob.Service)
      const recovery = (parent: string, child: Session.ID) => ({
        kind: "subagent" as const,
        parentSessionID: Session.ID.make(parent),
        childSessionID: child,
        agent: "reviewer",
        description: "review",
      })

      yield* subagents.start(recovery("ses_job_cancel_parent", cancelChild))
      yield* Deferred.await(cancelStarted)
      yield* jobs.cancel(cancelChild)
      expect(interrupted.has(cancelChild)).toBe(true)
      expect(interrupts).toEqual([cancelChild])
      expect(claimed.has(cancelChild)).toBe(false)

      // A server shutdown interrupts the job fiber but must not release the child's claim.
      yield* subagents.start(recovery("ses_job_shutdown_parent", shutdownChild))
      yield* Deferred.await(shutdownStarted)
      yield* Scope.close(scope, Exit.void)
      expect(interrupted.has(shutdownChild)).toBe(true)
      expect(interrupts).toEqual([cancelChild])
      expect(claimed.has(shutdownChild)).toBe(true)
    }),
  )
})
