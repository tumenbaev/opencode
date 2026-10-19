import { expect, sourceURL, story } from "../../storybook/playwright/story"

const fixture = sourceURL(new URL("./session-trimming.fixture.tsx", import.meta.url))

for (const direction of ["ltr", "rtl"] as const) {
  for (const preset of ["compact", "text-only"] as const) {
    story(`renders only effective history in ${preset}, ${direction}`, async ({ mount, page }) => {
      await page.setViewportSize({ width: 1200, height: 900 })
      await mount("current-session-timeline-rows--conversation")
      await page.evaluate(
        async ({ fixture, preset, direction }) => {
          document.documentElement.dir = direction
          const { mountSessionTrimming } = await import(fixture)
          mountSessionTrimming(preset)
        },
        { fixture, preset, direction },
      )

      const root = page.getByTestId("session-trimming-fixture")
      const timeline = root.locator('[data-component="session-timeline"]')
      await root.getByRole("button", { name: "Replace history", exact: true }).click()

      for (const id of ["skill", "system", "synthetic", "location", "model", "shell"]) {
        const note = timeline.locator('[data-component="markdown"]').filter({ hasText: `Retained ${id}` })
        await expect(note.locator("strong")).toHaveText(`Retained ${id}`)
        await expect(note).toHaveAttribute("dir", "auto")
        await expect(note.locator("code")).toHaveText("/repo/file.ts")
      }

      await expect(timeline).not.toContainText("Original")
      await expect(timeline.locator('[data-slot="session-timeline-notice"]')).toHaveCount(0)
      await expect(timeline.locator('[data-component="context-tool-group"]')).toHaveCount(0)
      await expect(timeline.getByRole("link")).toHaveCount(0)
      await expect(timeline).toContainText("Server-edited answer")

      await root.getByRole("button", { name: "Suppress history", exact: true }).click()
      await expect(timeline.locator("[data-timeline-row]")).toHaveCount(1)
      await expect(timeline.locator("[data-timeline-row]")).toHaveAttribute("data-timeline-row", "AssistantPart")
      await expect(timeline.locator('[data-component="markdown"]')).toHaveText("Server-edited answer")
      await expect(timeline).not.toContainText("Original")

      await root.getByRole("button", { name: "Replace history", exact: true }).click()
      await expect(timeline.locator('[data-timeline-row="Notice"]')).toHaveCount(6)
      await expect(timeline).not.toContainText("Original")
    })
  }
}
