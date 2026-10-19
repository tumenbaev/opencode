import { beforeEach, describe, expect } from "bun:test"
import { AIError, LanguageModel, LLMClient, LLMEvent, ToolChoice, TransportError, type LLMRequest } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import type { StreamOptions } from "@opencode/ai/route"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { ModelResolver } from "@opencode/core/model-resolver"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionHistory } from "@opencode/core/session/history"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionTrimming } from "@opencode/core/session/trimming"
import { SessionStore } from "@opencode/core/session/store"
import { Agent } from "@opencode/schema/agent"
import { Config as ConfigSchema } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { Model } from "@opencode/schema/model"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionID } from "@opencode/schema/session-id"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"

const sessionID = SessionID.make("ses_manual_trim")
const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("reviewer") })
const resolved = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "reviewer", provider: "test", route: OpenAIChat.route }),
  {
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
    transport: "websocket",
  },
)
const time = { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) }
const messageID = (name: string) => SessionMessage.ID.make(`msg_${name}`)
const response = (content: SessionMessage.Assistant["content"]): SessionMessage.Assistant => ({
  id: messageID("response"),
  type: "assistant",
  agent: Agent.ID.make("build"),
  model,
  content,
  time,
})
const tool = (): SessionMessage.AssistantTool => ({
  type: "tool",
  id: "call_read",
  name: "read",
  time,
  state: { status: "completed", input: { path: "file" }, content: [{ type: "text", text: "x".repeat(16_000) }] },
})
const history = (): SessionMessage.Info[] => [
  { id: messageID("user"), type: "user", text: "Investigate", time: { created: time.created } },
  response([tool(), { type: "text", text: "Findings" }]),
]
const completed = (text = '{"action":"replace","note":"Read the implementation."}') =>
  Stream.make(
    LLMEvent.textDelta({ id: "review", text }),
    LLMEvent.stepFinish({ index: 0, reason: { normalized: "stop" }, usage: { inputTokens: 100, outputTokens: 10 } }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  )
let requests: LLMRequest[] = []
let selections: (Model.Ref | undefined)[] = []
let closes = 0
let available = true
let capacity = 200_000
let stream: (request: LLMRequest, options?: StreamOptions) => Stream.Stream<LLMEvent, AIError> = () => completed()
const configuration = Config.testLayer()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionTrimming.node,
      SessionProjector.node,
      SessionInbox.node,
      SessionStore.node,
      PluginHooks.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Config.node.replace(configuration),
      ModelResolver.node.replace(
        Layer.mock(ModelResolver.Service, {
          resolve: (ref) => {
            selections.push(ref)
            return Effect.succeed(
              available ? { ...resolved, limit: { ...resolved.limit, context: capacity } } : undefined,
            )
          },
        }),
      ),
      llmClient.replace(
        Layer.mock(LLMClient.Service, {
          stream: (request, options) => {
            requests.push(request)
            return stream(request, options)
          },
        }),
      ),
      SessionModelTransport.node.replace(
        Layer.mock(SessionModelTransport.Service, {
          bind: () => {
            throw new Error("trimming must not bind a stateful transport")
          },
          close: () =>
            Effect.sync(() => {
              closes++
            }),
        }),
      ),
    ],
  ).pipe(Layer.provideMerge(configuration)),
)

beforeEach(() => {
  requests = []
  selections = []
  closes = 0
  available = true
  capacity = 200_000
  stream = () => completed()
})

const seed = (messages = history()) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", slug: "trim", version: "test" })
      .run()
    const encode = Schema.encodeSync(SessionMessage.Info)
    yield* db
      .insert(SessionMessageTable)
      .values(
        messages.map((message, seq) => {
          const { id, type, ...data } = encode(message)
          return { id: SessionMessage.ID.make(id), type, data, seq, session_id: sessionID, time_created: 0 }
        }),
      )
      .run()
    yield* Bus.reserveSequence(db, sessionID, messages.length - 1)
  })
const load = Effect.gen(function* () {
  return yield* SessionHistory.load((yield* Database.Service).db, sessionID, "latest")
})
const run = SessionTrimming.Service.use((trimming) => trimming.run(sessionID))
const admit = Effect.gen(function* () {
  yield* (yield* SessionInbox.Service).admit({
    sessionID,
    id: messageID("new_input"),
    item: { type: "user", payload: { text: "New work" }, delivery: "steer" },
  })
})

describe("manual trimming reviewer", () => {
  it.effect(
    "reviews bounded local context with the default model and no tools, then changes no anchors or message IDs",
    () =>
      Effect.gen(function* () {
        yield* seed()
        const result = yield* run
        expect(result.status).toBe("completed")
        expect(result.groups).toBe(1)
        expect(result.afterTokens).toBeLessThan(result.beforeTokens)
        expect(selections).toEqual([SessionTrimming.defaultModel])
        expect(requests).toHaveLength(1)
        expect(requests[0]?.tools).toEqual([])
        expect(requests[0]?.toolChoice).toEqual(ToolChoice.make("none"))
        expect(requests[0]?.system).toHaveLength(1)
        expect(requests[0]?.messages).toHaveLength(1)
        const payload = requests[0]?.messages[0]?.content[0]
        if (payload?.type !== "text") throw new Error("expected text reviewer payload")
        expect(JSON.parse(payload.text)).toEqual({
          before: "Investigate",
          content: [{ type: "tool", name: "read", input: '{"path":"file"}', output: "x".repeat(16_000) }],
          after: "Findings",
        })
        expect(yield* load).toMatchObject([
          { id: messageID("user"), text: "Investigate" },
          {
            id: messageID("response"),
            content: [
              { type: "text", text: "Read the implementation." },
              { type: "text", text: "Findings" },
            ],
          },
        ])
        expect(closes).toBe(1)
        const db = (yield* Database.Service).db
        expect((yield* db.select().from(SessionTable).get())?.time_suspended).toBeNull()
      }),
  )

  it.effect("uses configured V2 model selection without changing compaction", () =>
    Effect.gen(function* () {
      yield* seed()
      const config = yield* Config.Test
      yield* config.setEntries([
        new ConfigSchema.Document({
          type: "document",
          info: new ConfigSchema.Info({
            trimming: { model: Schema.decodeUnknownSync(ConfigModel.Selection)("test/other#low") },
            compaction: { auto: true },
          }),
        }),
      ])
      yield* run
      expect(selections).toEqual([Model.Ref.parse("test/other#low")])
      expect(Config.latest(yield* config.entries(), "compaction")).toMatchObject({ auto: true })
    }),
  )

  it.effect("uses provider preparation and send-time HTTP hooks, never a stateful transport", () =>
    Effect.gen(function* () {
      yield* seed()
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      const wire: HttpClientRequest.HttpClientRequest[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          wire.push(request)
          return HttpClientResponse.fromWeb(request, new Response("{}"))
        }),
      )
      // Exercise the OAuth output-cap and send-time auth seams; provider implementations
      // have their own tests. The mock driver must use the prepared HTTP middleware.
      yield* hooks.register("session", "generate", (event) =>
        Effect.sync(() => {
          seen.push("generate")
          expect(event.options.maxTokens).toBe(32_000)
          delete event.options.maxTokens
        }),
      )
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          seen.push("model.request")
          expect(event.sessionID).toBe(sessionID)
          expect(event.agent).toBe(Agent.ID.make("trimming"))
          expect(event.kind).toBe("generate")
          event.baseURL = "https://reviewer.example.test/v1"
          event.headers["api-key"] = "placeholder"
        }),
      )
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push("http.request")
          event.request.headers.delete("api-key")
          event.request.headers.set("authorization", "Bearer fake-cli-token")
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push("http.response")
          event.response.headers.set("x-review-response", "hooked")
        }),
      )
      stream = (request, options) => {
        expect(request.generation?.maxTokens).toBeUndefined()
        expect(options?.webSocket).toBeUndefined()
        if (!options?.http) throw new Error("missing prepared HTTP middleware")
        return Stream.fromEffect(
          options
            .http(
              HttpClientRequest.post(`${request.model.route.endpoint.baseURL}/chat/completions`, {
                headers: request.http?.headers,
              }),
              http.execute,
            )
            .pipe(
              Effect.tap((response) => Effect.sync(() => expect(response.headers["x-review-response"]).toBe("hooked"))),
              Effect.orDie,
            ),
        ).pipe(Stream.flatMap(() => completed()))
      }
      expect((yield* run).status).toBe("completed")
      expect(seen).toEqual(["generate", "model.request", "http.request", "http.response"])
      expect(wire).toHaveLength(1)
      expect(wire[0]?.url).toBe("https://reviewer.example.test/v1/chat/completions")
      expect(wire[0]?.headers).toMatchObject({
        authorization: "Bearer fake-cli-token",
        "x-opencode-session-id": sessionID,
      })
      expect(wire[0]?.headers).not.toHaveProperty("api-key")
    }),
  )

  it.effect("retains groups on keep, malformed, fenced, empty, or nonshrinking decisions", () =>
    Effect.gen(function* () {
      yield* seed()
      for (const text of [
        '{"action":"keep"}',
        '{"action":"keep","note":"extra"}',
        "{}",
        "not json",
        '```json\n{"action":"replace","note":"short"}\n```',
        '{"action":"replace","note":""}',
        '{"action":"replace","note":" "}',
        JSON.stringify({ action: "replace", note: "y".repeat(20_000) }),
      ]) {
        stream = () => completed(text)
        expect((yield* run).status).toBe("unchanged")
        expect(yield* load).toEqual(history())
      }
      expect(closes).toBe(0)
    }),
  )

  it.effect("retains partial or provider-error reviews", () =>
    Effect.gen(function* () {
      yield* seed()
      stream = () => Stream.make(LLMEvent.textDelta({ id: "partial", text: '{"action":"replace","note":"partial"}' }))
      expect((yield* run).status).toBe("unchanged")
      stream = () =>
        Stream.fail(
          new AIError({ reason: new TransportError({ message: "failed", transport: "http", operation: "request" }) }),
        )
      expect((yield* run).status).toBe("unchanged")
      expect(yield* load).toEqual(history())
    }),
  )

  it.effect("skips unavailable reviewer models and oversized requests without fallback", () =>
    Effect.gen(function* () {
      yield* seed()
      available = false
      expect((yield* run).status).toBe("unchanged")
      available = true
      capacity = 35_000
      expect((yield* run).status).toBe("unchanged")
      expect(requests).toHaveLength(0)
      expect(yield* load).toEqual(history())
    }),
  )

  it.effect("does not review while inbox work is pending", () =>
    Effect.gen(function* () {
      yield* seed()
      yield* admit
      expect((yield* run).status).toBe("stale")
      expect(requests).toHaveLength(0)
      expect(selections).toHaveLength(0)
    }),
  )

  it.effect("new input admitted during review invalidates the snapshot even before promotion", () =>
    Effect.gen(function* () {
      yield* seed()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      stream = () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
          Stream.flatMap(() => completed()),
        )
      const fiber = yield* run.pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* admit
      yield* Deferred.succeed(release, undefined)
      expect((yield* Fiber.join(fiber)).status).toBe("stale")
      expect(yield* load).toEqual(history())
      expect(closes).toBe(0)
    }),
  )

  it.effect("times out each group and preserves user interruption", () =>
    Effect.gen(function* () {
      yield* seed()
      const started = yield* Deferred.make<void>()
      stream = () => Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      const timeout = yield* run.pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust("121 seconds")
      expect((yield* Fiber.join(timeout)).status).toBe("unchanged")
      const cancelled = yield* run.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(cancelled)
      const exit = yield* Fiber.await(cancelled)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* load).toEqual(history())
    }),
  )

  it.effect("applies several intervals in reverse order within one assistant message", () =>
    Effect.gen(function* () {
      const user = history()[0]
      if (!user) throw new Error("missing user fixture")
      yield* seed([
        user,
        response([tool(), { type: "text", text: "Commentary" }, tool(), { type: "text", text: "Answer" }]),
      ])
      const result = yield* run
      expect(result.status).toBe("completed")
      expect(result.groups).toBe(2)
      const messages = yield* load
      expect(messages[1]).toMatchObject({
        content: [
          { type: "text", text: "Read the implementation." },
          { type: "text", text: "Commentary" },
          { type: "text", text: "Read the implementation." },
          { type: "text", text: "Answer" },
        ],
      })
      expect(requests).toHaveLength(2)
    }),
  )

  it.effect(
    "invalidates old prompt measurements without changing billing usage, including unedited later responses",
    () =>
      Effect.gen(function* () {
        const old = history()
        const measured = {
          ...response([{ type: "text", text: "Later answer" }]),
          id: messageID("measured"),
          tokens: { input: 170_000, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        yield* seed([...old, measured])
        const session = yield* (yield* SessionStore.Service).get(sessionID)
        if (!session) throw new Error("session missing")
        const estimate = (messages: readonly SessionMessage.Info[]) =>
          SessionCompaction.estimatePrompt({
            session,
            messages,
            model: resolved,
            initial: "Initial instructions",
            agent: { id: Agent.ID.make("build"), info: Agent.Info.default(Agent.ID.make("build")) },
            tools: { definitions: [], execute: () => Effect.die("no tools during trimming") },
          })
        expect(estimate(yield* load).measured).toBe(170_010)
        expect((yield* run).status).toBe("completed")
        const messages = yield* load
        expect(messages.at(-1)).toMatchObject({ contextInvalidated: true, tokens: measured.tokens })
        expect(estimate(messages).measured).toBe(0)
        expect(estimate(messages).estimated).toBeLessThan(100)
        // A subsequent provider measurement is trusted again, without resetting historical usage.
        expect(
          estimate([...messages, { ...measured, id: messageID("fresh"), tokens: { ...measured.tokens, input: 25 } }])
            .measured,
        ).toBe(35)
      }),
  )

  it.effect("reviews a textual checkpoint without rewriting its stored summary or native state", () =>
    Effect.gen(function* () {
      yield* seed([
        {
          id: messageID("checkpoint"),
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "s".repeat(20_000),
          metadata: { recent: "Recent context" },
          time,
        },
      ])
      expect((yield* run).status).toBe("completed")
      expect(yield* load).toMatchObject([
        {
          type: "compaction",
          status: "completed",
          summary: "s".repeat(20_000),
          contextReplacement: "Read the implementation.",
        },
      ])
    }),
  )

  it.effect("maintenance returns busy without another review and never forces an answer", () =>
    Effect.gen(function* () {
      yield* seed()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      stream = () =>
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(
          Stream.flatMap(() => completed()),
        )
      let drains = 0
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.sync(() => {
            drains++
          }),
      })
      const first = yield* coordinator.maintenance(sessionID, run).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(Option.isNone(yield* coordinator.maintenance(sessionID, run))).toBe(true)
      yield* Deferred.succeed(release, undefined)
      expect(Option.isSome(yield* Fiber.join(first))).toBe(true)
      expect(drains).toBe(0)
      expect(requests).toHaveLength(1)
    }),
  )
})
