import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, Show } from "solid-js"
import { contextUsage, formatContextUsage } from "../../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { useInteractivity } from "../../context/interactivity"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type FooterProps = {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  showDetails: boolean
}

export function PromptFooterStatus(props: FooterProps) {
  const [liveHovered, setLiveHovered] = createSignal(false)
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.session
      .family(props.sessionID)
      .filter((id) => id !== props.sessionID && props.context.data.session.status(id) === "running").length
    return count ? `${count} subagent${count === 1 ? "" : "s"}` : undefined
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.shell
      .list(props.context.location)
      .filter((shell) => shell.metadata.sessionID === props.sessionID).length
    return count ? `${count} shell${count === 1 ? "" : "s"}` : undefined
  })
  const status = createMemo(() => {
    if (!props.sessionID) return []
    const session = props.context.data.session.get(props.sessionID)
    if (!session) return []
    const usage = contextUsage(
      props.context.data.session.message.list(props.sessionID),
      props.context.data.location.model.list(session.location),
      session.revert?.messageID,
    )
    const cost = props.context.data.session.cost(props.sessionID)
    return [
      usage ? formatContextUsage(usage.tokens, usage.percent) : undefined,
      cost > 0 ? money.format(cost) : undefined,
    ].filter((item): item is string => Boolean(item))
  })
  const live = createMemo(() => Boolean(subagents() || shells()))
  const shortcut = (id: string) => props.context.keymap.shortcuts(id)[0]

  return (
    <Show when={props.mode === "normal" && (live() || (props.showDetails && status().length > 0))}>
      <box flexDirection="row" flexShrink={1} minWidth={0}>
        <Show when={props.showDetails && status().length > 0}>
          <text fg={props.context.theme.text.muted} wrapMode="none" truncate flexShrink={1}>
            {status().join(" · ")}
            <Show when={live()}> · </Show>
          </text>
        </Show>
        <Show when={live()}>
          <box
            flexShrink={0}
            onMouseOver={() => setLiveHovered(true)}
            onMouseOut={() => setLiveHovered(false)}
            onMouseUp={() => props.context.keymap.dispatch("session.child.first")}
          >
            <text fg={liveHovered() ? props.context.theme.text.base : props.context.theme.text.muted} wrapMode="none">
              <Show when={shortcut("session.child.first")}>
                {(value) => <span style={{ fg: props.context.theme.text.base }}>{value()} </span>}
              </Show>
              <Show when={subagents()}>{(value) => <>{value()}</>}</Show>
              <Show when={subagents() && shells()}> · </Show>
              <Show when={shells()}>{(value) => <>{value()}</>}</Show>
            </text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export function PromptFooter(props: FooterProps) {
  const dimensions = useTerminalDimensions()
  // Prompt hints read as disabled while the session does not own input, e.g. while a side panel is focused.
  const interactive = useInteractivity()
  const command = () => props.context.keymap.shortcuts("command.palette.show")[0]

  return (
    <Show
      when={props.mode === "normal"}
      fallback={
        <text fg={props.context.theme.text.base} flexShrink={0}>
          esc{" "}
          <span style={{ fg: props.context.theme.text.muted }}>
            {dimensions().width < 44 ? "shell" : "exit shell mode"}
          </span>
        </text>
      }
    >
      <Show when={props.showDetails && dimensions().width >= 44 && command()}>
        <text
          fg={interactive() ? props.context.theme.text.base : props.context.theme.text.action.primary.disabled}
          attributes={interactive() ? 0 : TextAttributes.DIM}
          wrapMode="none"
          flexShrink={0}
        >
          {command()} <span style={interactive() ? { fg: props.context.theme.text.muted } : {}}>commands</span>
        </text>
      </Show>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.prompt.footer",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer.status",
      render: (props) => (
        <PromptFooterStatus
          context={context}
          sessionID={props.sessionID}
          mode={props.mode}
          showDetails={props.showDetails}
        />
      ),
    })
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => (
        <PromptFooter context={context} sessionID={props.sessionID} mode={props.mode} showDetails={props.showDetails} />
      ),
    })
  },
})
