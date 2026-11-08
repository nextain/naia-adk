"use strict";
const fs = require("node:fs");
const path = require("node:path");

// An instance opts a service into hash-bound scripts, never individual releases.
function verifyPlannedScript({ config, plan, command, entry, files, services, kind }) {
  const cfg = config && config.plannedScripts;
  if (!cfg || cfg.enabled !== true) return null;
  const no = why => ({ ok: false, why: `고정 대본 결합 거부: ${why}` });
  if (![cfg.services, cfg.roots, cfg.systemdUserUnits].every(a => Array.isArray(a) && a.every(v => typeof v === "string"))) return no("인스턴스 대본 설정 배열 형식 오류");
  if (!services.some(s => cfg.services.includes(s))) return null;
  if (!services.every(s => (cfg.services || []).includes(s))) return no("서비스가 인스턴스 설정 범위를 벗어남");
  if (!plan || !services.every(s => (plan.services || []).includes(s))) return no("계획 서비스 범위를 벗어남");
  const entries = [...(plan.scenario || []), ...(plan.incident?.actions || [])];
  if (entries.filter(e => e.id === entry.id).length !== 1) return no("계획 단계 식별자가 고유하지 않음");
  if (/^r/.test(entry.id) && entry.branch !== "rollback") return no("되돌리기 단계 branch 불일치");
  if (kind === "rollback" && (!/^r[0-9]+$/.test(entry.id) || entry.branch !== "rollback")) return no("되돌리기 종류는 고정 되돌리기 단계에만 허용");
  // Deliberately no shell prefixes, quoting, arguments, substitutions or chaining.
  const invocation = config.plannedScripts.allowSudo === true && command.startsWith("sudo ") ? command.slice(5) : command;
  const m = /^bash (\/[A-Za-z0-9_./-]+) ([sr][0-9]+)$/.exec(invocation);
  if (!m || m[2] !== entry.id) return no("단일 bash 절대경로 단계 명령만 허용");
  const script = path.resolve(m[1]);
  if (script !== m[1]) return no("비정규 대본 경로");
  if (!files.has(script)) return no("실행 대본이 단계의 sha256 고정 파일에 없음");
  let real;
  try { real = fs.realpathSync(script); } catch { return no("대본 실제 경로 확인 실패"); }
  if (real !== script || !(cfg.roots || []).some(dir => {
    if (!path.isAbsolute(dir)) return false;
    let root; try { root = fs.realpathSync(dir); } catch { return false; }
    if (root !== dir) return false;
    const rel = path.relative(root, real);
    return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  })) return no("대본 경로가 인스턴스 roots 범위를 벗어남");
  const allowedUnits = new Set(cfg.systemdUserUnits || []);
  for (const body of files.values()) {
    // All literal user unit references in a pinned script must be registered.
    // Dynamic unit construction is not granted authority by this check: the
    // independently reviewed immutable plan remains the authority for bytes.
    for (const line of body.split("\n")) {
      if (!(/\bsystemctl\b/.test(line) && /--user\b/.test(line)) && !/\buserctl\s/.test(line)) continue;
      for (const unit of line.match(/[A-Za-z0-9_@.-]+\.(?:service|timer|target|socket|path)/g) || []) {
        if (!allowedUnits.has(unit)) return no(`미등록 사용자 unit: ${unit}`);
      }
    }
  }
  return { ok: true, plannedScript: true, ops: kind === "ops", fact: "인스턴스 범위·단일 단계·고정 대본 sha256 결합 확인" };
}
function classifyPlannedScripts(tokens, cwd, config) {
  const cfg = config && config.plannedScripts;
  if (!cfg || cfg.enabled !== true) return [];
  if (![cfg.services, cfg.roots].every(a => Array.isArray(a) && a.every(v => typeof v === "string"))) return [{ service: "unclassified:planned-script-config", unclassified: true, label: "잘못된 고정 대본 설정" }];
  const argv = tokens || [];
  const program = path.basename(argv[0] || "");
  let word = null;
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(program)) {
    const invocation = require("./effective-argv.js").shellInvocation(argv);
    if (invocation.script >= 0) word = argv[invocation.script];
  } else if (argv[0] === "source" || argv[0] === ".") word = argv[1];
  else if ((argv[0] || "").includes("/")) word = argv[0];
  let matches = false;
  if (typeof word === "string" && !word.startsWith("-")) {
    const full = path.resolve(cwd || ".", word);
    let real; try { real = fs.realpathSync(full); } catch {
      return (cfg.services.length ? cfg.services : ["unclassified:planned-script-path"]).map(service => ({ service, unclassified: true, label: "실행 대본 실제 경로를 확인할 수 없음" }));
    }
    matches = cfg.roots.some(dir => {
      if (!path.isAbsolute(dir)) return false;
      let root; try { root = fs.realpathSync(dir); } catch { root = path.resolve(dir); }
      const inside = value => { const rel = path.relative(root, value); return rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
      // Both lexical attempts and resolved targets remain subject to the gate.
      return inside(full) || (real && inside(real));
    });
  }
  return matches ? cfg.services.map(service => ({ service, label: "고정 계획 운영 대본" })) : [];
}
module.exports = { verifyPlannedScript, classifyPlannedScripts };
