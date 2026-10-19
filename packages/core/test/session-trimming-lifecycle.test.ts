import { expect } from "bun:test"
import path from "node:path"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Project } from "@opencode/schema/project"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionMessage } from "@opencode/schema/session-message"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventTable } from "@opencode/core/event/sql"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project as CoreProject } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionProjector } from "@opencode/core/session/projector"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { promptLocationNode } from "./fixture/prompt-location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const location = { directory: AbsolutePath.make("/project") }
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const note = "Historical note covering notifications and early reasoning"
const tailNote = "Historical note for later reasoning"
const reasoning = "private reasoning ".repeat(1_000)

const lifecycleLayer = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionInbox.node,
      Session.node,
    ]),
    [
      Database.node.replace(Database.configured({ path: ":memory:" })),
      Bus.node.replace(Bus.configured({ persist: true })),
      CoreProject.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  )

const it = testEffect(lifecycleLayer())

// Build settled history through the actual admission service and durable schema events.
const seed = Effect.gen(function* () {
  const sessions = yield* Session.Service
  const bus = yield* Bus.Service
  const { db } = yield* Database.Service
  const session = yield* sessions.create({ location, model, agent: Agent.ID.make("build") })
  const sessionID = session.id
  yield* sessions.prompt({ sessionID, text: "Initial request", resume: false })
  const first = yield* sessions.synthetic({
    sessionID,
    text: "Original notification one",
    description: "First completion",
    metadata: { source: "shell", job: "first" },
    resume: false,
  })
  const second = yield* sessions.synthetic({
    sessionID,
    text: "Original notification two",
    description: "Second completion",
    metadata: { source: "shell", job: "second" },
    resume: false,
  })
  yield* SessionInbox.promote(db, bus, sessionID, "steer")
  const assistantMessageID = SessionMessage.ID.create()
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model,
    started: 0,
  })
  yield* bus.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 0 })
  yield* bus.publish(SessionEvent.Reasoning.Ended, {
    sessionID,
    assistantMessageID,
    ordinal: 0,
    text: reasoning,
    native: { signature: "leading-proof" },
  })
  yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 1 })
  yield* bus.publish(SessionEvent.Text.Ended, {
    sessionID,
    assistantMessageID,
    ordinal: 1,
    text: "Protected answer",
    native: { signature: "answer-proof" },
  })
  yield* bus.publish(SessionEvent.Reasoning.Started, { sessionID, assistantMessageID, ordinal: 2 })
  yield* bus.publish(SessionEvent.Reasoning.Ended, {
    sessionID,
    assistantMessageID,
    ordinal: 2,
    text: reasoning,
  })
  yield* bus.publish(SessionEvent.Step.Ended, {
    sessionID,
    assistantMessageID,
    finish: "stop",
    native: { responseID: "original-response" },
    cost: Money.USD.make(1),
    tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 0, write: 0 } },
  })
  yield* sessions.prompt({ sessionID, text: "Next request", resume: false })
  yield* SessionInbox.promote(db, bus, sessionID, "steer")
  const original = yield* sessions.context(sessionID)
  expect(original.map((message) => message.type)).toEqual(["user", "synthetic", "synthetic", "assistant", "user"])
  return { sessionID, first, second, assistantMessageID, original }
})

type History = Effect.Success<typeof seed>

const trim = (history: History) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    // Reverse chronological edits keep the original assistant indices valid.
    yield* bus.publish(SessionEvent.ContextTrimmed, {
      sessionID: history.sessionID,
      targets: [{ messageID: history.assistantMessageID, parts: [2] }],
      note: tailNote,
    })
    yield* bus.publish(SessionEvent.ContextTrimmed, {
      sessionID: history.sessionID,
      targets: [
        { messageID: history.first.id },
        { messageID: history.second.id },
        { messageID: history.assistantMessageID, parts: [0] },
      ],
      note,
    })
  })

const assertTrimmed = (messages: ReadonlyArray<SessionMessage.Info>, history: History) => {
  expect(messages.map((message) => [message.id, message.type])).toEqual(
    history.original.map((message) => [message.id, message.type]),
  )
  expect(messages[0]).toEqual(history.original[0])
  expect(messages[1]).toEqual({ ...history.original[1], contextReplacement: note })
  expect(messages[2]).toEqual({ ...history.original[2], contextReplacement: "" })
  const original = history.original[3]
  if (original.type !== "assistant") throw new Error("Original assistant missing")
  expect(messages[3]).toEqual({
    ...original,
    native: undefined,
    contextInvalidated: true,
    content: [
      { type: "text", text: "Protected answer" },
      { type: "text", text: tailNote },
    ],
  })
  expect(messages[4]).toEqual(history.original[4])
  const lowered = toLLMMessages(messages, model)
  expect(lowered).toHaveLength(4)
  expect(lowered[1]).toMatchObject({
    id: history.first.id,
    role: "assistant",
    content: [{ type: "text", text: note }],
  })
  const payload = JSON.stringify(lowered)
  expect(payload).toContain(tailNote)
  expect(payload).not.toContain("Original notification")
  expect(payload).not.toContain("private reasoning")
  expect(payload).not.toContain("proof")
  expect(payload).not.toContain("original-response")
}

const serializedEvents = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return (yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()).map((event) => ({
      id: event.id,
      created: event.created,
      aggregateID: event.aggregate_id,
      seq: event.seq,
      type: event.type,
      data: event.data,
    }))
  })

it.live("replays durable context trims into a fresh isolated database, including duplicate replay", () =>
  Effect.gen(function* () {
    const history = yield* seed
    yield* trim(history)
    const expected = yield* (yield* SessionStore.Service).context(history.sessionID)
    assertTrimmed(expected, history)
    const events = yield* serializedEvents(history.sessionID)
    const firstTrim = events.findIndex((event) => event.type === Bus.versionedType(SessionEvent.ContextTrimmed.type, 1))
    expect(firstTrim).toBeGreaterThan(0)
    expect(events.slice(firstTrim).map((event) => event.type)).toEqual([
      Bus.versionedType(SessionEvent.ContextTrimmed.type, 1),
      Bus.versionedType(SessionEvent.ContextTrimmed.type, 1),
    ])

    const tmp = yield* tmpdirScoped()
    const targetLayer = AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node]),
      [
        Database.node.replace(Database.configured({ path: path.join(tmp.path, "replay.sqlite") })),
        Bus.node.replace(Bus.configured({ persist: true })),
      ],
    )
    yield* Effect.gen(function* () {
      const { db } = yield* Database.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      expect(yield* store.get(history.sessionID)).toBeUndefined()
      expect(yield* serializedEvents(history.sessionID)).toEqual([])
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: location.directory, sandboxes: [] })
        .run()
      yield* Effect.forEach(events.slice(0, firstTrim), (event) => bus.replay(event), { discard: true })
      expect(yield* store.context(history.sessionID)).toEqual(history.original)
      yield* Effect.forEach(events.slice(firstTrim), (event) => bus.replay(event), { discard: true })
      expect(yield* store.context(history.sessionID)).toEqual(expected)
      yield* Effect.forEach(events, (event) => bus.replay(event), { discard: true })
      expect(yield* store.context(history.sessionID)).toEqual(expected)
      expect(yield* serializedEvents(history.sessionID)).toEqual(events)
    }).pipe(Effect.provide(Layer.fresh(targetLayer)))
  }),
)

const withoutIDs = (messages: ReadonlyArray<SessionMessage.Info>) => messages.map(({ id, ...message }) => message)

it.effect("forks copy replacement notes, empty suppression, and mutated assistant content under new IDs", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const history = yield* seed
    yield* trim(history)
    const parent = yield* sessions.context(history.sessionID)
    const fork = yield* sessions.fork({ sessionID: history.sessionID })
    const copied = yield* sessions.context(fork.id)
    expect(withoutIDs(copied)).toEqual(withoutIDs(parent))
    expect(new Set([...parent, ...copied].map((message) => message.id)).size).toBe(parent.length + copied.length)
  }),
)

it.effect("revert can cut inside a trim span while retaining the replacement note", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const history = yield* seed
    const sessionID = history.sessionID
    yield* trim(history)
    const trimmed = yield* sessions.context(sessionID)
    // Exercise the actual revert projectors without involving filesystem snapshot capture.
    // Cutting within a trim span retains the note as-is, even though some summarized rows disappear.
    yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID, revert: { messageID: history.second.id } })
    yield* sessions.revert.commit(sessionID)
    expect(yield* sessions.context(sessionID)).toEqual(trimmed.slice(0, 2))
    expect(yield* sessions.message({ sessionID, messageID: history.assistantMessageID })).toBeUndefined()
    expect((yield* sessions.get(sessionID)).revert).toBeUndefined()
  }),
)

it.effect(
  "same-ID synthetic retries reconcile original payloads after trim without duplicate admission or messages",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const admission = yield* SessionInbox.Service
      const history = yield* seed
      yield* trim(history)
      const messages = yield* sessions.context(history.sessionID)
      const events = yield* serializedEvents(history.sessionID)

      // Both a nonempty replacement and an empty suppression retain their canonical synthetic payload.
      for (const original of [history.first, history.second]) {
        expect(yield* SessionInbox.find(db, original.id)).toBeUndefined()
        expect(
          yield* admission.reconcile({
            id: original.id,
            sessionID: history.sessionID,
            type: "synthetic",
            delivery: "steer",
          }),
        ).toEqual(original)
        expect(
          yield* sessions.synthetic({
            id: original.id,
            sessionID: history.sessionID,
            text: "Different retry payload",
            description: "Different description",
            metadata: { source: "retry" },
            resume: false,
          }),
        ).toEqual(original)
      }
      expect(yield* sessions.inbox(history.sessionID)).toEqual([])
      expect(yield* SessionInbox.promote(db, bus, history.sessionID, "steer")).toBe(0)
      expect(yield* sessions.context(history.sessionID)).toEqual(messages)
      expect(yield* serializedEvents(history.sessionID)).toEqual(events)
    }),
)
