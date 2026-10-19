import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"

const session = {
  id: "ses_trim_render",
  title: "Historical context",
  projectID: "proj_test",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function sessionResponse(url: URL, messages: SessionMessageInfo[] = []) {
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
  if (url.pathname === `/api/session/${session.id}/message`)
    return json({ data: messages.toReversed(), cursor: {} })
  if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
    return json({ data: [] })
}

test.each(["completed", "unchanged", "stale", "busy"] as const)(
  "/trim is a native action with a %s result and no model turn",
  async (status) => {
    const response = Promise.withResolvers<Response>()
    const requests: string[] = []
    await using setup = await createAppFixture({
      args: { sessionID: session.id },
      config: { animations: false, tabs: { mode: "on" } },
      fetch: (url, request) => {
        if (request.method === "POST") requests.push(url.pathname)
        if (url.pathname === `/api/session/${session.id}/trim`) return response.promise
        if (url.pathname === "/api/agent")
          return json({
            location: { directory },
            data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }],
          })
        if (url.pathname === "/api/provider")
          return json({ location: { directory }, data: [{ id: "provider", name: "Provider" }] })
        if (url.pathname === "/api/model")
          return json({
            location: { directory },
            data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
          })
        return sessionResponse(url)
      },
    })
    await setup.waitForFrame((frame) => frame.includes(session.title))
    await setup.mockInput.typeText("/trim")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Reviewing historical context"))
    expect(requests).toEqual([`/api/session/${session.id}/trim`])
    response.resolve(json({ data: { status, beforeTokens: 2000, afterTokens: 1000, groups: 2 } }))
    const title =
      status === "completed"
        ? "Historical context trimmed"
        : status === "unchanged"
          ? "No eligible historical context"
          : status === "stale"
            ? "Trim skipped: newer work arrived"
            : undefined
    const frame = await setup.waitForFrame((frame) =>
      title ? frame.includes(title) : !frame.includes("Reviewing historical context"),
    )
    if (title) {
      expect(frame).toContain("2.0K → 1.0K tokens")
      expect(frame).toContain("2 groups")
    } else {
      expect(frame).not.toContain("trimmed")
      expect(frame).not.toContain("tokens ·")
    }
    expect(requests).toEqual([`/api/session/${session.id}/trim`])
  },
)

test("standalone replacements render markdown without original notice labels or suppressed wrappers", async () => {
  const messages: SessionMessageInfo[] = [
    {
      id: "msg_skill",
      type: "skill",
      skill: "skill_secret",
      name: "secret-skill",
      text: "Original skill payload",
      time: { created: 1 },
      contextReplacement: "Historical **skill note**",
    },
    {
      id: "msg_system",
      type: "system",
      text: "Original instructions",
      description: "Old instruction label",
      time: { created: 2 },
      contextReplacement: "",
    },
    {
      id: "msg_location",
      type: "location-switched",
      location: { directory: "/hidden-location" },
      time: { created: 3 },
      contextReplacement: "Historical location note",
    },
    {
      id: "msg_synthetic",
      type: "synthetic",
      text: "Original hidden payload",
      time: { created: 4 },
      contextReplacement: "Historical synthetic note",
    },
  ]
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    fetch: (url) => sessionResponse(url, messages),
  })
  const frame = await setup.waitForFrame((frame) => frame.includes("Historical synthetic note"))
  expect(frame).toContain("skill note")
  expect(frame).toContain("Historical location note")
  expect(frame).not.toContain("secret-skill")
  expect(frame).not.toContain("Original")
  expect(frame).not.toContain("Old instruction label")
  expect(frame).not.toContain("Moved to")
  expect(frame).not.toContain("Notice")
})

test("trim revalidation rebuilds standalone visibility and assistant part groups", async () => {
  const original: SessionMessageInfo[] = [
    { id: "msg_skill", type: "skill", skill: "skill_old", name: "old-skill", text: "Original", time: { created: 1 } },
    {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      content: [{ type: "reasoning", text: "**Old reasoning group**", time: { created: 2, completed: 3 } }],
      time: { created: 2, completed: 3 },
    },
  ]
  const updated: SessionMessageInfo[] = [
    { ...original[0], contextReplacement: "" },
    {
      ...original[1],
      type: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "fixture" },
      content: [{ type: "text", text: "Historical assistant note" }],
    },
  ]
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    fetch: (url) => {
      const message = updated.find((message) => url.pathname === `/api/session/${session.id}/message/${message.id}`)
      if (message) return json({ data: message })
      return sessionResponse(url, original)
    },
  })
  await setup.waitForFrame((frame) => frame.includes("old-skill") && frame.includes("Old reasoning group"))
  setup.events.emit({
    id: "evt_trim_render",
    type: "session.context.trimmed",
    created: 4,
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: {
      sessionID: session.id,
      targets: original.map((message) => ({ messageID: message.id })),
      note: "Historical note",
    },
  })
  const frame = await setup.waitForFrame((frame) => frame.includes("Historical assistant note"))
  expect(frame).not.toContain("old-skill")
  expect(frame).not.toContain("Old reasoning group")
  expect(frame).not.toContain("Thought")
})
