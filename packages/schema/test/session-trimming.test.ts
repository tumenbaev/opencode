import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionTrimming as PublicSessionTrimming } from "../src/index.js"
import { SessionMessage } from "../src/session-message.js"
import { SessionEvent } from "../src/session-event.js"
import { SessionTrimming } from "../src/session-trimming.js"

test("manual trimming results use the canonical public schema and stable identifier", () => {
  expect(PublicSessionTrimming.Result).toBe(SessionTrimming.Result)
  expect(SessionTrimming.Result.ast.annotations?.identifier).toBe("SessionTrimming.Result")
})

test("context replacements preserve absent, note and suppressed values in storage", () => {
  const decode = Schema.decodeUnknownSync(SessionMessage.Info)
  const encode = Schema.encodeSync(SessionMessage.Info)
  const message = { id: "msg_trim", type: "synthetic" as const, text: "original", time: { created: 0 } }
  expect(encode({ ...decode(message), contextReplacement: undefined })).toEqual(message)
  for (const contextReplacement of ["historical note", ""])
    expect(encode(decode({ ...message, contextReplacement }))).toEqual({ ...message, contextReplacement })
})

test("ContextTrimmed is a current durable event that serializes optional assistant indices", () => {
  expect(SessionEvent.Definitions).toContain(SessionEvent.ContextTrimmed)
  expect(SessionEvent.DurableDefinitions).toContain(SessionEvent.ContextTrimmed)
  expect(SessionEvent.ContextTrimmed.durability).toBe("durable")
  const decode = Schema.decodeUnknownSync(SessionEvent.ContextTrimmed.data)
  const encode = Schema.encodeSync(SessionEvent.ContextTrimmed.data)
  const input = {
    sessionID: "ses_trim",
    targets: [{ messageID: "msg_one" }, { messageID: "msg_two", parts: [0, 2] }],
    note: "history",
  }
  expect(encode(decode(input))).toEqual(input)
  const decoded = decode(input)
  expect(
    encode({ ...decoded, targets: decoded.targets.slice(0, 1).map((target) => ({ ...target, parts: undefined })) }),
  ).toEqual({ ...input, targets: [{ messageID: "msg_one" }] })
})

test("trimming model calls can record durable usage", () => {
  const data = {
    sessionID: "ses_trim",
    source: "trimming" as const,
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  expect(
    Schema.encodeSync(SessionEvent.UsageRecorded.data)(Schema.decodeUnknownSync(SessionEvent.UsageRecorded.data)(data)),
  ).toEqual(data)
})
