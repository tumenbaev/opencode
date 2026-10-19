import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionMessageInfo } from "../src/promise"

const sessionID = "ses_trim"
const original = (id: string): SessionMessageInfo => ({
  id,
  type: "system",
  text: `Original ${id}`,
  time: { created: 1 },
})

function fixture(fetch: (url: URL) => Promise<Response> | Response) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: (input, init) => fetch(new URL((input instanceof Request ? input : new Request(input, init)).url)),
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  return {
    ...setup,
    trim(ids: string[]) {
      const event: OpenCodeEvent = {
        id: "evt_trim",
        created: 2,
        type: "session.context.trimmed",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID, targets: ids.map((messageID) => ({ messageID })), note: "Historical note" },
      }
      listeners.forEach((listener) => listener({ name: event.type, details: event }))
    },
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(1)
  }
  expect(check()).toBe(true)
}

test("trim refreshes only affected loaded rows, including older pages, preserving raw metadata and cursor", async () => {
  const requests: string[] = []
  const replacements = new Map<string, string>([
    ["msg_old", "Historical note"],
    ["msg_new", ""],
  ])
  const setup = fixture((url) => {
    requests.push(url.pathname)
    if (url.pathname.endsWith("/message"))
      return Response.json({
        data: [original(url.searchParams.has("cursor") ? "msg_old" : "msg_new")],
        cursor: { next: url.searchParams.has("cursor") ? "oldest" : "older" },
      })
    const id = url.pathname.split("/").at(-1)!
    return Response.json({ data: { ...original(id), contextReplacement: replacements.get(id) } })
  })
  try {
    await setup.data.session.message.sync(sessionID)
    await setup.data.session.message.loadMore(sessionID)
    setup.trim(["msg_old", "msg_new", "msg_unloaded"])
    await until(() => setup.data.session.message.get(sessionID, "msg_new")?.contextReplacement === "")
    expect(setup.data.session.message.list(sessionID)).toEqual([
      { ...original("msg_old"), contextReplacement: "Historical note" },
      { ...original("msg_new"), contextReplacement: "" },
    ])
    expect(setup.data.session.message.more(sessionID)).toBe(true)
    expect(requests).toEqual([
      `/api/session/${sessionID}/message`,
      `/api/session/${sessionID}/message`,
      `/api/session/${sessionID}/message/msg_old`,
      `/api/session/${sessionID}/message/msg_new`,
    ])
  } finally {
    setup.dispose()
  }
})

test.each(["initial", "older"] as const)(
  "trim waits for an in-flight %s history page before revalidation",
  async (page) => {
    const pending = Promise.withResolvers<Response>()
    let gets = 0
    const setup = fixture((url) => {
      if (!url.pathname.endsWith("/message")) {
        gets++
        return Response.json({ data: { ...original("msg_target"), contextReplacement: "Updated history" } })
      }
      if (page === "initial" || url.searchParams.has("cursor")) return pending.promise
      return Response.json({ data: [original("msg_new")], cursor: { next: "older" } })
    })
    try {
      if (page === "older") await setup.data.session.message.sync(sessionID)
      const loading =
        page === "initial" ? setup.data.session.message.sync(sessionID) : setup.data.session.message.loadMore(sessionID)
      setup.trim(["msg_target"])
      expect(gets).toBe(0)
      pending.resolve(Response.json({ data: [original("msg_target")], cursor: {} }))
      await loading
      await until(
        () => setup.data.session.message.get(sessionID, "msg_target")?.contextReplacement === "Updated history",
      )
      expect(gets).toBe(1)
    } finally {
      setup.dispose()
    }
  },
)

test("successive trim reads are serialized and unloaded targets are not fetched", async () => {
  const pending = Promise.withResolvers<Response>()
  let gets = 0
  const setup = fixture((url) => {
    if (url.pathname.endsWith("/message")) return Response.json({ data: [original("msg_target")], cursor: {} })
    gets++
    if (gets === 1) return pending.promise
    return Response.json({ data: { ...original("msg_target"), contextReplacement: "Latest note" } })
  })
  try {
    await setup.data.session.message.sync(sessionID)
    setup.trim(["msg_target"])
    await until(() => gets === 1)
    setup.trim(["msg_target"])
    expect(gets).toBe(1)
    pending.resolve(Response.json({ data: { ...original("msg_target"), contextReplacement: "First note" } }))
    await until(() => setup.data.session.message.get(sessionID, "msg_target")?.contextReplacement === "Latest note")
    expect(gets).toBe(2)
    setup.data.session.evict(sessionID)
    setup.trim(["msg_target"])
    await Bun.sleep(5)
    expect(gets).toBe(2)
    expect(setup.data.session.message.list(sessionID)).toEqual([])
  } finally {
    setup.dispose()
  }
})

test("trim responses do not resurrect rows evicted while revalidation was pending", async () => {
  const pending = Promise.withResolvers<Response>()
  let reading = false
  const setup = fixture((url) => {
    if (url.pathname.endsWith("/message")) return Response.json({ data: [original("msg_target")], cursor: {} })
    reading = true
    return pending.promise
  })
  try {
    await setup.data.session.message.sync(sessionID)
    setup.trim(["msg_target"])
    await until(() => reading)
    setup.data.session.evict(sessionID)
    pending.resolve(Response.json({ data: { ...original("msg_target"), contextReplacement: "Historical note" } }))
    await Bun.sleep(5)
    expect(setup.data.session.message.list(sessionID)).toEqual([])
    expect(setup.data.session.message.get(sessionID, "msg_target")).toBeUndefined()
  } finally {
    setup.dispose()
  }
})
