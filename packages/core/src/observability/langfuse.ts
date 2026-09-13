import { homedir } from "node:os"
import { parseEnv } from "node:util"
import { Effect, Stream } from "effect"
import type { LLMEvent, Usage } from "@opencode-ai/llm"
import type { SpanExporter } from "@opentelemetry/sdk-trace-base"

// Snapshot before application config loading. The credentials file cannot enable this feature.
const enabled = process.env.LANGFUSE === "true"
const environment = {
  LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
  LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
  LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL,
}
let configured = false
let processor: { forceFlush(): Promise<void> } | undefined

export async function configuration(
  env: Record<string, string | undefined> = environment,
  read = () => Bun.file(`${homedir()}/.config/opencode/langfuse.env`).text(),
  optIn = enabled,
) {
  if (!optIn) return
  const file: Record<string, string | undefined> = await read()
    .then((text) => parseEnv(text) as Record<string, string | undefined>)
    .catch(() => ({}))
  const publicKey = env.LANGFUSE_PUBLIC_KEY ?? file.LANGFUSE_PUBLIC_KEY
  const secretKey = env.LANGFUSE_SECRET_KEY ?? file.LANGFUSE_SECRET_KEY
  const base = env.LANGFUSE_BASE_URL ?? file.LANGFUSE_BASE_URL
  if (!publicKey || !secretKey || !base) return
  const url = URL.parse(base)
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    return
  return {
    url: `${url.href.replace(/\/+$/, "")}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    },
  }
}

// Filter at the exporter boundary, leaving the generic OTLP processor untouched.
export function selectedExporter(exporter: SpanExporter): SpanExporter {
  return {
    export(spans, callback) {
      const selected = spans.filter((span) => span.attributes["opencode.langfuse"] === true)
      if (!selected.length) return callback({ code: 0 })
      exporter.export(selected, callback)
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  }
}

export function activate(value?: { forceFlush(): Promise<void> }) {
  configured = true
  processor = value
}

/** Best effort before explicit CLI/worker exit; never hold shutdown indefinitely. */
export async function flush() {
  if (!processor) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    processor.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 2000)
    }),
  ])
  clearTimeout(timer)
}

const limit = 32_768

/** Bounded structural content capture, not arbitrary text secret redaction. */
export function content(value: unknown): string {
  let budget = limit
  let nodes = 2048
  const seen = new WeakSet<object>()
  function visit(value: unknown, depth: number): unknown {
    if (budget <= 0 || depth > 12 || --nodes <= 0) return "[truncated]"
    if (typeof value === "string") {
      if (/^data:.*;base64,/s.test(value)) return "[omitted]"
      const text = value.slice(0, budget)
      budget -= text.length
      return text
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") return value
    if (typeof value !== "object") return undefined
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) return "[omitted]"
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    if (Array.isArray(value)) return value.slice(0, 256).map((item) => visit(item, depth + 1))
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 256)
        .flatMap(([key, item]) => {
          if (
            /^(headers|authorization|apiKey|secretKey|providerMetadata|providerOptions|route|data|image|audio|base64)$/i.test(
              key,
            )
          )
            return []
          budget -= key.length
          return [[key, visit(item, depth + 1)]]
        }),
    )
  }
  // Keep the attribute valid JSON, including when escaping expands its size.
  const text = JSON.stringify(visit(value, 0)) ?? "null"
  return text.length <= limit ? text : JSON.stringify({ truncated: text.slice(0, (limit - 64) / 2) })
}

export function generation<E, R>(
  stream: Stream.Stream<LLMEvent, E, R>,
  input: { sessionID: string; model: string; provider: string; request: unknown | (() => unknown) },
) {
  if (!configured) return stream
  return Stream.unwrap(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan.pipe(Effect.orDie)
      let capturedInput = false
      let text = ""
      let reasoning = ""
      const tools: unknown[] = []
      let usage: Usage | undefined
      const captureInput = () => {
        if (capturedInput) return
        capturedInput = true
        span.attribute(
          "langfuse.observation.input",
          content(typeof input.request === "function" ? input.request() : input.request),
        )
      }
      return stream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            captureInput()
            if (event.type === "text-delta") text += event.text.slice(0, limit - text.length)
            if (event.type === "reasoning-delta") reasoning += event.text.slice(0, limit - reasoning.length)
            if (["tool-call", "tool-result", "tool-error"].includes(event.type) && tools.length < 64)
              tools.push(JSON.parse(content(event)))
            // Finish is authoritative; step-finish is a fallback, never added a second time.
            if ((event.type === "step-finish" || event.type === "finish") && event.usage) usage = event.usage
            if (event.type === "provider-error") {
              span.attribute("langfuse.observation.level", "ERROR")
              span.attribute("langfuse.observation.status_message", event.message.slice(0, 1024))
            }
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            captureInput()
            span.attribute("langfuse.observation.output", content({ text, reasoning, tools }))
            if (usage)
              span.attribute(
                "langfuse.observation.usage_details",
                JSON.stringify({
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  total: usage.totalTokens,
                }),
              )
          }),
        ),
      )
    }),
  ).pipe(
    Stream.withSpan("opencode.generation", {
      // A selected root avoids dangling parents from unexported internal Effect spans.
      root: true,
      attributes: {
        "opencode.langfuse": true,
        "langfuse.observation.type": "generation",
        "langfuse.observation.model.name": input.model,
        "langfuse.session.id": input.sessionID,
        "gen_ai.system": input.provider,
      },
    }),
  )
}

export * as Langfuse from "./langfuse"
