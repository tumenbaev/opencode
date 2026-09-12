# Langfuse (optional)

Disabled by default. To opt in, set **`LANGFUSE=true` in the process environment** that runs the server/CLI:

```sh
LANGFUSE=true opencode
```

Only when opted in, OpenCode reads `~/.config/opencode/langfuse.env`:

```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

Use your deployment's base URL (including the appropriate region). Protect the file with `chmod 600`. Process environment credentials override individual file entries. Putting `LANGFUSE=true` in this file does **not** enable the feature. This integration does not load project `.env` files. When running source with Bun, use `bun --no-env-file ...` to prevent Bun itself from populating the process environment from project files. Missing/incomplete credentials or an invalid URL silently disable the integration; there is no one-time notice.

## What is sent

- Selected `opencode.generation` spans only, through the existing Effect/OpenTelemetry provider. No Langfuse SDK or collector is needed.
- Direct OTLP HTTP to `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces`, Basic authentication with `public:secret`, and `x-langfuse-ingestion-version: 4`.
- Session ID grouping, model/provider, system prompts and conversation history, assistant text/reasoning, and tool call/result content available in the normalized stream. Input/output attributes are bounded to 32,768 characters each, with additional depth/item limits.
- Provider usage uses inclusive input/output totals. Terminal usage replaces step usage rather than being added to it; cache/reasoning subsets are not counted again.

Generic OTLP trace export and OTLP logs keep their existing endpoints and behavior. Langfuse does not receive logs. With both exporters enabled, the generic exporter also sees these new generation spans.

## First-cut limits

- Covers the normal legacy AI SDK session path, its opt-in native adapter, and the V2 core runner. The span encloses stream consumption, not merely stream creation, and closes on failure/interruption. Legacy input is captured before request-preparation/plugin/provider transformations; it is not an exact wire request. Legacy tool definitions are names only.
- Each generation is an explicit root, grouped by session. Internal Effect/AI SDK spans are not forwarded; no reparenting or separate tool-span hierarchy. Tool content is embedded in generation output. V2 locally executed tool results are outside the provider stream and appear in the next turn's input history, if there is a next turn.
- Auxiliary model calls outside these session stream boundaries (such as V2 compaction and standalone agent generation) are not instrumented. No per-tool timing, cost computation, or advanced multi-step usage aggregation.
- Binary/media payload fields, base64 data URLs, transport headers, and provider metadata/options are omitted structurally. **Arbitrary text is not secret-redacted.** Prompts, source code, tool output, and reasoning may contain sensitive data; enable only for a trusted Langfuse deployment. Content can be truncated and is not a transcript backup.
- Normal CLI final exit and TUI worker shutdown attempt a bounded, two-second Langfuse batch flush. Provider-scope shutdown also uses normal OpenTelemetry cleanup. Abrupt exits, other direct `process.exit` paths, kills, export failures, and timeouts can lose spans; no durable queue or shutdown redesign.

For attached clients, configure and opt in on the **server process**, not only the client.
