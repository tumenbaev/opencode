import { describe, expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionRunCoordinator } from "@opencode/core/session/run-coordinator"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SessionRunCoordinator", () => {
  describe("maintenance", () => {
    it.effect("preserves caller-context results and failures without execution lifecycle or an input-free drain", () =>
      Effect.gen(function* () {
        class Value extends Context.Service<Value, { readonly value: number }>()("test/MaintenanceValue") {}
        const lifecycle: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => void lifecycle.push("drain")),
          started: () => Effect.sync(() => void lifecycle.push("started")),
          settled: () => Effect.sync(() => void lifecycle.push("settled")),
        })

        const result = yield* coordinator
          .maintenance(
            "session",
            Value.use((service) => Effect.succeed(service.value)),
          )
          .pipe(Effect.provideService(Value, { value: 42 }))
        yield* coordinator.awaitIdle("session")

        expect(result).toEqual(Option.some(42))
        const failed = yield* coordinator
          .maintenance(
            "session",
            Value.use((service) => Effect.fail(service.value)),
          )
          .pipe(Effect.provideService(Value, { value: 42 }), Effect.exit)
        expect(failed).toEqual(Exit.fail(42))
        yield* coordinator.awaitIdle("session")
        expect(yield* coordinator.maintenance("session", Effect.succeed("again"))).toEqual(Option.some("again"))
        expect(lifecycle).toEqual([])
        expect(yield* coordinator.isActive("session")).toBe(false)
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    )

    it.effect("atomically excludes competing maintenance and releases a steer-only wake with its scope intact", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let calls = 0
        const drains: Array<{ force: boolean; scope: SessionInbox.Promotable }> = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (_key, force, scope) => Effect.sync(() => void drains.push({ force, scope })),
        })
        const operation = Effect.sync(() => ++calls).pipe(
          Effect.tap(() => Deferred.succeed(started, undefined)),
          Effect.tap(() => Deferred.await(release)),
        )
        const attempts = yield* Effect.all(
          [coordinator.maintenance("session", operation), coordinator.maintenance("session", operation)],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild)
        yield* Deferred.await(started)

        expect(yield* coordinator.active).toEqual(new Set(["session"]))
        expect(yield* coordinator.isActive("session")).toBe(true)
        expect(yield* coordinator.maintenance("other", Effect.succeed("other"))).toEqual(Option.some("other"))
        yield* coordinator.wake("session", "steer")
        expect(drains).toEqual([])
        yield* Deferred.succeed(release, undefined)
        const results = yield* Fiber.join(attempts)
        yield* coordinator.awaitIdle("session")

        expect(results).toContainEqual(Option.some(1))
        expect(results.filter(Option.isNone)).toHaveLength(1)
        expect(calls).toBe(1)
        expect(drains).toEqual([{ force: false, scope: "steer" }])
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    )

    it.effect("rejects maintenance during normal execution and terminal settlement", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const settling = yield* Deferred.make<void>()
        const settled = yield* Deferred.make<void>()
        let calls = 0
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          settled: () => Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(settled))),
        })
        const operation = Effect.sync(() => ++calls)
        yield* coordinator.wake("session")
        yield* Deferred.await(started)
        expect(yield* coordinator.maintenance("session", operation)).toEqual(Option.none())
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(settling)
        expect(yield* coordinator.maintenance("session", operation)).toEqual(Option.none())
        yield* Deferred.succeed(settled, undefined)
        yield* coordinator.awaitIdle("session")

        expect(calls).toBe(0)
        expect(yield* coordinator.maintenance("session", operation)).toEqual(Option.some(1))
      }),
    )

    it.effect("defers coalesced wakes through a maintenance defect and cleanup", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        const error = new Error("maintenance defect")
        const drains: Array<{ force: boolean; scope: SessionInbox.Promotable }> = []
        const lifecycle: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (_key, force, scope) => Effect.sync(() => void drains.push({ force, scope })),
          started: () => Effect.sync(() => void lifecycle.push("started")),
          settled: () => Effect.sync(() => void lifecycle.push("settled")),
        })
        const operation = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.die(error)),
          Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned)))),
        )
        const waiter = yield* coordinator.maintenance("session", operation).pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session", "steer")
        expect(drains).toEqual([])
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(cleaning)
        yield* coordinator.wake("session", "input")
        yield* coordinator.wake("session", "steer")
        expect(yield* coordinator.isActive("session")).toBe(true)
        expect(yield* coordinator.maintenance("session", Effect.void)).toEqual(Option.none())
        expect(lifecycle).toEqual([])
        expect(drains).toEqual([])
        yield* Deferred.succeed(cleaned, undefined)
        const exit = yield* Fiber.join(waiter)
        yield* coordinator.awaitIdle("session")

        expect(exit).toEqual(Exit.die(error))
        expect(drains).toEqual([{ force: false, scope: "input" }])
        expect(lifecycle).toEqual(["started", "settled"])
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    )

    // Ordinary release without a wake, and interruption with both kinds of pending admission.
    for (const outcome of ["success", "interruption"] as const) {
      it.effect(`resumes after maintenance ${outcome} with a forced normal execution`, () =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const cleaning = yield* Deferred.make<void>()
          const cleaned = yield* Deferred.make<void>()
          const failure = new Error("normal execution failed")
          const forces: boolean[] = []
          const coordinator = yield* SessionRunCoordinator.make({
            drain: (_key, force) =>
              Effect.sync(() => void forces.push(force)).pipe(Effect.andThen(Effect.fail(failure))),
          })
          const maintenance = yield* coordinator
            .maintenance(
              "session",
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned)))),
              ),
            )
            .pipe(Effect.exit, Effect.forkChild)
          yield* Deferred.await(started)
          if (outcome === "interruption") yield* coordinator.wake("session", "steer")
          const first = yield* coordinator.run("session").pipe(Effect.exit, Effect.forkChild)
          const second = yield* coordinator.run("session").pipe(Effect.exit, Effect.forkChild)
          yield* Effect.yieldNow
          expect(forces).toEqual([])
          if (outcome === "interruption") expect(yield* coordinator.interrupt("session")).toBe(true)
          else yield* Deferred.succeed(release, undefined)
          yield* Deferred.await(cleaning)
          expect(forces).toEqual([])
          expect(first.pollUnsafe()).toBeUndefined()
          expect(second.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(cleaned, undefined)
          const maintenanceExit = yield* Fiber.join(maintenance)
          expect(Exit.isSuccess(maintenanceExit)).toBe(outcome === "success")
          const exits = yield* Effect.all([Fiber.join(first), Fiber.join(second)])

          expect(exits).toEqual([Exit.fail(failure), Exit.fail(failure)])
          expect(forces).toEqual([true])
          expect(yield* coordinator.active).toEqual(new Set())
        }),
      )
    }

    it.effect("interruption without a pending admission releases maintenance without execution lifecycle", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let cleaned = false
        const lifecycle: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: () => Effect.sync(() => void lifecycle.push("drain")),
          started: () => Effect.sync(() => void lifecycle.push("started")),
          settled: () => Effect.sync(() => void lifecycle.push("settled")),
        })
        const waiter = yield* coordinator
          .maintenance(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            ),
          )
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        expect(yield* coordinator.interrupt("session")).toBe(true)
        yield* coordinator.awaitIdle("session")
        const exit = yield* Fiber.join(waiter)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(cleaned).toBe(true)
        expect(yield* coordinator.active).toEqual(new Set())
        expect(lifecycle).toEqual([])
      }),
    )

    it.effect("interrupts the maintenance owner, retains admitted wakes, and waits for cleanup", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        const draining = yield* Deferred.make<void>()
        const drained = yield* Deferred.make<void>()
        const scopes: SessionInbox.Promotable[] = []
        const lifecycle: string[] = []
        const coordinator = yield* SessionRunCoordinator.make({
          drain: (_key, _force, scope) =>
            Effect.sync(() => void scopes.push(scope)).pipe(
              Effect.andThen(Deferred.succeed(draining, undefined)),
              Effect.andThen(Deferred.await(drained)),
            ),
          started: () => Effect.sync(() => void lifecycle.push("started")),
          settled: () => Effect.sync(() => void lifecycle.push("settled")),
        })
        const waiter = yield* coordinator
          .maintenance(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned)))),
            ),
          )
          .pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(started)
        yield* coordinator.wake("session", "input")
        expect(yield* coordinator.interrupt("session")).toBe(true)
        yield* Deferred.await(cleaning)
        expect(yield* coordinator.interrupt("session")).toBe(false)
        const idle = yield* coordinator.awaitIdle("session").pipe(Effect.forkChild)
        yield* coordinator.wake("session", "steer")
        yield* Effect.yieldNow
        expect(yield* coordinator.isActive("session")).toBe(true)
        expect(yield* coordinator.maintenance("session", Effect.void)).toEqual(Option.none())
        expect(idle.pollUnsafe()).toBeUndefined()
        expect(lifecycle).toEqual([])
        expect(scopes).toEqual([])
        yield* Deferred.succeed(cleaned, undefined)
        const exit = yield* Fiber.join(waiter)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        yield* Deferred.await(draining)
        expect(idle.pollUnsafe()).toBeUndefined()
        expect(scopes).toEqual(["input"])
        yield* Deferred.succeed(drained, undefined)
        yield* Fiber.join(idle)
        expect(lifecycle).toEqual(["started", "settled"])
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    )

    it.effect("keeps ownership after its caller disconnects until the operation finishes", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let completed = false
        let drains = 0
        const coordinator = yield* SessionRunCoordinator.make({ drain: () => Effect.sync(() => void drains++) })
        const caller = yield* coordinator
          .maintenance(
            "session",
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(
                Effect.sync(() => {
                  completed = true
                }),
              ),
            ),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(caller)
        expect(yield* coordinator.isActive("session")).toBe(true)
        expect(yield* coordinator.maintenance("session", Effect.void)).toEqual(Option.none())
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.awaitIdle("session")
        expect(completed).toBe(true)
        expect(drains).toBe(0)
        expect(yield* coordinator.active).toEqual(new Set())
      }),
    )

    it.effect("interrupts maintenance and releases ownership when the coordinator scope closes", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        let cleaned = false
        const lifecycle: string[] = []
        const coordinator = yield* Effect.scoped(
          Effect.gen(function* () {
            const coordinator = yield* SessionRunCoordinator.make({
              drain: () => Effect.sync(() => void lifecycle.push("drain")),
              started: () => Effect.sync(() => void lifecycle.push("started")),
              settled: () => Effect.sync(() => void lifecycle.push("settled")),
            })
            yield* coordinator
              .maintenance(
                "session",
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      cleaned = true
                    }),
                  ),
                ),
              )
              .pipe(Effect.forkChild)
            yield* Deferred.await(started)
            return coordinator
          }),
        )
        expect(cleaned).toBe(true)
        expect(yield* coordinator.active).toEqual(new Set())
        expect(lifecycle).toEqual([])
      }),
    )
  })

  it.effect("joins concurrent resumes for one key", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
      })

      const first = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow

      expect(runs).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(runs).toBe(1)
    }),
  )

  it.effect("joins a wake-started execution without forcing a successor", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const forces: boolean[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (_key, force) =>
          Effect.sync(() => forces.push(force)).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(gate)),
          ),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(started)
      const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(resumed)

      expect(forces).toEqual([false])
    }),
  )

  it.effect("starts execution when woken while idle", () =>
    Effect.gen(function* () {
      const drained = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })

      yield* coordinator.wake("session")
      yield* Deferred.await(drained)
    }),
  )

  it.effect("snapshots only active executions", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (key: string) =>
          Deferred.succeed(key === "first" ? firstStarted : secondStarted, undefined).pipe(
            Effect.andThen(Deferred.await(key === "first" ? firstGate : secondGate)),
          ),
      })
      const firstActive = coordinator.isActive("first")

      expect(Array.from(yield* coordinator.active)).toEqual([])
      expect(yield* firstActive).toBe(false)
      const first = yield* coordinator.run("first").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      expect(Array.from(yield* coordinator.active)).toEqual(["first"])
      expect(yield* firstActive).toBe(true)
      expect(yield* coordinator.isActive("second")).toBe(false)

      const second = yield* coordinator.run("second").pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted)
      expect(Array.from(yield* coordinator.active)).toEqual(["first", "second"])
      expect(yield* coordinator.isActive("second")).toBe(true)

      yield* Deferred.succeed(firstGate, undefined)
      yield* Fiber.join(first)
      expect(Array.from(yield* coordinator.active)).toEqual(["second"])
      expect(yield* firstActive).toBe(false)
      expect(yield* coordinator.isActive("second")).toBe(true)
      yield* Deferred.succeed(secondGate, undefined)
      yield* Fiber.join(second)
      expect(Array.from(yield* coordinator.active)).toEqual([])
      expect(yield* coordinator.isActive("second")).toBe(false)
    }),
  )

  it.effect("cleans active executions after failure and defect", () =>
    Effect.gen(function* () {
      const failure = new Error("failed")
      const defect = new Error("defect")
      const settled: Exit.Exit<void, Error>[] = []
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (key: string) => (key === "failure" ? Effect.fail(failure) : Effect.die(defect)),
        settled: (_key, exit) => Effect.sync(() => void settled.push(exit)),
      })

      const failed = yield* coordinator.run("failure").pipe(Effect.exit)
      expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBeTrue()
      expect(Array.from(yield* coordinator.active)).toEqual([])
      expect(yield* coordinator.isActive("failure")).toBe(false)

      const died = yield* coordinator.run("defect").pipe(Effect.exit)
      expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBeTrue()
      expect(Array.from(yield* coordinator.active)).toEqual([])
      expect(yield* coordinator.isActive("defect")).toBe(false)
      expect(settled).toHaveLength(2)
    }),
  )

  it.effect("preserves settlement hook defects while releasing ownership", () =>
    Effect.gen(function* () {
      const defect = new Error("terminal publication failed")
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () => Effect.void,
        settled: () => Effect.die(defect),
      })

      const exit = yield* coordinator.run("session").pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
      expect(yield* coordinator.active).toEqual(new Set())
    }),
  )

  it.effect("cleans active executions when its scope closes", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(
        Effect.gen(function* () {
          const coordinator = yield* SessionRunCoordinator.make({
            drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          })
          yield* coordinator.wake("session")
          yield* Deferred.await(started)
          expect(Array.from(yield* coordinator.active)).toEqual(["session"])
          return coordinator
        }),
      )

      expect(Array.from(yield* coordinator.active)).toEqual([])
    }),
  )

  it.effect("coalesces wakes received during active execution", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
                : Deferred.succeed(secondStarted, undefined),
            ),
          ),
      })

      const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* Effect.all([coordinator.wake("session"), coordinator.wake("session"), coordinator.wake("session")], {
        concurrency: "unbounded",
      })
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* Fiber.join(resumed)

      expect(runs).toBe(2)
    }),
  )

  it.effect("runs again when woken during the follow-up", () =>
    Effect.gen(function* () {
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      const thirdStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.await(firstGate)
                : run === 2
                  ? Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
                  : Deferred.succeed(thirdStarted, undefined),
            ),
          ),
      })

      const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* coordinator.wake("session")
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* coordinator.wake("session")
      yield* Deferred.succeed(secondGate, undefined)
      yield* Deferred.await(thirdStarted)
      yield* Fiber.join(resumed)

      expect(runs).toBe(3)
    }),
  )

  it.effect("does nothing when interrupted while idle", () =>
    Effect.gen(function* () {
      const reasons: Array<string | undefined> = []
      const coordinator = yield* SessionRunCoordinator.make<string, never, string>({
        drain: () => Effect.void,
        settled: (_key, _exit, reason) => Effect.sync(() => void reasons.push(reason)),
      })
      expect(yield* coordinator.interrupt("session", "user")).toBeFalse()
      yield* coordinator.run("session")
      expect(reasons).toEqual([undefined])
    }),
  )

  it.effect("does not attach a late interrupt reason after terminal settlement starts", () =>
    Effect.gen(function* () {
      const settling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const reasons: Array<string | undefined> = []
      const coordinator = yield* SessionRunCoordinator.make<string, never, string>({
        drain: () => Effect.void,
        settled: (_key, _exit, reason) =>
          Deferred.succeed(settling, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.sync(() => void reasons.push(reason))),
          ),
      })

      const run = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Deferred.await(settling)
      expect(yield* coordinator.interrupt("session", "user")).toBeFalse()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(run)
      yield* coordinator.run("session")

      expect(reasons).toEqual([undefined, undefined])
    }),
  )

  it.effect("a settlement-window wake starts a fresh execution with its own scope", () =>
    Effect.gen(function* () {
      const settling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scopes: SessionInbox.Promotable[] = []
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (_key, _force, scope) => Effect.sync(() => scopes.push(scope)),
        settled: () => Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })

      yield* coordinator.wake("session", "steer")
      yield* Deferred.await(settling)
      yield* coordinator.wake("session", "input")
      yield* Deferred.succeed(release, undefined)
      yield* coordinator.awaitIdle("session")

      expect(scopes).toEqual(["steer", "input"])
    }),
  )

  it.effect("interrupts active execution and clears its pending wake", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      let runs = 0
      const reasons: Array<string | undefined> = []
      const coordinator = yield* SessionRunCoordinator.make<string, never, string>({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        settled: (_key, _exit, reason) => Effect.sync(() => void reasons.push(reason)),
      })

      const first = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const second = yield* coordinator.run("session").pipe(Effect.forkChild)
      const idle = yield* coordinator.awaitIdle("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* coordinator.wake("session")
      expect(yield* coordinator.interrupt("session", "user")).toBeTrue()
      yield* Deferred.await(interrupted)

      const exits = yield* Fiber.awaitAll([first, second, idle])
      expect(exits.slice(0, 2).every((exit) => Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))).toBeTrue()
      expect(exits.slice(2).every(Exit.isSuccess)).toBeTrue()
      expect(Array.from(yield* coordinator.active)).toEqual([])
      expect(runs).toBe(1)
      expect(reasons).toEqual(["user"])
    }),
  )

  it.effect("runs a wake registered during interruption cleanup", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      let runs = 0
      let starts = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                    ),
                  )
                : Deferred.succeed(secondStarted, undefined),
            ),
          ),
        started: () => Effect.sync(() => starts++).pipe(Effect.asVoid),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(firstStarted)
      const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleanupStarted)
      yield* coordinator.wake("session")
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(interrupt)
      yield* Deferred.await(secondStarted)

      expect(runs).toBe(2)
      expect(starts).toBe(2)
    }),
  )

  it.effect("coalesces drain scopes with input taking precedence", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scopes: SessionInbox.Promotable[] = []
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (_key, _force, scope) =>
          Effect.gen(function* () {
            scopes.push(scope)
            if (scopes.length !== 1) return
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(release)
          }),
      })

      yield* coordinator.wake("session", "steer")
      yield* Deferred.await(firstStarted)
      yield* coordinator.wake("session", "steer")
      yield* coordinator.wake("session", "input")
      yield* Deferred.succeed(release, undefined)
      yield* coordinator.awaitIdle("session")

      expect(scopes).toEqual(["steer", "input"])
    }),
  )

  it.effect("does not carry a completed input scope into a steer drain", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const scopes: SessionInbox.Promotable[] = []
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (_key, _force, scope) =>
          Effect.gen(function* () {
            scopes.push(scope)
            if (scopes.length !== 1) return
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(release)
          }),
      })

      yield* coordinator.wake("session", "input")
      yield* Deferred.await(firstStarted)
      yield* coordinator.wake("session", "steer")
      yield* Deferred.succeed(release, undefined)
      yield* coordinator.awaitIdle("session")

      expect(scopes).toEqual(["input", "steer"])
    }),
  )

  it.effect("a cleanup-era wake starts a successor with its own scope", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const scopes: SessionInbox.Promotable[] = []
      const coordinator = yield* SessionRunCoordinator.make({
        drain: (_key, _force, scope) =>
          Effect.gen(function* () {
            scopes.push(scope)
            if (scopes.length !== 1) return
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Effect.never.pipe(
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
              ),
            )
          }),
      })

      yield* coordinator.wake("session", "input")
      yield* Deferred.await(firstStarted)
      const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleanupStarted)
      // A new admission during cancellation restarts normally: interruption only
      // claims the wakes recorded before it.
      yield* coordinator.wake("session", "input")
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(interrupt)
      yield* coordinator.awaitIdle("session")

      expect(scopes).toEqual(["input", "input"])
    }),
  )

  it.effect("starts a resume registered during interruption cleanup", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const forces: boolean[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (_key, force) => {
          forces.push(force)
          return forces.length === 1
            ? Deferred.succeed(firstStarted, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
                ),
              )
            : Deferred.succeed(secondStarted, undefined)
        },
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(firstStarted)
      const interrupt = yield* coordinator.interrupt("session").pipe(Effect.forkChild)
      yield* Deferred.await(cleanupStarted)
      const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Effect.all([Fiber.join(interrupt), Fiber.join(resumed)])
      yield* Deferred.await(secondStarted)

      expect(forces).toEqual([false, true])
    }),
  )

  it.effect("starts one follow-up when a wake races with failure", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const failure = new Error("failed")
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.await(gate).pipe(Effect.andThen(Effect.fail(failure)))
                : Deferred.succeed(secondStarted, undefined),
            ),
          ),
      })

      const resumed = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* coordinator.wake("session")
      yield* Deferred.succeed(gate, undefined)

      expect(yield* Fiber.join(resumed).pipe(Effect.flip)).toBe(failure)
      yield* Deferred.await(secondStarted)
      expect(runs).toBe(2)
    }),
  )

  it.effect("does not cancel execution when a joined waiter is interrupted", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate))),
      })

      const first = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* coordinator.run("session").pipe(Effect.forkChild)
      yield* Fiber.interrupt(second)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)

      expect(runs).toBe(1)
    }),
  )

  it.effect("runs different keys concurrently", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const bothStarted = yield* Deferred.make<void>()
      let active = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++active).pipe(
            Effect.tap(() => (active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void)),
            Effect.andThen(Deferred.await(gate)),
          ),
      })

      const first = yield* coordinator.run("first").pipe(Effect.forkChild)
      const second = yield* coordinator.run("second").pipe(Effect.forkChild)
      yield* Deferred.await(bothStarted)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    }),
  )

  it.effect("settles once per execution across coalesced drains", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const idle = yield* Deferred.make<void>()
      let drains = 0
      let starts = 0
      const settled: Exit.Exit<void, never>[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () =>
          Effect.sync(() => ++drains).pipe(
            Effect.flatMap((run) =>
              run === 1 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))) : Effect.void,
            ),
            Effect.asVoid,
          ),
        started: () => Effect.sync(() => starts++).pipe(Effect.asVoid),
        settled: (_key, exit) =>
          Effect.sync(() => void settled.push(exit)).pipe(
            Effect.andThen(Deferred.succeed(idle, undefined)),
            Effect.asVoid,
          ),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(started)
      yield* coordinator.wake("session")
      yield* Deferred.succeed(gate, undefined)
      yield* Deferred.await(idle)

      expect(drains).toBe(2)
      expect(starts).toBe(1)
      expect(settled).toHaveLength(1)
      expect(Exit.isSuccess(settled[0]!)).toBe(true)
    }),
  )

  it.effect("settles interrupted executions before waiters resolve", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const settled: Exit.Exit<void, never>[] = []
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        settled: (_key, exit) => Effect.sync(() => void settled.push(exit)),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(started)
      yield* coordinator.interrupt("session")
      yield* coordinator.awaitIdle("session")

      expect(settled).toHaveLength(1)
      expect(settled[0] !== undefined && Exit.isFailure(settled[0]) && Cause.hasInterrupts(settled[0].cause)).toBe(true)
      expect(yield* coordinator.active).toEqual(new Set())
    }),
  )

  it.effect("acknowledges interruption before cleanup settles", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const settled: Array<string | undefined> = []
      const coordinator = yield* SessionRunCoordinator.make<string, never, string>({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate))),
            ),
          ),
        settled: (_key, _exit, reason) => Effect.sync(() => void settled.push(reason)),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(started)
      // Interrupt resolves while the cleanup gate is still closed: acceptance, not settlement.
      yield* coordinator.interrupt("session", "user")
      expect(settled).toHaveLength(0)
      expect(Array.from(yield* coordinator.active)).toEqual(["session"])
      expect(yield* coordinator.isActive("session")).toBe(true)
      // Repeating the interrupt during cleanup stays an immediate no-op.
      yield* coordinator.interrupt("session", "user")

      yield* Deferred.await(cleanupStarted)
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* coordinator.awaitIdle("session")

      expect(settled).toEqual(["user"])
      expect(yield* coordinator.active).toEqual(new Set())
      expect(yield* coordinator.isActive("session")).toBe(false)
    }),
  )

  it.effect("an interrupt during terminal settlement claims the recorded wake", () =>
    Effect.gen(function* () {
      const settling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let drains = 0
      const coordinator = yield* SessionRunCoordinator.make({
        drain: () => Effect.sync(() => void drains++),
        settled: () => Deferred.succeed(settling, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })

      yield* coordinator.wake("session")
      yield* Deferred.await(settling)
      expect(yield* coordinator.isActive("session")).toBe(true)
      // The owner has exited; this wake lands on the settling execution's doorbell.
      yield* coordinator.wake("session")
      // The interrupt claims it: settle must not start a successor for the dead intent.
      yield* coordinator.interrupt("session")
      yield* Deferred.succeed(release, undefined)
      yield* coordinator.awaitIdle("session")

      expect(drains).toBe(1)
      expect(yield* coordinator.active).toEqual(new Set())
      expect(yield* coordinator.isActive("session")).toBe(false)
    }),
  )

  it.effect("trampolines synchronous self-waking execution", () =>
    Effect.gen(function* () {
      const limit = 20_000
      const completed = yield* Deferred.make<void>()
      let runs = 0
      let wake: (key: string) => Effect.Effect<void> = () => Effect.void
      const coordinator = yield* SessionRunCoordinator.make<string, never>({
        drain: (key) =>
          Effect.sync(() => ++runs).pipe(
            Effect.tap((run) => (run < limit ? wake(key) : Deferred.succeed(completed, undefined))),
            Effect.asVoid,
          ),
      })
      wake = coordinator.wake

      yield* coordinator.wake("session")
      yield* Deferred.await(completed)

      expect(runs).toBe(limit)
    }),
  )
})
