import { Context } from "effect"

// Internal, fiber-local guard: command-generated prompts are not inline snippets.
export const CommandExecution = Context.Reference<boolean>("@opencode/Session/CommandExecution", {
  defaultValue: () => false,
})
