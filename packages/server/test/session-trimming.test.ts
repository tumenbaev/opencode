import { expect } from "bun:test"
import { SessionID } from "@opencode/schema/session-id"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("manual trim uses the real session API without adding input or an assistant turn", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-manual-trim-")))
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: tmp.path } }),
        }),
      ),
    )
    expect(created.status).toBe(200)
    const {
      data: { id },
    } = Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: SessionID }) }))(
      yield* Effect.promise(() => created.json()),
    )
    const readMessages = () =>
      Effect.promise(async () => {
        const response = await handler(new Request(`http://opencode.local/api/session/${id}/message`))
        return response.json()
      })
    const before = yield* readMessages()
    const response = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session/${id}/trim`, { method: "POST" })),
    )
    expect(response.status).toBe(200)
    expect(yield* Effect.promise(() => response.json())).toEqual({
      data: { status: "unchanged", beforeTokens: 0, afterTokens: 0, groups: 0 },
    })
    expect(yield* readMessages()).toEqual(before)
    expect(yield* readMessages()).toMatchObject({ data: [] })
    const missing = yield* Effect.promise(() =>
      handler(new Request(`http://opencode.local/api/session/${SessionID.create()}/trim`, { method: "POST" })),
    )
    expect(missing.status).toBe(404)
  }),
)
