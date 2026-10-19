# Child-session soft context budget

Child sessions receive an early wrap-up instruction before reaching the built-in compaction budget. This is a soft scope limit, not a tool cutoff, step limit, spending cap, or replacement for compaction.

## Threshold

- Applies only to sessions with a parent.
- Uses the built-in compaction context estimate: the latest valid provider measurement plus estimated content added afterward, or the existing fallback estimate when no valid measurement exists.
- Reaches the soft budget at **80% of the configured compaction ceiling**, including its normal buffer. For example, a 100k context window with the default 16k reserve has an 84k compaction ceiling and a 67.2k soft budget.
- No new enable flag, model setting, or threshold configuration. The soft budget still applies when automatic compaction is disabled.
- Unknown or nonpositive usable limits do not trigger it.

The runner checks before ordinary model requests, ahead of automatic compaction. A successfully completed response can also reach the budget through its reported input, cache, output, and reasoning usage. That response and the reached marker are committed together. Session-wide cumulative usage is not used.

## Wrap-up

When another normal model request is needed after reaching the budget, the runner appends a durable synthetic context note. It asks for bounded completion, narrowly necessary verification, verified results, unresolved issues, and an honest handoff instead of more exploration or delegation.

- Tools remain available under ordinary permission and step rules.
- The note does not enter the inbox, reset the step allowance, or create an additional model request.
- The initial system prefix is unchanged.
- If the threshold-crossing response is already final, no additional response is requested to deliver the note.
- The note's metadata is the deduplication marker in loaded history. There is no separate wrap-up lifecycle or reminder-state table.

## Follow-ups and results

New subagent tool calls targeting an exhausted child fail before switching its agent/model, reporting running progress, admitting a prompt, or starting a job. The check is a normal tool-level guard, not an atomic cutoff for calls already in flight.

Already-admitted work, including pending follow-ups, is allowed to finish. Direct user prompts are unrestricted. Starting a fresh child is unaffected.

Foreground results and background completion delivery append this notice separately from the child's answer:

> This worker reached its context budget and is no longer available for task follow-ups.

The child transcript and stored job output are not rewritten to add the notice.

## Persistence and boundaries

The reached fact is an internal durable Session event projected into a private boolean on the Session row. It is not inherited metadata or a public Session-info field. Newly created children start unlatched. Ordinary restart/replay retains the latch and existing reminder note.

Compaction is unchanged. A large result may jump over both thresholds, and compaction may run during wrap-up. Post-latch compaction, trimming, and revert interactions have no special preservation, reminder-restoration, or exactly-once provider-delivery guarantees. Deduplication only examines loaded history, not the full durable event log.

The event is excluded from the public live-event manifest but remains part of the existing durable session-log contract. Generated clients include that log variant; there is no new endpoint or UI control.
