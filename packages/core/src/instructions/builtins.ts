export * as InstructionBuiltIns from "./builtins.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "../location.js"
import { Instructions } from "./index.js"

export interface Interface {
  readonly load: () => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionBuiltIns") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const defaultTmp =
      process.platform === "darwin"
        ? yield* fs.realPath(Global.Path.tmp).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
    const temporary = process.platform === "darwin" && global.tmp === defaultTmp ? "${TMPDIR}/opencode" : global.tmp
    return Service.of({
      load: () =>
        Effect.succeed(
          Instructions.combine([
            Instructions.make({
              key: Instructions.Key.make("core/environment"),
              codec: Schema.toCodecJson(Schema.String),
              read: Effect.sync(() =>
                [
                  `<env>${[
                    `Working directory: ${location.directory}`,
                    ...(location.directory === location.project.directory
                      ? []
                      : [`Workspace root folder: ${location.project.directory}`]),
                    `OS: ${process.platform}`,
                  ].join("; ")}</env>`,
                  "",
                  `Use \`${temporary}\` for temporary work outside the workspace. It already exists and is pre-approved for external-directory access.`,
                ].join("\n"),
              ),
              render: {
                initial: (environment) => environment,
                changed: (_previous, environment) =>
                  ["The environment you are running in is now:", environment].join("\n"),
              },
            }),
          ]),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Global.node, Location.node, FSUtil.node] })
