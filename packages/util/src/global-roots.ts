import os from "os"
import path from "path"

const home = os.homedir()
const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    // Keep the existing test harness's TMPDIR isolation on Linux.
    tmp: path.join(process.platform === "linux" && !process.env.OPENCODE_TEST_HOME ? "/tmp" : os.tmpdir(), app),
  }
}
