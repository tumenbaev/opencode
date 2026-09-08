# Context trimming (legacy sessions)

Trimming is an opt-in bundled plugin/service for the legacy session runner used by
the TUI. It reduces historical tool payloads before a new idle-session follow-up;
it does not replace compaction or change subagent finalization.

## Enable

Add this to `opencode.json`:

```json
{
  "trimming": {
    "enabled": true,
    "model": "openai/gpt-5.6-luna",
    "variant": "high",
    "threshold": 0.7
  }
}
```

Only `enabled` is needed to use the displayed defaults. The model uses OpenCode's
existing provider/authentication runtime, including Codex OAuth. There is no
fallback model or helper session. Automatic trimming is disabled when the section is absent.

## Manual trimming

The built-in TUI `/trim` action (also `POST /session/:sessionID/trim`) reviews the
current session without adding a user message or starting an assistant turn.
It silently does nothing when execution is active. Otherwise it acquires the
existing exclusive execution ownership for review and application; prompts arriving
during review can run afterward.

Manual trimming ignores `enabled` and the context-usage threshold; `enabled` controls
automatic trimming only. It uses the configured reviewer model and variant, with
the same defaults, 4,000-token group minimum, and safety checks as automatic trimming.
Progress and results use the existing toasts; no candidates produces
`No eligible context to trim`. Freshness is anchored to the snapshot's latest message
ID, including when that message is an assistant response. New messages invalidate
the review. No transcript message is added for progress or results.

## Behavior

- The latest completed response's usage must reach the configured fraction of the
  effective compaction threshold. No cache-expiry or elapsed-idle-time assumption
  is made.
- First prompts, retries/resumes, and prompts joining active execution do not
  trigger trimming. Session execution ownership is held during review.
- Candidate groups contain at least approximately 4,000 tokens of completed tool
  arguments and outputs. Nonempty conversational text and user turns separate
  groups; reasoning, UI “Thought” labels, and step markers do not. Reasoning does
  not count toward this minimum, but does count toward the review request cap.
- At most eight groups are reviewed concurrently, each with a 120-second timeout.
  The reviewer receives exactly `{before, content, after}`: the nearest nonempty
  text on either side and an ordered array of `{type: "reasoning", text}` or
  `{type: "tool", tool, args, output}` records. Readable reasoning is included from
  the before boundary through the after boundary, including before the first tool
  and after the last tool across assistant messages. Empty reasoning and opaque
  provider metadata are omitted; original reasoning parts are not changed.
  There is no reduction target.
- No separate originating prompt, eventual final response, or new follow-up is
  sent. Such text appears only when it is naturally a nearest text boundary; a
  new follow-up can therefore appear as `after`, not as an extra field. User turns,
  including empty turns, reset grouping. Noneligible tools, error records, and
  control records flush groups and are excluded from review content.
- The reviewer can keep a group or replace it with a factual note. Invalid,
  oversized, timed-out, and non-shrinking reviews leave their groups intact.
  Tools with attachments, incomplete tools, and already-pruned outputs are skipped.
- Replacement notes have no automatic prefix. Selected tool parts are replaced or
  removed in the stored transcript, so their tool cards also disappear from the UI.
  There is no trimming undo/retrieval feature. Existing event history is not purged.
- Plans are checked against current stored parts before application. A newer
  prompt arriving during review makes the plan obsolete.

The existing TUI toast displays progress and an aggregate result such as
`Context trimming complete: ~188k → ~91k tokens`. Both numbers use the same local
estimate of model-facing message history, not exact provider tokenization or
billing usage. System prompt/tool-definition overhead is not included. Statistics
and progress are UI-only; replacement notes are the only new model-facing content.
Toasts are workspace-scoped and transient.

The internal `Trimming.Input` accepts history, config, and optional usage, not a
`prompt` field. `Group.content` holds the ordered review records; `Group.user`
remains runtime metadata for provider execution and is not serialized into the
review JSON. Groups have no `originatingUser` or `finalResponse` fields.

## Safety and limitations

Review failure does not block normal execution; user interruption is preserved.
Each accepted group's note is written before redundant parts are removed, and
cancellation is deferred while that group is being applied. Existing event writes
are individually committed: a multi-part replacement is **not crash-atomic**. A
failure during application can leave a note alongside some redundant originals.

Compaction remains unchanged, including its use of previously reported usage.
Trimming therefore does not guarantee avoidance of compaction when that previous
usage already exceeds the compaction threshold. Trimming can also rebuild a warm
provider cache; savings depend on subsequent request reuse.
