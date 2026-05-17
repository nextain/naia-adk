#!/usr/bin/env node
/**
 * ctx-index-rebuild.js — PostToolUse hook (Edit|Write)
 *
 * When any .agents/context/*.yaml ctx-section file is written,
 * rebuilds .agents/context/.ctx-index.json for fast section lookup.
 *
 * Index entry (per ctx-section file):
 *   { id, title, tags, related, updated_at, file }
 *
 * Non-ctx files (missing `id:` field) are skipped silently.
 * .ctx-index.json is gitignored — rebuilt on demand, never committed.
 */

const fs = require("fs");
const path = require("path");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = data.tool_name || "";
  const filePath =
    data.tool_input?.file_path || data.parameters?.file_path || "";

  if (toolName !== "Edit" && toolName !== "Write") process.exit(0);

  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.match(/\.agents\/context\/[^/]+\.yaml$/)) process.exit(0);

  // Derive the .agents/context/ directory from the written file's absolute path
  const contextDir = path.resolve(path.dirname(filePath));

  rebuildIndex(contextDir);
  process.exit(0);
}

/**
 * Parse ctx metadata from the first 30 lines of a YAML file.
 * Returns null if no `id:` field is found (non-ctx file).
 */
function extractCtxMeta(content, filename) {
  const lines = content.split("\n").slice(0, 30);
  const meta = { file: filename };
  let tagsList = null;
  let relatedList = null;
  let parsingTags = false;
  let parsingRelated = false;

  for (const line of lines) {
    if (line.startsWith("#")) continue; // skip comment lines

    if (line.startsWith("id:")) {
      meta.id = line.slice(3).trim();
      parsingTags = false;
      parsingRelated = false;
    } else if (line.startsWith("title:")) {
      meta.title = line.slice(6).trim().replace(/^["']|["']$/g, "");
      parsingTags = false;
      parsingRelated = false;
    } else if (line.startsWith("tags:")) {
      parsingTags = false;
      parsingRelated = false;
      const inline = line.match(/tags:\s*\[(.+)\]/);
      if (inline) {
        meta.tags = inline[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, ""));
      } else {
        tagsList = [];
        parsingTags = true;
      }
    } else if (line.startsWith("related:")) {
      parsingTags = false;
      parsingRelated = false;
      const inline = line.match(/related:\s*\[(.+)\]/);
      if (inline) {
        meta.related = inline[1]
          .split(",")
          .map((r) => r.trim().replace(/^["']|["']$/g, ""));
      } else {
        relatedList = [];
        parsingRelated = true;
      }
    } else if (line.startsWith("updated_at:")) {
      meta.updated_at = line.slice(11).trim().replace(/^["']|["']$/g, "");
      parsingTags = false;
      parsingRelated = false;
    } else if (parsingTags && line.match(/^\s+-\s+/)) {
      tagsList.push(
        line
          .replace(/^\s+-\s+/, "")
          .trim()
          .replace(/^["']|["']$/g, "")
      );
    } else if (parsingRelated && line.match(/^\s+-\s+/)) {
      relatedList.push(
        line
          .replace(/^\s+-\s+/, "")
          .trim()
          .replace(/^["']|["']$/g, "")
      );
    } else if (line.match(/^\S/) && !line.startsWith("#")) {
      // Non-indented non-comment line that isn't metadata — stop tag/related parsing
      parsingTags = false;
      parsingRelated = false;
    }
  }

  if (tagsList) meta.tags = tagsList;
  if (relatedList) meta.related = relatedList;

  return meta.id ? meta : null;
}

function rebuildIndex(contextDir) {
  try {
    const files = fs
      .readdirSync(contextDir)
      .filter((f) => f.endsWith(".yaml") && !f.startsWith("."))
      .sort();

    const entries = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(contextDir, file), "utf8");
        const meta = extractCtxMeta(content, file);
        if (meta) entries.push(meta);
      } catch {
        /* skip unreadable files */
      }
    }

    const index = {
      generated_at: new Date().toISOString(),
      entry_count: entries.length,
      entries,
    };

    fs.writeFileSync(
      path.join(contextDir, ".ctx-index.json"),
      JSON.stringify(index, null, 2),
      "utf8"
    );
  } catch {
    /* rebuild is best-effort — never crash the hook */
  }
}

main().catch(() => process.exit(0));
