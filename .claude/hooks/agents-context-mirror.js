#!/usr/bin/env node
/**
 * Agents Context Mirror — PostToolUse(Edit|Write)
 *
 * .agents/context/*.json (기계 SoT) 수정 시 .users/context/*.md 를 자동 생성.
 * AI 수동 미러 제거 → 누락/불일치/토큰 2배 작성 방지.
 *
 * SoT = json. md 는 항상 json 에서 파생 (사람 읽기용 렌더 + 자동생성 헤더).
 */
const fs = require("fs");
const path = require("path");

let input = "";
try { input = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
let data;
try { data = JSON.parse(input); } catch { process.exit(0); }

const fp = (data && (
  (data.tool_response && data.tool_response.filePath) ||
  (data.tool_input && data.tool_input.file_path)
)) || "";
if (!fp) process.exit(0);

// .agents/context/<name>.json 만 대상
const m = fp.match(/^(.*)\/\.agents\/context\/([^/]+)\.json$/);
if (!m) process.exit(0);

const projectRoot = m[1];
const name = m[2];
const jsonPath = fp;
const mdPath = path.join(projectRoot, ".users", "context", `${name}.md`);

if (!fs.existsSync(jsonPath)) process.exit(0);
if (!fs.existsSync(path.dirname(mdPath))) process.exit(0); // .users/context 없으면 skip (미러 미사용 프로젝트)

let obj;
try { obj = JSON.parse(fs.readFileSync(jsonPath, "utf8")); } catch { process.exit(0); }

// json → md 렌더 (재귀: object=섹션, array=리스트, scalar=값)
function render(node, depth) {
  const h = "#".repeat(Math.min(depth, 6));
  let out = "";
  if (Array.isArray(node)) {
    for (const v of node) {
      if (v && typeof v === "object") out += render(v, depth) + "\n";
      else out += `- ${String(v)}\n`;
    }
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("$")) continue;
      if (v && typeof v === "object") {
        out += `\n${h} ${k}\n\n` + render(v, depth + 1);
      } else {
        out += `- **${k}**: ${String(v)}\n`;
      }
    }
    return out;
  }
  return `${String(node)}\n`;
}

const header =
  `<!-- AUTO-GENERATED from .agents/context/${name}.json — DO NOT EDIT BY HAND.\n` +
  `     SoT = json. 수정은 json 에서, 이 파일은 hook 이 자동 동기화. -->\n\n` +
  `# ${name} (mirror)\n\n` +
  `> 기계 SoT: \`.agents/context/${name}.json\` — 이 md 는 자동 파생.\n`;

const body = render(obj, 2);

try {
  fs.writeFileSync(mdPath, header + body, "utf8");
  console.log(JSON.stringify({
    systemMessage: `[mirror] .users/context/${name}.md 자동 동기화 완료 (SoT: ${name}.json)`,
    suppressOutput: true,
  }));
} catch (e) {
  // 미러 실패는 차단하지 않음 (경고만)
  console.log(JSON.stringify({ systemMessage: `[mirror] ${name}.md 동기화 실패: ${e.message}` }));
}
process.exit(0);
