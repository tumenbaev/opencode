import { createMemo, For, Show, createEffect, on, onMount, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { SessionInfo } from "@opencode/client"
import { useRoute, useRouteData } from "../../../context/route"
import { useData } from "../../../context/data"
import { useClient } from "../../../context/client"
import { useTheme } from "../../../context/theme"
import { Locale } from "../../../util/locale"
import { Keymap } from "../../../context/keymap"
import { useComposerTab } from "./context"
import { withTimestampedFallback } from "@opencode/util/session-title-fallback"
import { sessionFamily } from "../../../util/session"

interface SubagentEntry {
  sessionID: string
  agent: string
  title: string
  status: string
  current: boolean
  prefix: string
}

export function SubagentsTab(props: { sessionID: string }) {
  const renderer = useRenderer()
  const route = useRouteData("session")
  const data = useData()
  const client = useClient()
  const theme = useTheme()
  const navigate = useRoute().navigate
  const composer = useComposerTab()

  const session = createMemo(() => data.session.get(props.sessionID))
  const [store, setStore] = createStore({ selected: 0, sessionID: "" })

  const entries = createMemo<SubagentEntry[]>(() => {
    const current = session()
    if (!current) return []

    return sessionFamily<SessionInfo>(data.session.list(), current.id).map(({ session, prefix }): SubagentEntry => {
      const title = withTimestampedFallback(session)
      const agentMatch = title.match(/@(\w+) subagent/)
      return {
        sessionID: session.id,
        agent: session.agent
          ? Locale.titlecase(session.agent)
          : agentMatch
            ? Locale.titlecase(agentMatch[1])
            : "Subagent",
        title: agentMatch ? title.replace(agentMatch[0], "").trim() || title : title,
        status: data.session.status(session.id),
        current: session.id === route.sessionID,
        prefix,
      }
    })
  })

  let wasActive = false
  let scroll: ScrollBoxRenderable | undefined

  const selectedEntry = createMemo(() => entries()[store.selected])

  createEffect(
    on(
      () => [composer.active("subagents"), entries()] as const,
      ([active, list]) => {
        if (!active) {
          wasActive = false
          return
        }
        if (list.length === 0) return
        const initial = !wasActive
        const selectedID = initial ? route.sessionID : store.sessionID
        const index = list.findIndex((entry) => entry.sessionID === selectedID)
        const next = index >= 0 ? index : initial ? 0 : Math.min(store.selected, list.length - 1)
        wasActive = true
        moveTo(next, true)
        if (initial) {
          // The remounted scrollbox finishes layout on the next frame and resets its scroll position.
          renderer.requestAnimationFrame(() =>
            renderer.requestAnimationFrame(() => scrollToIndex(store.selected, true)),
          )
        }
      },
    ),
  )

  function moveTo(next: number, center = false) {
    setStore({ selected: next, sessionID: entries()[next]?.sessionID ?? "" })
    scrollToIndex(next, center)
  }

  function cycle(direction: number) {
    const list = entries()
    if (list.length === 0) return
    const current = list.findIndex((entry) => entry.current)
    const index =
      current < 0 ? (direction > 0 ? 0 : list.length - 1) : (current + direction + list.length) % list.length
    const entry = list[index]!
    if (!entry.current) navigate({ type: "session", sessionID: entry.sessionID })
  }

  function scrollToIndex(index: number, center: boolean) {
    if (!scroll) return
    if (center) {
      scroll.scrollTo(Math.max(0, index - Math.floor(scroll.viewport.height / 2)))
      return
    }
    if (index >= scroll.scrollTop + scroll.viewport.height) {
      scroll.scrollTo(index - scroll.viewport.height + 1)
    }
    if (index < scroll.scrollTop) {
      scroll.scrollTo(index)
      if (index === 0) scroll.scrollTo(0)
    }
  }

  onMount(() => {
    const cleanup = composer.register({
      id: "subagents",
      label: "Subagents",
    })
    onCleanup(cleanup)
  })

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => composer.active("subagents"),
    priority: 1,
    commands: [
      {
        id: "composer.subagent.up",
        title: "Previous subagent",
        group: "Composer",
        run() {
          if (store.selected === 0) {
            composer.close()
            return
          }
          moveTo(store.selected - 1, true)
        },
      },
      {
        id: "composer.subagent.down",
        title: "Next subagent",
        group: "Composer",
        run() {
          const list = entries()
          if (list.length === 0) return
          moveTo(Math.min(store.selected + 1, list.length - 1), true)
        },
      },
      {
        id: "composer.subagent.select",
        title: "Navigate to subagent",
        group: "Composer",
        run() {
          const entry = entries()[store.selected]
          if (entry) navigate({ type: "session", sessionID: entry.sessionID })
        },
      },
      {
        id: "session.child.previous",
        title: "Go to previous child session",
        group: "Composer",
        run: () => cycle(-1),
      },
      {
        id: "session.child.next",
        title: "Go to next child session",
        group: "Composer",
        run: () => cycle(1),
      },
      {
        id: "composer.subagent.interrupt",
        title: "Interrupt subagent",
        group: "Composer",
        run() {
          const entry = selectedEntry()
          if (!entry || entry.status !== "running") return
          void client.api.session.interrupt({ sessionID: entry.sessionID })
        },
      },
    ],
  }))

  return (
    <Show when={composer.active("subagents")}>
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={4} ref={(r: ScrollBoxRenderable) => (scroll = r)}>
        <Show when={entries().length > 0} fallback={<text fg={theme.text.muted}> No subagents</text>}>
          <For each={entries()}>
            {(entry, index) => {
              const active = createMemo(() => index() === store.selected)
              return (
                <box
                  flexDirection="row"
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    active()
                      ? theme.background.action.primary.focused
                      : entry.current
                        ? theme.background.action.primary.selected
                        : theme.background.action.primary.base
                  }
                  onMouseMove={() => moveTo(index())}
                  onMouseUp={() => {
                    moveTo(index())
                    navigate({ type: "session", sessionID: entry.sessionID })
                  }}
                >
                  <box flexGrow={1} minWidth={0} flexDirection="row">
                    <text
                      fg={
                        active()
                          ? theme.text.action.primary.focused
                          : entry.current
                            ? theme.text.action.primary.selected
                            : theme.text.action.primary.base
                      }
                      attributes={active() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                    >
                      {entry.prefix}
                      {entry.agent}: {entry.title}
                      <Show when={entry.status === "running"}>
                        <span style={{ fg: active() ? theme.text.action.primary.focused : theme.text.muted }}>
                          {" [running]"}
                        </span>
                      </Show>
                    </text>
                  </box>
                </box>
              )
            }}
          </For>
        </Show>
      </scrollbox>
    </Show>
  )
}
