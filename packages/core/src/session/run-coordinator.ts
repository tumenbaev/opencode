export * as SessionRunCoordinator from "./run-coordinator.js"

import { Deferred, Effect, Exit, Fiber, FiberSet, Option, Scope } from "effect"
import type { Promotable } from "./inbox.js"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E, Reason = never> {
  /** Snapshots keys with an execution or maintenance reservation owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Checks execution or maintenance ownership for one key, including cleanup and terminal settlement. */
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts or joins normal execution; during maintenance requests a forced successor after cleanup. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /**
   * Reserves an idle key without execution lifecycle hooks. Returns none when busy.
   * The coordinator owns the operation: disconnecting its waiter does not cancel it.
   * Wakes and explicit runs wait for cleanup before starting normal execution.
   */
  readonly maintenance: <A, E2, R>(key: Key, effect: Effect.Effect<A, E2, R>) => Effect.Effect<Option.Option<A>, E2, R>
  /** Rings the doorbell: an idle key starts an execution; an active one drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /**
   * Stops the active owner and clears an execution's doorbell (maintenance retains wakes).
   * No-op when idle. Resolves once interruption is accepted, not when cleanup settles:
   * the owner finishes its finalizers and any settled hook on its own time. Returns whether
   * an active owner was interrupted. Compose with `awaitIdle` for settlement.
   */
  readonly interrupt: (key: Key, reason?: Reason) => Effect.Effect<boolean>
  /** Resolves once no execution or maintenance is active. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell: work recorded during the
 * execution rings it with the scope that work needs, and the execution loop drains again
 * instead of ending. The doorbell closes the gap between a drain's last eligibility check
 * and the idle transition, since those cannot be one atomic step. `done` resolves joiners
 * with this execution's exit.
 * Maintenance uses the same ownership record, but `done` only signals cleanup; its
 * generic result has a separate deferred, and `pendingRun` requests a forced successor.
 */
type Execution<E, Reason> = {
  readonly kind: "execution" | "maintenance"
  readonly done: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  scope: Promotable
  pendingWake?: Promotable
  pendingRun?: Deferred.Deferred<void, E>
  stopping: boolean
  interruptionReason?: Reason
}

/**
 * ```text
 *              wake | run
 *      idle ──────────────▶ execution (one fiber)
 *                             drain ⟲ doorbell rung mid-drain
 *                             │ exit (settled hook runs)
 *      doorbell quiet ◀───────┴───────▶ doorbell rung
 *      idle, waiters get exit          successor execution,
 *                                      waiters get this exit
 * ```
 */
export const make = <Key, E, Reason = never>(options: {
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  /** Runs once when a process-local busy period begins, before its first drain. */
  readonly started?: (key: Key) => Effect.Effect<void>
  /**
   * Runs in the execution fiber for every exit, including interruption, after the final
   * drain and before the execution settles (waiters resolve after it completes).
   */
  readonly settled?: (key: Key, exit: Exit.Exit<void, E>, reason?: Reason) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<E, Reason>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const loop = (key: Key, execution: Execution<E, Reason>, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (execution.stopping || execution.pendingWake === undefined) return Effect.void
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined
            // Trampoline so drains that complete synchronously cannot grow the stack.
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          }),
        ),
      )

    const start = (key: Key, force: boolean, scope: Promotable, done = Deferred.makeUnsafe<void, E>()) => {
      const execution: Execution<E, Reason> = {
        kind: "execution",
        done,
        scope,
        stopping: false,
      }
      executions.set(key, execution)
      // The leading yield lets `owner` be assigned before the drain can settle, and keeps
      // failing self-waking executions from growing the stack across successor starts.
      // Drains start one tick after wake; callers observe progress through events or run.
      execution.owner = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(Effect.uninterruptible(options.started?.(key) ?? Effect.void)),
          Effect.andThen(loop(key, execution, force)),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              execution.owner = undefined
            }).pipe(Effect.andThen(options.settled?.(key, exit, execution.interruptionReason) ?? Effect.void)),
          ),
          Effect.onExit((exit) => Effect.sync(() => settle(key, execution, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      return execution
    }

    // A doorbell that survives the execution loop (rung after the loop decided to end, or
    // during failure or interruption cleanup) starts a fresh execution for the remaining work.
    const settle = (key: Key, execution: Execution<E, Reason>, exit: Exit.Exit<void, E>) => {
      if (execution.pendingWake) start(key, false, execution.pendingWake)
      else executions.delete(key)
      Deferred.doneUnsafe(execution.done, exit)
    }

    const isActive = (key: Key) => Effect.sync(() => executions.has(key))

    const maintenance = <A, E2, R>(key: Key, effect: Effect.Effect<A, E2, R>) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<R>()
        return yield* Effect.suspend(() => {
          if (executions.has(key)) return Effect.succeed(Option.none<A>())
          const result = Deferred.makeUnsafe<A, E2>()
          const reservation: Execution<E, Reason> = {
            kind: "maintenance",
            done: Deferred.makeUnsafe<void, E>(),
            scope: "input",
            stopping: false,
          }
          // Admission and assigning the scoped owner are synchronous, just like start.
          executions.set(key, reservation)
          reservation.owner = fork(
            Effect.yieldNow.pipe(
              Effect.andThen(effect.pipe(Effect.provide(context))),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  // Maintenance has no lifecycle hooks or execution claim. Only an actual
                  // admission or explicit run may start a normal drain after its cleanup.
                  if (reservation.pendingRun) start(key, true, "input", reservation.pendingRun)
                  else if (reservation.pendingWake) start(key, false, reservation.pendingWake)
                  else executions.delete(key)
                  Deferred.doneUnsafe(reservation.done, Exit.void)
                  Deferred.doneUnsafe(result, exit)
                }),
              ),
              Effect.exit,
              Effect.asVoid,
            ),
          )
          return Deferred.await(result).pipe(Effect.map(Option.some))
        })
      })

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution !== undefined) {
          if (execution.kind === "maintenance") {
            // Do not join the maintenance result or accidentally turn a resume into a
            // non-forcing wake. All resumes share the forced successor's actual exit.
            execution.pendingRun ??= Deferred.makeUnsafe<void, E>()
            return Deferred.await(execution.pendingRun)
          }
          // A stopping execution refuses joiners: wait out its cleanup, then run fresh.
          if (execution.stopping)
            return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(run(key)))
          return Deferred.await(execution.done)
        }
        return Deferred.await(start(key, true, "input").done)
      })

    const wake = (key: Key, scope: Promotable = "input") =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution !== undefined) {
          // Coalesced wakes keep the widest scope: "input" subsumes "steer".
          execution.pendingWake = execution.pendingWake === "input" ? "input" : scope
          return
        }
        start(key, false, scope)
      })

    const interrupt = (key: Key, reason?: Reason): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined || execution.stopping) return false
        if (execution.owner === undefined) {
          // Settlement window: the owner exited but the settled hook has not finished. The
          // terminal outcome is already decided, so no reason attaches — but the interrupt
          // still claims the recorded wakes so settle does not start a dead-intent successor.
          execution.pendingWake = undefined
          return false
        }
        execution.stopping = true
        // Execution wakes belong to the interrupted intent; cleanup-era wakes are new
        // admissions. Maintenance has no execution intent, so all its wakes survive.
        if (execution.kind === "execution") execution.pendingWake = undefined
        execution.interruptionReason = reason
        // Fire and forget: nobody benefits from waiting out cleanup here, and callers like
        // the interrupt endpoint must acknowledge immediately even when finalizers are slow.
        fork(Fiber.interrupt(execution.owner))
        return true
      })

    // One execution's `done` already spans coalesced continuations; re-check after it
    // settles to cover a successor execution started by a late doorbell.
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution === undefined) return Effect.void
        return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
      })

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      isActive,
      run,
      maintenance,
      wake,
      interrupt,
      awaitIdle,
    }
  })
