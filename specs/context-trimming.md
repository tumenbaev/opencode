# Manual context trimming

Use the TUI `/trim` action or `POST /api/session/:sessionID/trim` to reduce historical
context without adding a user message or starting an assistant turn. There is no
automatic trimming.

## Configuration

The optional V2 configuration selects the reviewer using the normal model-selection
syntax:

```json
{
  "trimming": {
    "model": "openai/gpt-6-luna#high"
  }
}
```

This is also the default when the section is absent. The explicit provider/model/
variant object form is supported. There are no `enabled` or `threshold` settings.
The reviewer uses the configured provider runtime and request/authentication hooks;
there is no fallback model or helper session. Built-in compaction is independent;
disable its automatic policy separately if desired.

## Selection and review

The following are preserved anchors that split groups:

- Real user messages, including empty turns and their attachments.
- Every nonempty assistant text segment, including commentary before further work.
- Foreground subagent responses and background subagent notifications.

Intervals between anchors are reviewable when they contain approximately 4,000 or
more tokens of readable material. Missing surrounding text at the beginning or end
of history is represented by an empty string. Candidates include ordinary tools,
errors, abandoned calls, reasoning, shell results (including user-executed shell
output), synthetic notifications, skill bodies, instruction updates, location/model
notices, and textual compaction checkpoints. Bookkeeping is transparent. Opaque
native checkpoints are not reviewed or expanded.

The reviewer receives exactly `{before, content, after}`: the nearest anchor text
and ordered text-only candidate records. Tool arguments, textual results, and errors
are included. Attachments and opaque provider metadata are omitted. Attachment
presence does not exclude a group; replacing a tool may also remove its attachment
content from active context. The reviewer must not invent unseen attachment content.

Up to eight groups are reviewed concurrently, each with a 120-second timeout. A
group exceeding the reviewer input budget is retained. The reviewer may keep a
group or supply a shorter historical note. Invalid, incomplete, failed, timed-out,
empty, and non-shrinking reviews retain the original group. Some detail loss is
intentional; this is not exhaustive instruction or evidence preservation.

## Ownership and persistence

Manual trimming atomically reserves idle-only ownership through the existing
session coordinator. Busy sessions silently skip it. The reservation creates no
execution claim or transcript lifecycle marker and does not resume after restart.
The server owns an accepted operation even if its requesting client disconnects.
The ordinary interrupt operation can cancel it.

Pending inbox work prevents review. New input or other concurrent durable session
changes invalidate remaining proposals, including inputs not yet promoted into
visible history. Newly admitted work can execute after maintenance releases.

Accepted groups are applied from newest to oldest, one transactional durable
`session.context.trimmed` event per group. Selected assistant parts are replaced or
removed in place; assistant message identity, completion state, usage, and snapshots
remain. Standalone rows retain their original payload and identity for delivery
reconciliation, with `contextReplacement` defining their effective content:

- Absent: original content.
- Nonempty: historical replacement note only.
- Empty string: no model-facing or normally displayed content.

Clients refresh affected loaded messages, including paginated history. Notes occupy
the original historical position; replaced tool cards and suppressed notices
disappear. Original payloads may remain accessible through raw APIs/exports. This
is context reduction, not storage erasure or redaction. Event payload retention
itself depends on the server's existing event persistence setting.

Historical provider usage remains unchanged for billing, but measurements covering
pre-trim history are invalidated for request sizing until a fresh provider response.
Stateful transport continuation is closed after accepted changes.

## Limitations

- No undo or original-content retrieval feature.
- Atomicity is per group, not across the complete operation; earlier committed
  groups survive a later failure or cancellation.
- Forks copy the current effective history and remain independent. Revert uses its
  ordinary message boundary and does not undo a trim. A cut through a summarized
  interval can retain a note about later material or remove a note while leaving
  suppressed records.
- Operational model/location/instruction state is not reset. Shortened historical
  skill/instruction text is not automatically restored or reinjected.
- Progress and aggregate statistics are transient UI notifications. Token figures
  are local readable-history estimates, exclude system/tool-catalog overhead and
  attachment costs, and are not provider billing measurements.
- Trimming can rebuild a warm provider cache and incurs reviewer cost. It does not
  promise to eliminate the need for eventual compaction.
