import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { LLMEvent } from "@opencode-ai/llm"
import { Langfuse } from "../../src/observability/langfuse"

const NodeSdk = await import("@effect/opentelemetry/NodeSdk")

test("disabled generation returns the original stream", () => {
  const stream = Stream.empty
  expect(Langfuse.generation(stream, { sessionID: "session", model: "model", provider: "provider", request: {} })).toBe(
    stream,
  )
})

describe("Langfuse configuration", () => {
  const file = async () =>
    'LANGFUSE=true\nLANGFUSE_PUBLIC_KEY="pk-file"\nLANGFUSE_SECRET_KEY=sk-file\nLANGFUSE_BASE_URL=https://example.com/\n'

  test("disabled does not read credentials, even with keys present", async () => {
    expect(
      await Langfuse.configuration(
        { LANGFUSE_PUBLIC_KEY: "pk" },
        () => {
          throw new Error("must not read")
        },
        false,
      ),
    ).toBeUndefined()
  })

  test("environment overrides file and constructs direct trace-only endpoint", async () => {
    expect(await Langfuse.configuration({ LANGFUSE_PUBLIC_KEY: "pk-env" }, file, true)).toEqual({
      url: "https://example.com/api/public/otel/v1/traces",
      headers: {
        Authorization: `Basic ${Buffer.from("pk-env:sk-file").toString("base64")}`,
        "x-langfuse-ingestion-version": "4",
      },
    })
  })

  test("missing file or invalid/incomplete credentials disable export", async () => {
    expect(
      await Langfuse.configuration(
        {},
        async () => {
          throw new Error("missing")
        },
        true,
      ),
    ).toBeUndefined()
    expect(await Langfuse.configuration({ LANGFUSE_SECRET_KEY: "" }, file, true)).toBeUndefined()
    expect(
      await Langfuse.configuration({ LANGFUSE_BASE_URL: "https://user:pass@example.com" }, file, true),
    ).toBeUndefined()
  })
})

test("content is bounded, omits binary and transport fields, and tolerates cycles", () => {
  const value = {
    text: "hello",
    headers: { Authorization: "secret" },
    image: "base64",
    bytes: new Uint8Array([1]),
    data: "base64",
    nested: {},
  }
  value.nested = value
  const captured = Langfuse.content(value)
  expect(captured).toContain("hello")
  expect(captured).not.toContain("secret")
  expect(captured).not.toContain("base64")
  expect(captured).toContain("[circular]")
  expect(Langfuse.content({ text: '"'.repeat(100_000) }).length).toBeLessThanOrEqual(32_768)
  expect(() => JSON.parse(Langfuse.content({ text: "x".repeat(100_000) }))).not.toThrow()
})

test("generation spans cover consumption, select only generations, group sessions, and do not double usage", async () => {
  const exporter = new InMemorySpanExporter()
  const generic = new InMemorySpanExporter()
  Langfuse.activate()
  await Effect.gen(function* () {
    yield* Langfuse.generation(
      Stream.fromIterable([
        LLMEvent.textDelta({ id: "text", text: "hello" }),
        LLMEvent.toolCall({ id: "tool", name: "read", input: { path: "README.md" } }),
        LLMEvent.toolResult({ id: "tool", name: "read", result: { type: "text", value: "file contents" } }),
        LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
        LLMEvent.finish({ reason: "stop", usage: { inputTokens: 10, outputTokens: 2 } }),
      ]).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            expect(exporter.getFinishedSpans()).toHaveLength(0)
          }),
        ),
      ),
      { sessionID: "session-1", model: "test-model", provider: "test", request: { messages: ["prompt"] } },
    ).pipe(Stream.runDrain)
    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(1)
    expect(spans[0].parentSpanContext).toBeUndefined()
    expect(spans[0].attributes["langfuse.session.id"]).toBe("session-1")
    expect(spans[0].attributes["langfuse.observation.output"]).toContain("hello")
    expect(spans[0].attributes["langfuse.observation.output"]).toContain("README.md")
    expect(spans[0].attributes["langfuse.observation.output"]).toContain("file contents")
    expect(JSON.parse(String(spans[0].attributes["langfuse.observation.usage_details"]))).toEqual({
      input: 10,
      output: 2,
    })
    yield* Effect.void.pipe(Effect.withSpan("internal"))
    expect(exporter.getFinishedSpans()).toHaveLength(1)
    expect(generic.getFinishedSpans().some((span) => span.name === "internal")).toBe(true)
  }).pipe(
    Effect.provide(
      NodeSdk.layer(() => ({
        resource: { serviceName: "test" },
        spanProcessor: [new SimpleSpanProcessor(Langfuse.selectedExporter(exporter)), new SimpleSpanProcessor(generic)],
      })),
    ),
    Effect.runPromise,
  )
})

test("failed and interrupted streams end their spans with partial output", async () => {
  const exporter = new InMemorySpanExporter()
  Langfuse.activate()
  await Effect.gen(function* () {
    for (const end of [Effect.fail("broken"), Effect.interrupt]) {
      yield* Langfuse.generation(
        Stream.make(LLMEvent.textDelta({ id: "text", text: "partial" })).pipe(Stream.concat(Stream.fromEffect(end))),
        { sessionID: "session-2", model: "test", provider: "test", request: {} },
      ).pipe(Stream.runDrain, Effect.exit)
    }
    expect(exporter.getFinishedSpans()).toHaveLength(2)
    expect(
      exporter
        .getFinishedSpans()
        .every((span) => String(span.attributes["langfuse.observation.output"]).includes("partial")),
    ).toBe(true)
  }).pipe(
    Effect.provide(
      NodeSdk.layer(() => ({
        resource: { serviceName: "test" },
        spanProcessor: new SimpleSpanProcessor(Langfuse.selectedExporter(exporter)),
      })),
    ),
    Effect.runPromise,
  )
})

test("exports OTLP HTTP directly with Langfuse headers and flushes the batch", async () => {
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http")
  const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base")
  const requests: { path: string; auth: string | null; version: string | null; body: string }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        version: request.headers.get("x-langfuse-ingestion-version"),
        body: await request.text(),
      })
      return Response.json({})
    },
  })
  await using cleanup = { [Symbol.asyncDispose]: () => server.stop(true) }
  const config = await Langfuse.configuration(
    {
      LANGFUSE_PUBLIC_KEY: "pk-test",
      LANGFUSE_SECRET_KEY: "sk-test",
      LANGFUSE_BASE_URL: server.url.toString(),
    },
    async () => "",
    true,
  )
  expect(config).toBeDefined()
  const processor = new BatchSpanProcessor(Langfuse.selectedExporter(new OTLPTraceExporter(config)))
  Langfuse.activate(processor)
  await Effect.gen(function* () {
    yield* Langfuse.generation(Stream.make(LLMEvent.textDelta({ id: "text", text: "hello HTTP" })), {
      sessionID: "session-http",
      model: "test",
      provider: "test",
      request: { messages: ["hello"] },
    }).pipe(Stream.runDrain)
    yield* Effect.promise(Langfuse.flush)
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe("/api/public/otel/v1/traces")
    expect(requests[0].auth).toBe(`Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`)
    expect(requests[0].version).toBe("4")
    expect(requests[0].body).toContain("hello HTTP")
    expect(requests[0].body).not.toContain("sk-test")
  }).pipe(
    Effect.provide(
      NodeSdk.layer(() => ({
        resource: { serviceName: "test" },
        spanProcessor: processor,
      })),
    ),
    Effect.runPromise,
  )
})
