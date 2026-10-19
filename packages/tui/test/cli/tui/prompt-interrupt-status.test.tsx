/** @jsxImportSource @opentui/solid */
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { PromptInterruptStatus } from "../../../src/component/prompt"

test("interrupt status only renders the armed warning", async () => {
  const warning = RGBA.fromHex("#fbbf24")
  const [armed, setArmed] = createSignal(false)
  const app = await testRender(() => <PromptInterruptStatus armed={armed()} warning={warning} />, {
    width: 30,
    height: 1,
  })

  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("esc")

    setArmed(true)
    await app.renderOnce()
    const line = app.renderer.currentRenderBuffer.getSpanLines()[0]!

    expect(line.spans.map((span) => span.text).join("")).toContain("esc again to interrupt")
    expect(line.spans.filter((span) => span.text.trim()).every((span) => span.fg.equals(warning))).toBeTrue()
  } finally {
    app.renderer.destroy()
  }
})
