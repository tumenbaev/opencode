import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["patch", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  // Fork: the default prompt uses short dedicated-tool guidance instead of edit coaching.
  // expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
  expect(prompt).toContain("patch (not sed/awk or echo/cat)")
})
