import { createMemo, onMount } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Locale } from "../../util/locale"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import { DialogHistory } from "./dialog-history"
import { useTheme } from "../../context/theme"

export function DialogTimeline(props: { sessionID: string; onMove: (messageID: string) => void }) {
  const data = useData()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = data.session.message.list(props.sessionID)
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      if (message.type === "assistant" && message.snapshot?.files?.length) {
        const option = result.at(-1)
        if (option) {
          option.gutter = (color) => (
            <text fg={color === theme.text.action.primary.focused ? color : theme.text.muted}>⎌</text>
          )
          option.detail = "This message changed files."
        }
      }
      if (message.type !== "user") continue
      result.push({
        title: message.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: (dialog) => {
          dialog.replace(() => <DialogMessage messageID={message.id} sessionID={props.sessionID} />)
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogHistory sessionID={props.sessionID} title="Timeline">
      <DialogSelect
        onMove={(option) => props.onMove(option.value)}
        title="Timeline"
        searchInTitle
        titlePlaceholder="Search timeline"
        options={options()}
      />
    </DialogHistory>
  )
}
