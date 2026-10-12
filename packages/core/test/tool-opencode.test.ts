import { expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode/core/database/database"
import { CodeModeInstructions } from "@opencode/core/codemode/instructions"
import { CodeModeCatalog } from "@opencode/core/codemode/catalog"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProjectTable } from "@opencode/core/project/sql"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { McpResourceTools } from "@opencode/core/tool/plugin/mcp-resource"
import { WorktreeTable } from "@opencode/core/worktree/sql"
import { WorktreeStrategies } from "@opencode/core/worktree/strategies"
import { Model } from "@opencode/schema/model"
import { Effect } from "effect"
import { initRepo } from "./fixture/git"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { codeModeListings, executeTool, toolIdentity } from "./lib/tool"
import { makePluginTestLayer, PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const alpha = { id: "test/alpha", name: "Alpha", released: 300, variants: ["fast"], cost: [], status: "beta" }
const beta = { id: "other/beta", name: "Beta", released: 200, variants: [], cost: [], status: "active" }
const gamma = { id: "other/gamma", name: "Gamma Flash", released: 100, variants: [], cost: [], status: "active" }
const gammaOld = {
  id: "other/gamma-old",
  name: "Gamma Flash Old",
  released: 50,
  variants: [],
  cost: [],
  status: "active",
}

// These upstream tests exercise tools intentionally removed from agent access.
it.effect.skip("groups available models by provider with paging", () =>
  Effect.gen(function* () {
    const catalog = yield* Provider.Service
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const pluginHost = yield* PluginHost.make(plugins)
    yield* catalog.transform((editor) => {
      editor.update(Provider.ID.make("other"), (provider) => {
        provider.name = "Other Provider"
      })
      editor.models.update(Provider.ID.make("test"), Model.ID.make("alpha"), (model) => {
        model.name = "Alpha"
        model.time.released = 300
        model.variants = [{ id: Model.VariantID.make("fast") }]
        model.status = "beta"
      })
      editor.models.update(Provider.ID.make("other"), Model.ID.make("beta"), (model) => {
        model.name = "Beta"
        model.time.released = 200
      })
      editor.models.update(Provider.ID.make("other"), Model.ID.make("gamma"), (model) => {
        model.name = "Gamma Flash"
        model.time.released = 100
        model.family = Model.Family.make("gamma")
      })
      editor.models.update(Provider.ID.make("other"), Model.ID.make("gamma-old"), (model) => {
        model.name = "Gamma Flash Old"
        model.time.released = 50
        model.family = Model.Family.make("gamma")
      })
      editor.models.update(Provider.ID.make("other"), Model.ID.make("disabled"), (model) => {
        model.time.released = 400
        model.enabled = false
      })
    })
    yield* OpenCodeTools.Plugin.effect(pluginHost)
    // The caller runs on `test`, which sorts first despite `other` coming earlier alphabetically.
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: location.directory }),
      model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("alpha") }),
    })
    const registry = yield* Tool.Service
    const run = (input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-${JSON.stringify(input)}`,
          name: "execute",
          input: { code: `return await tools.opencode.models(${JSON.stringify(input)})` },
        },
      }).pipe(Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "")))

    // Grouped by provider, newest first within each, disabled models excluded.
    expect(yield* run({})).toEqual({
      providers: [
        { id: "test", name: "test", models: [alpha] },
        { id: "other", name: "Other Provider", models: [beta, gamma] },
      ],
      total: 3,
      next: null,
    })

    // Paging slices the ordered list, so a page can end inside a provider group.
    expect(yield* run({ limit: 2 })).toEqual({
      providers: [
        { id: "test", name: "test", models: [alpha] },
        { id: "other", name: "Other Provider", models: [beta] },
      ],
      total: 3,
      next: 2,
    })
    expect(yield* run({ limit: 2, offset: 2 })).toEqual({
      providers: [{ id: "other", name: "Other Provider", models: [gamma] }],
      total: 3,
      next: null,
    })

    expect(yield* run({ provider: "other provider" })).toMatchObject({ total: 2, providers: [{ id: "other" }] })
    expect(yield* run({ provider: "test" })).toEqual({
      providers: [{ id: "test", name: "test", models: [alpha] }],
      total: 1,
      next: null,
    })

    // Every word of the query must appear somewhere in the reference or display name, ignoring case.
    expect(yield* run({ query: "GAMMA" })).toEqual({
      providers: [{ id: "other", name: "Other Provider", models: [gamma] }],
      total: 1,
      next: null,
    })
    expect(yield* run({ query: "test/" })).toMatchObject({ total: 1, providers: [{ id: "test" }] })
    expect(yield* run({ query: "other flash" })).toMatchObject({ total: 1, providers: [{ models: [gamma] }] })
    expect(yield* run({ query: "gamma beta" })).toEqual({ providers: [], total: 0, next: null })

    // Only the newest model of each family is listed unless `all` is set; the query is applied first.
    expect(yield* run({ all: true })).toMatchObject({
      total: 4,
      providers: [{ id: "test" }, { id: "other", models: [beta, gamma, gammaOld] }],
    })
    expect(yield* run({ query: "old" })).toMatchObject({ total: 1, providers: [{ models: [gammaOld] }] })
    expect(yield* run({ provider: "other", query: "alpha" })).toEqual({ providers: [], total: 0, next: null })
  }),
)

const approvals = { assertions: [] as Permission.AssertInput[], denyEdit: false }
const worktreeIt = testEffect(
  makePluginTestLayer(
    permissionLayer({
      assert: (input) =>
        Effect.sync(() => approvals.assertions.push(input)).pipe(
          Effect.andThen(
            approvals.denyEdit && input.action === "edit"
              ? Effect.fail(
                  new Permission.BlockedError({ rules: [], permission: input.action, resources: input.resources }),
                )
              : Effect.void,
          ),
        ),
    }),
  ),
)

worktreeIt.effect("hides removed tools from registration, discovery, describe, and execution", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const host = yield* PluginHost.make(plugins)
    yield* OpenCodeTools.Plugin.effect(host)
    yield* McpResourceTools.Plugin.effect(host)
    const registry = yield* Tool.Service
    const snapshot = yield* registry.snapshot()
    const ids = (yield* registry.list()).map((tool) => tool.id)
    const catalog = snapshot.codeModeCatalog
    if (!catalog) throw new Error("Missing Code Mode catalog")
    const names = codeModeListings(catalog).map((entry) => entry.path)
    const text = CodeModeInstructions.render(CodeModeCatalog.summarize(catalog))
    const run = (name: string, input: unknown) =>
      snapshot.execute({
        sessionID: Session.ID.make("ses_removed_tools"),
        ...toolIdentity,
        call: { type: "tool-call", id: "removed-tools", name, input },
      })
    approvals.assertions.length = 0
    for (const name of ["session_rename", "models", "worktree_create", "worktree_remove"]) {
      expect(ids).not.toContain(`opencode_${name}`)
      expect(names).not.toContain(`opencode.${name}`)
      expect(text).not.toContain(`opencode.${name}`)
      expect((yield* run("describe", { name: `opencode.${name}` }).pipe(Effect.flip)).message).toBe(
        "Unknown or unavailable tool.",
      )
      expect((yield* run(`opencode_${name}`, {}).pipe(Effect.flip)).message).toContain("No tool named")
      expect((yield* run("execute", { code: `return await tools.opencode.${name}({})` })).output).toMatchObject({
        error: true,
        toolCalls: [],
      })
      expect(
        (yield* run("execute", {
          code: `return search({ query: "" }).items.some(item => item.path === "tools.opencode.${name}")`,
        })).output,
      ).toMatchObject({ output: "false" })
    }
    for (const name of ["session_move", "worktree_list", "list_mcp_resources", "read_mcp_resource"]) {
      expect(ids).toContain(`opencode_${name}`)
      expect(names).toContain(`opencode.${name}`)
      expect(text).toContain(`- opencode.${name}`)
      expect((yield* run("describe", { name: `opencode.${name}` })).output).toMatchObject({
        signature: expect.stringContaining(`tools.opencode.${name}(`),
      })
    }
    expect(text.split("## Available tools\n\n")[1]).toBe(
      [
        "- opencode.list_mcp_resources",
        "- opencode.read_mcp_resource",
        "- opencode.session_move",
        "- opencode.worktree_list",
      ].join("\n"),
    )
    expect(approvals.assertions).toEqual([])
  }),
)

worktreeIt.live.skip("creates, lists, and removes worktrees for the plugin's project", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const strategies = yield* WorktreeStrategies.Service
    const database = yield* Database.Service
    const parent = yield* tmpdirScoped()
    yield* Effect.promise(() => initRepo(location.directory))
    yield* database.db
      .insert(ProjectTable)
      .values({
        id: location.project.id,
        worktree: location.directory,
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoUpdate({ target: ProjectTable.id, set: { worktree: location.directory } })
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(WorktreeTable)
      .values({ project_id: location.project.id, directory: location.directory })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* strategies.transform((editor) => editor.configure({ directory: AbsolutePath.make(parent.path) }))
    yield* OpenCodeTools.Plugin.effect(yield* PluginHost.make(plugins))
    const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const registry = yield* Tool.Service
    const call = (name: string, input: Record<string, unknown>) =>
      executeTool(registry, {
        sessionID: session.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-${name}-${JSON.stringify(input)}`,
          name: "execute",
          input: { code: `return await tools.opencode.${name}(${JSON.stringify(input)})` },
        },
      })
    const run = (name: string, input: Record<string, unknown>) =>
      call(name, input).pipe(
        Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "")),
      )
    const directory = path.join(parent.path, "task")

    expect(yield* run("worktree_create", { name: " task " })).toEqual({ directory })
    expect(yield* Effect.promise(() => fs.stat(directory).then((stat) => stat.isDirectory()))).toBe(true)
    expect((yield* run("worktree_list", {})).worktrees).toContainEqual({ directory, strategy: "git" })

    // The project checkout is not a removable worktree.
    expect(yield* call("worktree_remove", { directory: location.directory })).toMatchObject({
      content: [
        {
          type: "text",
          text: `Unable to remove ${location.directory}: it is not a worktree of this project. Use worktree_list to see the project's worktrees.`,
        },
      ],
      metadata: { error: true },
    })
    expect(yield* Effect.promise(() => fs.stat(location.directory).then((stat) => stat.isDirectory()))).toBe(true)

    // A dirty worktree is kept, and the failure leaves the choice to force removal to the model.
    yield* Effect.promise(() => fs.writeFile(path.join(directory, "draft.txt"), "draft"))
    expect(yield* call("worktree_remove", { directory })).toMatchObject({
      content: [{ type: "text", text: `Unable to remove worktree ${directory}: it has modified or untracked files.` }],
    })
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, "draft.txt")).exists())).toBe(true)
    yield* Effect.promise(() => fs.rm(path.join(directory, "draft.txt")))

    // Removal requires the same approval as editing files in the worktree.
    approvals.assertions.length = 0
    approvals.denyEdit = true
    expect(yield* call("worktree_remove", { directory })).toMatchObject({ metadata: { error: true } })
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".git")).exists())).toBe(true)
    approvals.denyEdit = false

    // Relative paths resolve from the session's directory for both approval and removal.
    expect(yield* run("worktree_remove", { directory: path.relative(location.directory, directory) })).toEqual({
      directory,
      removed: true,
    })
    expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".git")).exists())).toBe(false)
    // Permission resources always use forward slashes, including on Windows.
    const resource = directory.replaceAll("\\", "/")
    expect(approvals.assertions).toMatchObject([
      { action: "edit", resources: [resource], save: ["*"], sessionID: session.id },
      { action: "edit", resources: [resource], save: ["*"], sessionID: session.id },
    ])
    expect((yield* run("worktree_list", {})).worktrees).not.toContainEqual({ directory, strategy: "git" })
  }),
)
