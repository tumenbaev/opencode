import type { SessionMessageInfo } from "@opencode/client/promise"
import { DialogProvider } from "@opencode/ui/context/dialog"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import type { SessionDocument } from "../src/document"
import { CurrentSessionProviders } from "../src/storybook/current-session-story"
import { timelinePresets } from "../src/timeline/detail"
import { SessionTimeline } from "../src/timeline/session-timeline"

export function mountSessionTrimming(preset: "compact" | "text-only") {
  const messages: SessionMessageInfo[] = [
    {
      id: "skill",
      type: "skill",
      skill: "review",
      name: "Original skill",
      text: "Original skill instructions",
      time: { created: 1 },
    },
    {
      id: "system",
      type: "system",
      text: "Original system instructions",
      description: "Original system label",
      metadata: { notice: "instructions", instructionSources: ["Original AGENTS.md"] },
      time: { created: 2 },
    },
    {
      id: "synthetic",
      type: "synthetic",
      text: "Original synthetic text",
      description: "Original subagent result",
      metadata: { source: "subagent", childID: "session_child_review", agent: "Original agent", state: "completed" },
      time: { created: 3 },
    },
    { id: "location", type: "location-switched", location: { directory: "/Original/location" }, time: { created: 4 } },
    {
      id: "model",
      type: "model-switched",
      model: { id: "Original model", providerID: "anthropic" },
      time: { created: 5 },
    },
    {
      id: "shell",
      type: "shell",
      shellID: "shell",
      command: "Original command",
      status: "exited",
      exit: 1,
      output: { output: "Original output", cursor: 15, size: 15, truncated: false },
      time: { created: 6, completed: 7 },
    },
    {
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { id: "claude-sonnet-4", providerID: "anthropic" },
      content: [{ type: "text", text: "Server-edited answer" }],
      time: { created: 8, completed: 9 },
    },
  ]

  const host = document.createElement("div")
  host.dataset.testid = "session-trimming-fixture"
  document.body.appendChild(host)

  render(() => {
    const [document, setDocument] = createStore<SessionDocument>({
      sessionID: "session_trimming",
      messages,
      status: { type: "idle" },
      diffs: [],
    })

    const replace = (suppress: boolean) =>
      setDocument("messages", (messages) =>
        messages.map((message) =>
          message.type === "assistant"
            ? message
            : {
                ...message,
                contextReplacement: suppress ? "" : `**Retained ${message.id}**\n\nשלום \`/repo/file.ts\``,
              },
        ),
      )

    return (
      <DialogProvider>
        <CurrentSessionProviders document={document}>
          <button onClick={() => replace(false)}>Replace history</button>
          <button onClick={() => replace(true)}>Suppress history</button>
          <SessionTimeline
            document={document}
            timelineDetail={timelinePresets.find((item) => item.id === preset)!.value}
          />
        </CurrentSessionProviders>
      </DialogProvider>
    )
  }, host)
}
