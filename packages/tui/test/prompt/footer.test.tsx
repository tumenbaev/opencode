import { expect, test } from "bun:test"
import { SpinnerRenderable } from "../../src/component/spinner-renderable"
import { createAppFixture } from "../fixture/app"
import { directory, json } from "../fixture/tui-client"

test.each([false, true])("footer keeps usage stable across running and idle (animations: %s)", async (animations) => {
  const session = {
    id: "ses_footer",
    title: "Footer layout",
    projectID: "proj_test",
    location: { directory },
    cost: 1,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    width: 120,
    config: { animations, tabs: { enabled: false } },
    args: { sessionID: session.id },
    fetch: (url) => {
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/active") return json({ data: { [session.id]: { type: "running" } } })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
    },
  })
  await setup.ready
  await setup.waitForFrame(
    (frame) => frame.includes("$1.00") && frame.includes("ctrl+p commands") && frame.includes(directory),
  )
  const footer = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((line) => line.includes("ctrl+p commands"))!
  const initial = footer()
  const progress = setup.renderer.root.findDescendantById("prompt.footer.progress")!
  const spinner = progress.getChildren()[0]
  if (animations) {
    expect(spinner).toBeInstanceOf(SpinnerRenderable)
  } else {
    expect(initial).toContain("[⋯]")
  }
  expect(initial).toContain("$1.00")
  expect(initial).toContain(directory)
  expect(progress.x).toBeLessThan(initial.indexOf("$1.00"))
  expect(initial.indexOf("$1.00")).toBeLessThan(initial.indexOf(directory))
  expect(initial.indexOf(directory)).toBeLessThan(initial.indexOf("ctrl+p commands"))
  expect(initial).not.toContain("esc")

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => frame.includes("esc again to interrupt"))
  const armed = footer()
  expect(armed).toContain("$1.00")
  expect(armed.indexOf("$1.00")).toBeLessThan(armed.indexOf("esc again to interrupt"))
  expect(armed.indexOf("esc again to interrupt")).toBeLessThan(armed.indexOf(directory))

  setup.events.emit({
    id: "evt_footer_idle",
    created: 1,
    type: "session.execution.succeeded",
    durable: { aggregateID: session.id, seq: 1, version: 1 },
    data: { sessionID: session.id },
  })
  await setup.waitForFrame((frame) => !frame.includes("esc again to interrupt"))
  await setup.waitForVisualIdle({ quietFrames: 3 })
  expect(setup.renderer.root.findDescendantById("prompt.footer.progress")).toBe(progress)
  expect(footer().indexOf("$1.00")).toBe(initial.indexOf("$1.00"))
  if (animations) {
    expect(footer()).toContain("⬝⬝⬝⬝⬝⬝⬝⬝")
    expect(footer()).not.toContain("■")
  } else expect(footer()).toContain("[⋯]")
})
