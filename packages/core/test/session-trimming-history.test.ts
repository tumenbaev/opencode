import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { LanguageModel, LLMClient, LLMEvent } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { asc, eq } from "drizzle-orm"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Money } from "@opencode/schema/money"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionEvent } from "@opencode/schema/session-event"
import { SessionID } from "@opencode/schema/session-id"
import { Shell } from "@opencode/schema/shell"
import { Skill } from "@opencode/schema/skill"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { TrimmingHistory } from "@opencode/core/session/trimming-history"
import { toLLMMessages } from "@opencode/core/session/runner/to-llm-message"
import { Token } from "@opencode/core/util/token"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionProjector } from "@opencode/core/session/projector"
import { ProjectTable } from "@opencode/core/project/sql"
import { InstructionStateTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { SessionRecentText } from "@opencode/core/session/recent-text"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { Location } from "@opencode/core/location"
import { Project as CoreProject } from "@opencode/core/project"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const created = DateTime.makeUnsafe(0)
const time = { created, completed: created }
const id = (name: string) => SessionMessage.ID.make(`msg_${name}`)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const long = "x".repeat(16_000)
const text = (value: string): SessionMessage.AssistantText => ({ type: "text", text: value })
const reasoning = (value = long): SessionMessage.AssistantReasoning => ({ type: "reasoning", text: value })
const user = (name: string, value = "request"): SessionMessage.User => ({
  id: id(name),
  type: "user",
  text: value,
  time: { created },
})
const assistant = (name: string, content: SessionMessage.Assistant["content"]): SessionMessage.Assistant => ({
  id: id(name),
  type: "assistant",
  agent: Agent.ID.make("build"),
  model,
  content,
  time,
})
const synthetic = (name: string, value = long): SessionMessage.Synthetic => ({
  id: id(name),
  type: "synthetic",
  text: value,
  time: { created },
})
const tool = (
  name = "read",
  value = long,
): SessionMessage.AssistantTool & { state: SessionMessage.ToolStateCompleted } => ({
  id: `call_${name}`,
  type: "tool",
  name,
  state: { status: "completed", input: { path: "file" }, content: [{ type: "text", text: value }] },
  time,
})
const shell = (name: string, background = false): SessionMessage.Shell => ({
  id: id(name),
  type: "shell",
  shellID: Shell.ID.make(`sh_${name}`),
  command: "pwd",
  status: "exited",
  output: { output: long, cursor: long.length, size: long.length, truncated: true },
  metadata: { background },
  time,
})
const target = (message: SessionMessage.Info, parts?: ReadonlyArray<number>): TrimmingHistory.Target =>
  parts === undefined ? { messageID: message.id } : { messageID: message.id, parts }

describe("TrimmingHistory.groups", () => {
  test("reviews rebuilt recent text in textual checkpoints but never opaque native windows", () => {
    const checkpoint: SessionMessage.CompactionCompleted = {
      id: id("checkpoint"),
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "s".repeat(8_000),
      metadata: { recent: "r".repeat(8_000) },
      time,
    }
    expect(TrimmingHistory.groups([checkpoint])).toMatchObject([
      { content: [{ type: "compaction", text: `${checkpoint.summary}\n\n${SessionRecentText.kept(checkpoint)}` }] },
    ])
    const native = { ...checkpoint, native: { messages: [] } }
    expect(TrimmingHistory.groups([native])).toEqual([])
    expect(TrimmingHistory.apply([native], [target(native)], "note")).toEqual([native])
  })

  test("protects every text segment, including commentary, within one assistant row", () => {
    const response = assistant("mixed", [reasoning(), text("commentary"), tool(), text("answer"), reasoning()])
    const groups = TrimmingHistory.groups([user("user"), response, user("next", "")])
    expect(groups.map((group) => ({ before: group.before, after: group.after, targets: group.targets }))).toEqual([
      { before: "request", after: "commentary", targets: [target(response, [0])] },
      { before: "commentary", after: "answer", targets: [target(response, [2])] },
      { before: "answer", after: "", targets: [target(response, [4])] },
    ])
    expect(groups.map((group) => group.content[0]?.type)).toEqual(["reasoning", "tool", "reasoning"])
  })

  test("allows missing surrounding anchors and requires at least 4000 tokens", () => {
    const response = assistant("work", [reasoning()])
    expect(TrimmingHistory.groups([response, user("end")])).toMatchObject([{ before: "", after: "request" }])
    expect(TrimmingHistory.groups([user("start"), response])).toMatchObject([{ before: "request", after: "" }])
    expect(
      TrimmingHistory.groups([user("start"), assistant("small", [reasoning("x".repeat(15_996))]), user("end")]),
    ).toEqual([])
    expect(TrimmingHistory.groups([user("start", ""), response, user("end", "")])).toMatchObject([
      { before: "", after: "", beforeTokens: 4_000 },
    ])
  })

  test("combines all candidates across transparent bookkeeping and assistant rows", () => {
    const first = assistant("first", [reasoning("r".repeat(4_000)), tool("read", "o".repeat(4_000))])
    const second = assistant("abandoned", [
      {
        ...tool("failed", ""),
        state: { status: "error", input: {}, error: { type: "tool.execution_failed", message: "e".repeat(4_000) } },
      },
      {
        ...tool("abandoned", ""),
        state: { status: "running", input: { query: "q".repeat(4_000) }, metadata: { opaque: "not reviewer data" } },
      },
    ])
    const history: SessionMessage.Info[] = [
      user("start"),
      first,
      { id: id("idle"), type: "idle", outcome: "interrupted", time },
      { id: id("agent"), type: "agent-switched", agent: Agent.ID.make("plan"), time },
      second,
      user("end"),
    ]
    const groups = TrimmingHistory.groups(history)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.targets).toEqual([target(first, [0, 1]), target(second, [0, 1])])
    expect(groups[0]?.content.map((record) => record.type)).toEqual(["reasoning", "tool", "tool", "tool"])
    expect(groups[0]?.beforeTokens).toBeGreaterThanOrEqual(4_000)
    expect(JSON.stringify(groups[0]?.content)).not.toContain("not reviewer data")
  })

  test("keeps reviewer records text-only, including full inputs and already-truncated outputs", () => {
    const call: SessionMessage.AssistantTool = {
      ...tool(),
      native: { secret: "provider-secret" },
      state: {
        status: "completed",
        input: { code: long },
        metadata: { truncated: true, path: "metadata-secret" },
        content: [
          { type: "text", text: "tail\n[truncated]" },
          { type: "file", mime: "image/png", uri: "data:image/png;base64,attachment-secret", name: "attachment-name" },
        ],
      },
    }
    const [group] = TrimmingHistory.groups([user("start"), assistant("work", [call]), user("end")])
    expect(group?.content).toEqual([
      { type: "tool", name: "read", input: JSON.stringify({ code: long }), output: "tail\n[truncated]" },
    ])
    const payload = JSON.stringify({ before: group?.before, content: group?.content, after: group?.after })
    for (const forbidden of [
      "attachment-secret",
      "attachment-name",
      "metadata-secret",
      "provider-secret",
      "targets",
      "messageID",
    ])
      expect(payload).not.toContain(forbidden)
    expect(group?.targets).toEqual([{ messageID: id("work"), parts: [0] }])
  })

  test("foreground subagent tools and synthetic subagent results anchor; background acknowledgements do not", () => {
    const foreground = tool("subagent", "subagent result")
    const response = assistant("work", [reasoning(), foreground, reasoning()])
    const completion = { ...synthetic("completion", "background result"), metadata: { source: "subagent" } }
    const background = { ...tool("subagent"), state: { ...tool("subagent").state, input: { background: true } } }
    const groups = TrimmingHistory.groups([
      user("start"),
      response,
      completion,
      assistant("background", [background]),
      user("end"),
    ])
    expect(groups).toHaveLength(3)
    expect(groups[0]?.after).toContain("subagent result")
    expect(groups[1]?.before).toContain("subagent result")
    expect(groups[1]?.after).toBe("background result")
    expect(groups[2]?.before).toBe("background result")
    expect(groups[2]?.targets).toEqual([{ messageID: id("background"), parts: [0] }])
  })

  test("shells and chronological notices are candidates, only the model-facing shell row counts", () => {
    const notification = { ...synthetic("notification"), metadata: { source: "shell" } }
    const foreground = shell("foreground")
    const notices: SessionMessage.Info[] = [
      { id: id("system"), type: "system", text: "instruction update", time },
      {
        id: id("skill"),
        type: "skill",
        skill: Skill.ID.make("skill_test"),
        name: Skill.Name.make("test"),
        text: "skill instructions",
        time,
      },
      { id: id("location"), type: "location-switched", location: { directory: AbsolutePath.make("/next") }, time },
      { id: id("model"), type: "model-switched", model, time },
    ]
    const [group] = TrimmingHistory.groups([
      user("start"),
      shell("background", true),
      notification,
      ...notices,
      foreground,
      user("end"),
    ])
    expect(group?.content.map((record) => record.type)).toEqual([
      "synthetic",
      "system",
      "skill",
      "location-switched",
      "model-switched",
      "shell",
    ])
    expect(group?.targets.map((entry) => entry.messageID)).toEqual([
      notification.id,
      ...notices.map((notice) => notice.id),
      foreground.id,
    ])
    expect(TrimmingHistory.estimate([shell("background", true)])).toBe(0)
  })
})

describe("TrimmingHistory.apply and lowering", () => {
  test("inserts ordinary assistant text at the first selected position and drops continuation proofs", () => {
    const response: SessionMessage.Assistant = {
      ...assistant("work", [text("before"), reasoning(), tool(), text("after")]),
      native: { responseID: "original" },
      cost: Money.USD.make(1),
      tokens: { input: 100, output: 10, reasoning: 2, cache: { read: 1, write: 0 } },
      content: [
        { ...text("before"), native: { signature: "original" } },
        reasoning(),
        tool(),
        { ...text("after"), native: { signature: "original" } },
        {
          ...tool("retained", "small"),
          native: { signature: "original", proof: "original" },
        },
      ],
    }
    const [updated] = TrimmingHistory.apply([response], [target(response, [1, 2])], "historical note")
    expect(updated).toMatchObject({
      id: response.id,
      content: [text("before"), text("historical note"), text("after"), tool("retained", "small")],
    })
    if (updated?.type !== "assistant") throw new Error("assistant missing")
    expect(updated.content).toEqual([text("before"), text("historical note"), text("after"), tool("retained", "small")])
    expect(updated.native).toBeUndefined()
    expect(updated.cost).toBe(response.cost)
    expect(updated.tokens).toEqual(response.tokens)
    expect(JSON.stringify(toLLMMessages([updated], model))).not.toContain("original")
    expect(response.content).toHaveLength(5)
  })

  test("retains standalone type, payload and ID while suppressing originals across message types", () => {
    const history: SessionMessage.Info[] = [
      synthetic("first"),
      { id: id("system"), type: "system", text: long, time },
      shell("shell"),
      { id: id("location"), type: "location-switched", location: { directory: AbsolutePath.make("/next") }, time },
      { id: id("model"), type: "model-switched", model, time },
      {
        id: id("skill"),
        type: "skill",
        skill: Skill.ID.make("skill_test"),
        name: Skill.Name.make("test"),
        text: long,
        time,
      },
      assistant("last", [reasoning(), tool()]),
    ]
    const targets = history.map((message) => target(message, message.type === "assistant" ? [0, 1] : undefined))
    const updated = TrimmingHistory.apply(history, targets, "A historical note")
    expect(updated.slice(0, -1)).toEqual(
      history
        .slice(0, -1)
        .map((message, index) => ({ ...message, contextReplacement: index === 0 ? "A historical note" : "" })),
    )
    expect(updated.at(-1)).toMatchObject({ id: id("last"), content: [] })
    const sent = toLLMMessages(updated, model)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      id: history[0]?.id,
      role: "assistant",
      content: [{ type: "text", text: "A historical note" }],
    })
    expect(TrimmingHistory.estimate(updated)).toBe(Token.estimate("A historical note"))
    expect(TrimmingHistory.groups([user("start"), ...updated, user("end")])).toEqual([])
  })

  test("replacement notes are anchors, never candidates, and hidden originals stay hidden", () => {
    const note = { ...synthetic("note"), contextReplacement: "kept historical note" }
    const hidden = { ...synthetic("hidden"), contextReplacement: "" }
    const work = assistant("work", [reasoning()])
    const [group] = TrimmingHistory.groups([user("start"), hidden, note, work, user("end")])
    expect(group).toMatchObject({ before: note.contextReplacement, after: "request", targets: [target(work, [0])] })
    expect(toLLMMessages([{ ...work, contextReplacement: "" }, hidden], model)).toEqual([])
  })

  test("empty note suppresses every selected position but preserves assistant accounting rows", () => {
    const history = [synthetic("first"), assistant("last", [reasoning()])]
    const updated = TrimmingHistory.apply(history, [target(history[0]), target(history[1], [0])], "")
    expect(updated).toHaveLength(2)
    expect(updated[0]?.contextReplacement).toBe("")
    expect(updated[1]).toMatchObject({ id: id("last"), content: [], time })
    expect(toLLMMessages(updated, model)).toEqual([])
  })

  test("malformed events cannot edit protected anchors or partially apply", () => {
    const start = user("start", "")
    const work = assistant("work", [reasoning(), text("anchor"), tool("subagent")])
    const end = { ...synthetic("subagent"), metadata: { source: "subagent" } }
    const history = [start, work, end]
    const invalid: ReadonlyArray<ReadonlyArray<TrimmingHistory.Target>> = [
      [target(start)],
      [target(work)],
      [target(work, [0, 1])],
      [target(work, [2])],
      [target(end)],
      [target(work, [])],
      [target(work, [0, 0])],
      [target(work, [-1])],
      [target(work, [99])],
      [target(work, [0.5])],
      [target(work, [0]), target(start)],
      [target(work, [0]), { messageID: id("missing") }],
    ]
    for (const targets of invalid) expect(TrimmingHistory.apply(history, targets, "note")).toBe(history)
  })

  test("applying groups in reverse order preserves intra-assistant indices", () => {
    const response = assistant("work", [reasoning(), tool(), text("middle"), reasoning(), tool(), text("end")])
    const history = [user("start"), response]
    const groups = TrimmingHistory.groups(history)
    let result: ReadonlyArray<SessionMessage.Info> = history
    for (const [index, group] of [...groups].reverse().entries())
      result = TrimmingHistory.apply(result, group.targets, `note ${index}`)
    expect(result[1]).toMatchObject({ content: [text("note 1"), text("middle"), text("note 0"), text("end")] })
  })
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

it.effect("projects durable replacements without changing operational state or deleting original rows", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const sessionID = SessionID.make("ses_trimming")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        directory: "/project",
        slug: "test",
        version: "test",
        agent: Agent.ID.make("build"),
        model,
      })
      .run()
    yield* db
      .insert(InstructionStateTable)
      .values({ session_id: sessionID, epoch_start: 0, through_seq: 0, initial_values: {}, current_values: {} })
      .run()
    const history: SessionMessage.Info[] = [
      user("start"),
      synthetic("original"),
      assistant("work", [reasoning()]),
      shell("shell"),
      user("end"),
    ]
    const encode = Schema.encodeSync(SessionMessage.Info)
    yield* db
      .insert(SessionMessageTable)
      .values(
        history.map((message, seq) => {
          const { id, type, ...data } = encode(message)
          return { id: SessionMessage.ID.make(id), type, data, seq, session_id: sessionID, time_created: 0 }
        }),
      )
      .run()
    const state = yield* db.select().from(SessionTable).get()
    const instructions = yield* db.select().from(InstructionStateTable).get()
    const [group] = TrimmingHistory.groups(history)
    if (!group) throw new Error("group missing")
    yield* bus.publish(SessionEvent.ContextTrimmed, { sessionID, targets: group.targets, note: "Durable note" })
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
    const decode = Schema.decodeUnknownSync(SessionMessage.Info)
    const projected = rows.map((row) => decode({ ...row.data, id: row.id, type: row.type }))
    expect(projected).toEqual([...TrimmingHistory.apply(history, group.targets, "Durable note")])
    expect(projected).toHaveLength(history.length)
    expect(yield* db.select().from(SessionTable).get()).toEqual(state)
    expect(yield* db.select().from(InstructionStateTable).get()).toEqual(instructions)
    // A malformed event is a deterministic no-op, not a partial trim.
    yield* bus.publish(SessionEvent.ContextTrimmed, { sessionID, targets: [{ messageID: id("start") }], note: "bad" })
    expect(yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.seq)).all()).toEqual(rows)
  }),
)

const transferIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([SessionTransfer.node, Session.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
    CoreProject.node.replace(globalProjectNode),
    LocationServiceMap.node.replace(promptLocationNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
  ]),
)

transferIt.effect("exports sanitize replacement notes, preserve empty suppression, and round trip projected rows", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const transfer = yield* SessionTransfer.Service
    const template = yield* sessions.create({ location: { directory: AbsolutePath.make("/project") } })
    const sessionID = SessionID.make("ses_trim_transfer")
    const history: SessionMessage.Info[] = [
      { ...synthetic("kept", "original secret"), contextReplacement: "replacement secret" },
      { ...shell("suppressed"), contextReplacement: "" },
      assistant("empty", []),
    ]
    yield* transfer.import({
      data: { info: { ...template, id: sessionID }, messages: history },
      location: template.location,
    })
    const exported = yield* transfer.export({ sessionID })
    expect(exported.messages).toEqual(history)
    const sanitized = yield* transfer.export({ sessionID, sanitize: true })
    expect(sanitized.messages.map((message) => message.contextReplacement)).toEqual([
      `[redacted:context-replacement:${id("kept")}]`,
      "",
      undefined,
    ])
    expect(JSON.stringify(sanitized)).not.toContain("replacement secret")
    expect(toLLMMessages(exported.messages, model)).toHaveLength(1)
  }),
)

const compactionIt = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionCompaction.node, SessionStore.node, SessionProjector.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      llmClient.replace(
        Layer.mock(LLMClient.Service)({
          stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "## Objective\n- summary" })),
          generate: () => Effect.die("unused"),
        }),
      ),
    ],
  ),
)

compactionIt.effect("compaction serializes only effective replacement content, never retained originals", () =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const compaction = yield* SessionCompaction.Service
    const sessionID = SessionID.make("ses_trim_compaction")
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", slug: "test", version: "test" })
      .run()
    const session = yield* store.get(sessionID)
    if (!session) throw new Error("session missing")
    const inputID = id("compact")
    const messages: SessionMessage.Info[] = [
      user("older", "Older exchange"),
      user("recent", "Recent exchange"),
      {
        id: id("instructions"),
        type: "system",
        text: "hidden instructions",
        contextReplacement: "historical update",
        time: { created },
      },
      { ...synthetic("hidden", "hidden notification"), contextReplacement: "" },
      { ...shell("hidden-shell"), contextReplacement: "" },
      assistant("answer", [text("Final answer")]),
    ]
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
    yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", inputID })
    const summaryModel = SessionRunnerModel.resolved(
      LanguageModel.make({ id: "summary-model", provider: "test", route: OpenAIChat.route }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      },
    )
    expect(
      yield* compaction.compact({
        reason: "manual",
        inputID,
        context: {
          session,
          model: summaryModel,
          messages,
          agent: { id: Agent.ID.make("build"), info: Agent.Info.default(Agent.ID.make("build")) },
          initial: "Session instructions",
          tools: { definitions: [], execute: () => Effect.die("unused") },
        },
      }),
    ).toEqual({ status: "completed" })
    const [checkpoint] = yield* store.context(sessionID)
    if (checkpoint?.type !== "compaction" || checkpoint.status !== "completed") throw new Error("checkpoint missing")
    const recent = SessionRecentText.kept(checkpoint)
    expect(recent).toContain("[Assistant]: historical update")
    expect(recent).toContain("Final answer")
    expect(recent).not.toContain("hidden instructions")
    expect(recent).not.toContain("hidden notification")
    expect(recent).not.toContain("[Shell]")
  }),
)
