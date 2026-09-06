import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { Trimming } from "@/plugin/trimming"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const ref = Provider.parseModel(Trimming.defaults.model)
const sessionID = SessionID.create()

function user(value = "original request"): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: { id, sessionID, role: "user", time: { created: 1 }, agent: "build", model: ref },
    parts: value ? [{ id: PartID.ascending(), messageID: id, sessionID, type: "text", text: value }] : [],
  }
}

function assistant(parts: SessionV1.Part[], overrides: Partial<SessionV1.Assistant> = {}): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: MessageID.ascending(),
      ...ref,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "tool-calls",
      ...overrides,
    },
    parts: parts.map((part) => ({ ...part, messageID: id })),
  }
}

function tool(size = 16000): Trimming.CompletedTool {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID,
    type: "tool",
    tool: "read",
    callID: "call",
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(size),
      title: "read",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function text(value: string): SessionV1.TextPart {
  return { id: PartID.ascending(), messageID: MessageID.ascending(), sessionID, type: "text", text: value }
}

function layer(stream: LLM.Interface["stream"]) {
  return Trimming.layer.pipe(
    Layer.provide([
      ProviderTest.fake({ model: ProviderTest.model({ id: ref.modelID, providerID: ref.providerID }) }).layer,
      Layer.mock(LLM.Service, { stream }),
    ]),
  )
}

function response(value: string) {
  return Stream.fromArray([LLMEvent.textDelta({ id: "text", text: value }), LLMEvent.finish({ reason: "stop" })])
}

describe("trimming groups", () => {
  test("combines assistant messages across reasoning and step markers, without mutating the snapshot", () => {
    const messages = [
      user(),
      assistant([tool(8000)]),
      assistant([
        { ...text("private reasoning"), type: "reasoning", time: { start: 1 } },
        { id: PartID.ascending(), messageID: MessageID.ascending(), sessionID, type: "step-start" },
        text("   "),
        tool(8000),
      ]),
    ]
    const snapshot = structuredClone(messages)
    const groups = Trimming.groups(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0].parts).toHaveLength(2)
    expect(messages[1].parts[0]).toBe(groups[0].parts[0])
    expect(groups[0].beforeTokens).toBe(4002)
    expect(messages).toEqual(snapshot)
  })

  test("every nonempty text splits groups, and context includes the eventual final answer", () => {
    const messages = [
      user(),
      assistant([text("before"), tool(), text("between"), tool()]),
      assistant([text("final one"), text("final two")], { finish: "stop" }),
      user("later request"),
      assistant([text("unrelated answer")], { finish: "stop" }),
    ]
    const groups = Trimming.groups(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({
      originatingUser: "original request",
      before: "before",
      after: "between",
      finalResponse: "final one\nfinal two",
    })
    expect(groups[1]).toMatchObject({ before: "between", after: "final one", finalResponse: "final one\nfinal two" })
  })

  test("user turns, including empty ones, cannot merge tools or leak final responses", () => {
    const messages = [
      user(),
      assistant([tool()]),
      user(""),
      assistant([tool()]),
      assistant([text("second turn answer")], { finish: "stop" }),
    ]
    const groups = Trimming.groups(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0].finalResponse).toBe("")
    expect(groups[1].originatingUser).toBe("")
    expect(groups[1].finalResponse).toBe("second turn answer")
  })

  test("the 4000-token minimum includes arguments and output", () => {
    expect(Trimming.groups([user(), assistant([tool(15992)])])).toHaveLength(0)
    expect(Trimming.groups([user(), assistant([tool(15998)])])[0].beforeTokens).toBe(4000)
    const part = tool(0)
    part.state.input = { data: "x".repeat(16000) }
    expect(Trimming.groups([user(), assistant([part])])).toHaveLength(1)
  })

  test("skips incomplete, failed, compacted, attachment, control and error records", () => {
    const compacted = tool()
    compacted.state.time.compacted = 3
    const attachment = tool()
    attachment.state.attachments = [
      {
        id: PartID.ascending(),
        messageID: MessageID.ascending(),
        sessionID,
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AA==",
      },
    ]
    const pending: SessionV1.ToolPart = { ...tool(), state: { status: "pending", input: {}, raw: "" } }
    const failed: SessionV1.ToolPart = {
      ...tool(),
      state: { status: "error", input: {}, error: "failed", time: { start: 1, end: 2 } },
    }
    const messages = [
      user(),
      assistant([compacted, attachment, pending, failed]),
      assistant([tool()], { summary: true }),
      assistant([tool()], { error: { name: "MessageAbortedError", data: { message: "cancelled" } } }),
      assistant([
        { id: PartID.ascending(), messageID: MessageID.ascending(), sessionID, type: "compaction", auto: true },
      ]),
    ]
    expect(Trimming.groups(messages)).toEqual([])
    expect(Trimming.groups([user(), assistant([tool(8000), pending, tool(8000)])])).toEqual([])
  })
})

describe("trimming validation", () => {
  test("accepts keep or a nonempty replacement with no injected prefix or target size", () => {
    expect(Option.getOrThrow(Trimming.decodeDecision('{"action":"keep"}'))).toEqual({ action: "keep" })
    const note = "  exact note\n" + "x".repeat(20000)
    expect(Option.getOrThrow(Trimming.decodeDecision(JSON.stringify({ action: "replace", note })))).toEqual({
      action: "replace",
      note,
    })
  })

  test("rejects malformed, ambiguous, fenced and empty decisions", () => {
    ;[
      "",
      "not json",
      '```json\n{"action":"keep"}\n```',
      '{"action":"replace"}',
      '{"action":"replace","note":"  "}',
      '{"action":"replace","note":1}',
      '{"action":"keep","note":"remove"}',
      '{"action":"delete"}',
    ].forEach((value) => {
      expect(Option.isNone(Trimming.decodeDecision(value))).toBe(true)
    })
  })

  test("gates by enabled and threshold, or lets the caller gate", () => {
    expect(Trimming.shouldReview({ config: Trimming.defaults })).toBe(false)
    expect(Trimming.shouldReview({ config: { enabled: true } })).toBe(true)
    expect(Trimming.shouldReview({ config: { enabled: false } })).toBe(false)
    expect(Trimming.shouldReview({ config: { enabled: true }, usage: { tokens: 70, context: 100 } })).toBe(true)
    expect(Trimming.shouldReview({ config: { enabled: true }, usage: { tokens: 69, context: 100 } })).toBe(false)
    expect(
      Trimming.shouldReview({ config: { enabled: true, threshold: 0.5 }, usage: { tokens: 50, context: 100 } }),
    ).toBe(true)
    expect(Trimming.shouldReview({ config: { enabled: true }, usage: { tokens: 1, context: 0 } })).toBe(false)
    expect(Trimming.shouldReview({ config: { enabled: true, threshold: NaN } })).toBe(false)
    expect(Trimming.shouldReview({ config: { enabled: true, threshold: 0 } })).toBe(false)
  })
})

it.effect("gathers all successful proposals while failed and invalid reviews stay unchanged", () =>
  Effect.gen(function* () {
    const calls: LLM.StreamInput[] = []
    yield* Effect.gen(function* () {
      const messages = [
        user(),
        assistant(Array.from({ length: 5 }, (_, index) => [text(`before ${index}`), tool()]).flat()),
      ]
      const trimming = yield* Trimming.Service
      const proposals = yield* trimming.review({
        messages,
        prompt: "new followup",
        config: { enabled: true, variant: "custom" },
      })
      expect(proposals.map((proposal) => proposal.note)).toEqual(["first", "last"])
      expect(messages[1].parts[1]).toBe(proposals[0].parts[0])
      expect(proposals[0].afterTokens).toBe(1)
      expect(calls).toHaveLength(5)
      calls.forEach((call) => {
        expect(call.tools).toEqual({})
        expect(call.toolChoice).toBe("none")
        expect(call.small).toBeUndefined()
        expect(call.user.model.variant).toBe("custom")
        expect(call.model.id).toBe(ref.modelID)
        expect(call.messages[0].content).toContain("new followup")
      })
    }).pipe(
      Effect.provide(
        layer((input) => {
          // Assign scenarios by context instead of depending on concurrent invocation order.
          const content = String(input.messages[0].content)
          calls.push(input)
          if (content.includes('"before":"before 1"')) return Stream.fail(new Error("review failed"))
          if (content.includes('"before":"before 2"')) return response("invalid")
          if (content.includes('"before":"before 3"')) return response('{"action":"keep"}')
          return response(
            JSON.stringify({ action: "replace", note: content.includes('"before":"before 0"') ? "first" : "last" }),
          )
        }),
      ),
    )
  }),
)

it.effect("interruption cancels reviews instead of becoming keep", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const task = Effect.gen(function* () {
      const trimming = yield* Trimming.Service
      return yield* trimming.review({
        messages: [user(), assistant([tool()])],
        prompt: "next",
        config: { enabled: true },
      })
    }).pipe(
      Effect.provide(
        layer(() =>
          Stream.fromEffect(
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined)
              return yield* Effect.never
            }),
          ),
        ),
      ),
    )
    const fiber = yield* task.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }),
)

it.effect("runs at most eight reviews concurrently and drains every candidate", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const state = { calls: 0, active: 0, peak: 0 }
    const task = Effect.gen(function* () {
      const trimming = yield* Trimming.Service
      return yield* trimming.review({
        messages: [
          user(),
          assistant(Array.from({ length: 12 }, (_, index) => [text(`boundary ${index}`), tool()]).flat()),
        ],
        prompt: "next",
        config: { enabled: true },
      })
    }).pipe(
      Effect.provide(
        layer(() =>
          Stream.unwrap(
            Effect.gen(function* () {
              state.calls++
              state.active++
              state.peak = Math.max(state.peak, state.active)
              if (state.calls === 8) yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return response('{"action":"replace","note":"result"}').pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    state.active--
                  }),
                ),
              )
            }),
          ),
        ),
      ),
    )
    const fiber = yield* task.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    expect(state.calls).toBe(8)
    expect(state.active).toBe(8)
    yield* Deferred.succeed(release, undefined)
    const proposals = yield* Fiber.join(fiber)
    expect(proposals).toHaveLength(12)
    expect(state.calls).toBe(12)
    expect(state.peak).toBe(8)
    expect(state.active).toBe(0)
  }),
)

it.effect("does not accept a valid-looking note from an unfinished or truncated stream", () =>
  Effect.gen(function* () {
    const trimming = yield* Trimming.Service
    const proposals = yield* trimming.review({
      messages: [user(), assistant([tool(), text("boundary"), tool()])],
      prompt: "next",
      config: { enabled: true },
    })
    expect(proposals).toEqual([])
  }).pipe(
    Effect.provide(
      layer((input) =>
        Stream.fromArray([
          LLMEvent.textDelta({ id: "text", text: '{"action":"replace","note":"partial"}' }),
          ...(String(input.messages[0].content).includes('"before":"boundary"')
            ? [LLMEvent.finish({ reason: "length" })]
            : []),
        ]),
      ),
    ),
  ),
)

it.effect("keeps oversized groups and non-shrinking replacements unchanged", () =>
  Effect.gen(function* () {
    const calls: LLM.StreamInput[] = []
    yield* Effect.gen(function* () {
      const trimming = yield* Trimming.Service
      const proposals = yield* trimming.review({
        messages: [user(), assistant([tool(800000), text("boundary"), tool()])],
        prompt: "next",
        config: { enabled: true },
      })
      expect(calls).toHaveLength(1)
      expect(proposals).toEqual([])
    }).pipe(
      Effect.provide(
        layer((input) => {
          calls.push(input)
          return response(JSON.stringify({ action: "replace", note: "x".repeat(20000) }))
        }),
      ),
    )
  }),
)

it.effect("a timed-out review keeps its group without discarding successful reviews", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const task = Effect.gen(function* () {
      const trimming = yield* Trimming.Service
      return yield* trimming.review({
        messages: [user(), assistant([tool(), text("slow"), tool()])],
        prompt: "next",
        config: { enabled: true },
      })
    }).pipe(
      Effect.provide(
        layer((input) =>
          String(input.messages[0].content).includes('"before":"slow"')
            ? Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
            : response('{"action":"replace","note":"kept result"}'),
        ),
      ),
    )
    const fiber = yield* task.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust("121 seconds")
    const proposals = yield* Fiber.join(fiber)
    expect(proposals.map((proposal) => proposal.note)).toEqual(["kept result"])
  }),
)
