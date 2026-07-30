const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mirrorHook = require("../agents-context-mirror.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-context-mirror-"));
try {
  const sourceDir = path.join(root, ".agents", "context");
  const mirrorDir = path.join(root, ".users", "context");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });
  const source = path.join(sourceDir, "example.json");
  fs.writeFileSync(source, JSON.stringify({ rule: "AGENTS.md is canonical" }));

  const first = mirrorHook.syncContextMirror({ tool_input: { file_path: source } }, root);
  assert.equal(first.updated, true);
  const mirror = path.join(mirrorDir, "example.md");
  assert.match(fs.readFileSync(mirror, "utf8"), /AGENTS\.md is canonical/);

  fs.writeFileSync(source, JSON.stringify({ rule: "mirror restored from canonical" }));
  const second = mirrorHook.syncContextMirror({
    tool_response: { file_path: path.relative(root, source) },
  }, root);
  assert.equal(second.updated, true);
  assert.match(fs.readFileSync(mirror, "utf8"), /mirror restored from canonical/);
  assert.equal(
    mirrorHook.syncContextMirror({ tool_input: { file_path: path.join(root, "other.json") } }, root).updated,
    false,
  );
  console.log("agents context mirror tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}