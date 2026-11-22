import path from "node:path";
import { readFile, realpath } from "node:fs/promises";

export const WORK_LEDGER_OWNER_KINDS = ["user", "group", "project", "org"];

// Legacy installations may have no manifest. An agent seat keeps its memory while
// the user, group or project that owns the work keeps the ledger for that role.
export async function assertLedgerOwner(root) {
  let directory = path.resolve(root);
  // A new installation directory can be below a symlinked seat.
  for (;;) {
    try { directory = await realpath(directory); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
  }
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "adk.json"), "utf8"));
      if (manifest?.kind === "agent")
        throw new Error("Agent workspaces cannot own a work ledger; use the owning user, group or project workspace");
      if (WORK_LEDGER_OWNER_KINDS.includes(manifest?.kind)) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
