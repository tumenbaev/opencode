import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "@opencode/core/command"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { CommandPlugin } from "@opencode/core/plugin/command"
import type { Plugin } from "@opencode/plugin/effect"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Skill } from "@opencode/schema/skill"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime } from "effect"
import { emptyMcp, emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"
import PROMPT_INITIALIZE from "../../src/plugin/command/initialize.txt"
import PROMPT_REVIEW from "../../src/plugin/command/review.txt"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: project })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)

describe("CommandPlugin.Plugin", () => {
  for (const [name, args, text, expected] of [
    [
      "last argument consumes remaining tokens",
      ["request"],
      "inspect the current page",
      { request: "inspect the current page" },
    ],
    [
      "earlier arguments keep quoted groups",
      ["target", "request"],
      `"current page" inspect 'the header' and footer`,
      { target: "current page", request: "inspect the header and footer" },
    ],
    [
      "empty quoted argument retains its position",
      ["target", "request"],
      `'' explain this page`,
      { target: "", request: "explain this page" },
    ],
    ["missing last argument is empty", ["target", "request"], "page", { target: "page", request: "" }],
    ["missing arguments are empty", ["target", "request"], "   ", { target: "", request: "" }],
    ["empty quoted last argument is empty", ["target", "request"], `page ""`, { target: "page", request: "" }],
    ["undeclared arguments are ignored", [], "unused tokens", {}],
  ] as const) {
    it.effect(`MCP ${name}`, () =>
      Effect.gen(function* () {
        const { command, calls } = yield* setupMcp({
          arguments: args.map((name) => ({ name })),
          messages: [{ role: "user", content: { type: "text", text: "Inspect the page" } }],
        })
        yield* command.execute({
          name: "test:inspect",
          invocation: { sessionID: Session.ID.make("ses_test"), prompt: { text }, delivery: "steer" },
        })
        expect(calls).toEqual([{ server: "test", name: "inspect", args: expected }])
      }),
    )
  }

  it.effect("MCP preserves text and appends all images to existing prompt attachments", () =>
    Effect.gen(function* () {
      const { command, prompts, events } = yield* setupMcp({
        messages: [
          { role: "user", content: { type: "text", text: "  Inspect" } },
          { role: "user", content: { type: "image", mimeType: "image/png", data: "cG5n" } },
          { role: "assistant", content: { type: "text", text: "Compare" } },
          { role: "assistant", content: { type: "image", mimeType: "image/webp", data: "d2VicA==" } },
        ],
      })
      const prompt: PromptInput.Prompt = {
        text: "original command input",
        files: [{ uri: "file:///tmp/context.md", name: "context.md" }],
        agents: [{ name: "reviewer" }],
        skills: [{ id: Skill.ID.make("inspect") }],
      }
      yield* command.execute({
        name: "test:inspect",
        invocation: { sessionID: Session.ID.make("ses_test"), prompt, delivery: "queue" },
      })
      expect(prompts).toEqual([
        {
          ...prompt,
          sessionID: Session.ID.make("ses_test"),
          text: "Inspect\n\nCompare",
          files: [
            { uri: "file:///tmp/context.md", name: "context.md" },
            { uri: "data:image/png;base64,cG5n", name: "mcp-image-1.png" },
            { uri: "data:image/webp;base64,d2VicA==", name: "mcp-image-2.webp" },
          ],
          delivery: "queue",
        },
      ])
      expect(prompt.files).toEqual([{ uri: "file:///tmp/context.md", name: "context.md" }])
      expect(events).toEqual(["mcp.prompt", "mcp.result", "session.prompt"])
      expect(PromptInput.Prompt.make(prompts[0]!)).toMatchObject({ files: prompts[0]!.files })
    }),
  )

  it.effect("MCP image-only prompts attach images without requiring existing files", () =>
    Effect.gen(function* () {
      const { command, prompts } = yield* setupMcp({
        messages: [{ role: "user", content: { type: "image", mimeType: "image/png", data: "cG5n" } }],
      })
      yield* command.execute({
        name: "test:inspect",
        invocation: { sessionID: Session.ID.make("ses_test"), prompt: { text: "" }, delivery: "steer" },
      })
      expect(prompts).toEqual([
        {
          sessionID: Session.ID.make("ses_test"),
          text: "",
          files: [{ uri: "data:image/png;base64,cG5n", name: "mcp-image-1.png" }],
          delivery: "steer",
        },
      ])
    }),
  )

  it.effect("MCP retains existing text collection for roles, resources and audio", () =>
    Effect.gen(function* () {
      const { command, prompts } = yield* setupMcp({
        messages: [
          { role: "user", content: { type: "text", text: "  First" } },
          {
            role: "assistant",
            content: { type: "resource", resource: { uri: "file:///context", text: "not inline text" } },
          },
          { role: "user", content: { type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" } },
          { role: "assistant", content: { type: "text", text: "Last  " } },
        ],
      })
      const files = [{ uri: "file:///tmp/context.md" }]
      yield* command.execute({
        name: "test:inspect",
        invocation: { sessionID: Session.ID.make("ses_test"), prompt: { text: "", files }, delivery: "steer" },
      })
      expect(prompts).toEqual([
        { sessionID: Session.ID.make("ses_test"), text: "First\n\n\nLast", files, delivery: "steer" },
      ])
    }),
  )

  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: {
        text: string
        files?: readonly { readonly uri: string }[]
        delivery?: "steer" | "queue"
      }[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push({ text: input.text, files: input.files, delivery: input.delivery })
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "extra context", files: [{ uri: "file:///tmp/context.md" }] },
          delivery: "queue",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "  branch $& $$ $` $'  " },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "" },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "   " },
          delivery: "steer",
        },
      })
      expect(prompts).toEqual([
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", "extra context"),
          files: [{ uri: "file:///tmp/context.md" }],
          delivery: "queue",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", () => "branch $& $$ $` $'"),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
      ])
    }),
  )
})

const setupMcp = Effect.fn(function* (input: {
  arguments?: Mcp.Prompt["arguments"]
  messages: Mcp.PromptResult["messages"]
}) {
  const command = yield* Command.Service
  const server = Mcp.ServerName.make("test")
  const calls: Parameters<Mcp.Interface["prompt"]>[0][] = []
  const prompts: Parameters<Plugin.Context["session"]["prompt"]>[0][] = []
  const events: string[] = []
  yield* CommandPlugin.Plugin.effect(
    host({
      command: {
        list: () => Effect.die("unused command.list"),
        transform: command.transform,
        reload: command.reload,
      },
      session: {
        prompt: (input) =>
          Effect.sync(() => {
            events.push("session.prompt")
            prompts.push(input)
            return SessionInbox.User.make({
              id: SessionMessage.ID.make("msg_test"),
              sessionID: input.sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "user",
              payload: { text: input.text },
              delivery: input.delivery ?? "steer",
            })
          }),
      },
    }),
  ).pipe(
    Effect.provideService(
      Location.Service,
      Location.Service.of(location({ directory }, { projectDirectory: project })),
    ),
    Effect.provideService(Mcp.Service, {
      ...emptyMcp,
      prompts: () => Effect.succeed([{ server, name: "inspect", arguments: input.arguments }]),
      prompt: (request) =>
        Effect.gen(function* () {
          events.push("mcp.prompt")
          calls.push(request)
          yield* Effect.yieldNow
          events.push("mcp.result")
          return { server, name: "inspect", messages: input.messages }
        }),
    }),
  )
  return { command, calls, prompts, events }
})
