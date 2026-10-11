import { describe, expect } from "bun:test"
import os from "os"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { AbsolutePath } from "@opencode/core/schema"
import { InstructionBuiltIns } from "@opencode/core/instructions/builtins"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const temporary = os.tmpdir()
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const it = testEffect(
  AppNodeBuilder.build(InstructionBuiltIns.node, [
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: temporary, tmp: temporary })),
  ]),
)
const sameRoot = testEffect(
  AppNodeBuilder.build(InstructionBuiltIns.node, [
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(location({ directory })))),
    Global.node.replace(Global.layerWith({ config: temporary, tmp: temporary })),
  ]),
)

describe("InstructionBuiltIns", () => {
  // Fork instructions omit dates and use a compact environment block.
  it.effect.skip("loads location-scoped environment and host-local date instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(initialized.text).toBe(
        [
          `Today's date: ${localDate(timestamp)}`,
          "",
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          `  Prefer ${temporary} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
          "</env>",
        ].join("\n"),
      )
    }),
  )

  it.effect.skip("updates the date without repeating unchanged environment instructions", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* readUpdate(yield* context.load(), initialized)

      expect(refreshed.text).toBe(`Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`)
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect((yield* readUpdate(yield* context.load(), initialized)).changed).toBe(false)
    }),
  )

  it.effect("loads compact location-scoped environment instructions without date or git status", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      expect(initialized.text).toBe(
        [
          `<env>Working directory: ${directory}; Workspace root folder: ${projectDirectory}; OS: ${process.platform}</env>`,
          "",
          `Use \`${temporary}\` for temporary work outside the workspace. It already exists and is pre-approved for external-directory access.`,
        ].join("\n"),
      )
    }),
  )

  it.effect("does not inject instruction updates when the date changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* readUpdate(yield* context.load(), initialized)

      expect(refreshed.changed).toBe(false)
    }),
  )

  sameRoot.effect("omits the workspace root when it matches the working directory", () =>
    Effect.gen(function* () {
      const context = yield* InstructionBuiltIns.Service
      const initialized = yield* readInitial(yield* context.load())
      expect(initialized.text).toContain(`<env>Working directory: ${directory}; OS: ${process.platform}</env>`)
      expect(initialized.text).not.toContain("Workspace root")
    }),
  )
})
