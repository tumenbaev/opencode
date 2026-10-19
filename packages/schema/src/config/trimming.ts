export * as ConfigTrimming from "./trimming.js"

import { Schema } from "effect"
import { optional } from "../schema.js"
import { ConfigModel } from "./model.js"

export class Info extends Schema.Class<Info>("Config.Trimming")({
  model: ConfigModel.Selection.pipe(optional).annotate({
    description: "Model used for manually requested context trimming",
  }),
}) {}
