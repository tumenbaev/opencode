import { createEffect, on, onCleanup, Show, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Spinner } from "../../component/spinner"
import { useData } from "../../context/data"
import { DIALOG_LIST_INSET, DialogHeader, DialogLayout, useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"

export function DialogHistory(props: ParentProps<{ sessionID: string; title: string }>) {
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()
  const [state, setState] = createStore({ ready: false })

  createEffect(
    on(
      () => props.sessionID,
      (sessionID) => {
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        setState("ready", false)

        void (async () => {
          await data.session.message.sync(sessionID)
          if (controller.signal.aborted) return
          await data.session.message.loadMore(sessionID, { all: true, signal: controller.signal })
          if (!controller.signal.aborted) setState("ready", true)
        })().catch((error) => {
          if (controller.signal.aborted) return
          toast.error(error)
          dialog.clear()
        })
      },
    ),
  )

  return (
    <Show
      when={state.ready}
      fallback={
        <DialogLayout inset={DIALOG_LIST_INSET} header={<DialogHeader title={props.title} />}>
          <Spinner>Loading history…</Spinner>
        </DialogLayout>
      }
    >
      {props.children}
    </Show>
  )
}
