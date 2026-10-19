import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261019085832_child_context_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`context_budget_reached\` integer DEFAULT false NOT NULL;`)
    })
  },
}

export default migration
