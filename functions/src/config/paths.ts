import * as fs from "fs";
import * as path from "path";

/**
 * The bundled data folder (functions/data). Compiled code lives at different depths (lib/src/modules/…),
 * and the folder sits next to lib/ on Render, in Docker (/app/data) and in a Firebase deploy, so walk up to it.
 * LINGORA_DATA_DIR overrides it.
 */
function findDataDir(): string {
  if (process.env.LINGORA_DATA_DIR) return process.env.LINGORA_DATA_DIR;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "data");
    if (fs.existsSync(path.join(candidate, "vocab_de.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Couldn't find the data folder (vocab_de.json). Set LINGORA_DATA_DIR.");
}

let cached: string | null = null;
export const dataDir = () => (cached ??= findDataDir());
export const dataFile = (name: string) => path.join(dataDir(), name);
