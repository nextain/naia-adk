"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const PROD_PATTERNS = [
	{ pattern: /\bvercel\b.*(?:--prod|--production)\b/, platform: "vercel", label: "vercel --prod" },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+deploy\s+(\S+)/, platform: "gcloud", label: "gcloud run deploy", serviceGroup: 1 },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+app\s+deploy\b/, platform: "gcloud", label: "gcloud app deploy" },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+builds?\s+submit\b/, platform: "gcloud", label: "gcloud builds submit", alwaysBlock: true },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+services?\s+update\s+(\S+)/, platform: "gcloud", label: "gcloud run services update", serviceGroup: 1 },
	{ pattern: /\bgcloud(?:\s+(?:alpha|beta|preview|--[a-z0-9-]+(?:=\S+|\s+\S+)?|-q))*\s+run\s+services?\s+replace\b/, platform: "gcloud", label: "gcloud run services replace", alwaysBlock: true },
	{ pattern: /\bdocker(?:\s+(?:--?[a-zA-Z0-9-]+(?:=\S+|\s+\S+)?))*\s+(?:image\s+)?push\s+\S*(?:pkg\.dev|gcr\.io)\b/, platform: "gcloud", label: "docker push (registry)" },
];

const {findApprovalGateRoot,hasApprovalPlanGate}=require("./deploy-policy-roots.cjs");
const POLICY_SCOPE_ENTERED=Symbol("registered policy scope");

/**
 * deploy-guard — block prod deploy unless approved via approval-plan gate
 * (계획서 → 적대 리뷰 → 관문 발급 승인 코드 → 실행 때 바이트·고정 파일 sha 대조).
 * @param opts.deployDir REQUIRED — host config dir (adapter passes
 *   path.resolve(its __dirname,"..","deploy")).
 */
async function deploy(command, data, opts) {
	const DEPLOY_DIR = (opts && opts.deployDir) || path.resolve(__dirname, "..", "..", "..", ".claude", "deploy");
	const AUDIT_PATH = process.env.DEPLOY_AUDIT_PATH || path.join(DEPLOY_DIR, "audit.jsonl");
	const loadJSON = (fp, fb) => { try { return JSON.parse((opts?.policyData?.get(fp) || fs.readFileSync(fp)).toString("utf8")); } catch { return fb; } };
	const appendAudit = (entry) => {
		try {
			fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
			entry.ts = new Date().toISOString();
			fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n");
		} catch {}
	};
	const detectProject = (cmd, cfg, dir) => {
		for (const [name, proj] of Object.entries(cfg.projects || {})) {
			if (proj.platform === "vercel" && /\bvercel\b/.test(cmd)) {
				if (/(?:--prod|--production)\b/.test(cmd)) { if (dir.includes(proj.cwd)) return name; }
			}
			if (proj.platform === "gcloud" && /\bgcloud\b.*\brun\s+(?:deploy|services?\s+update)\b/.test(cmd)) {
				const sm = cmd.match(/\brun\s+(?:deploy|services?\s+update)\s+(\S+)/);
				if (sm) {
					const service = sm[1];
					if (name === service || proj.prod_command?.includes(service)) {
						if (proj.dev_service && service === proj.dev_service) continue;
						return name;
					}
				}
			}
		}
		if (/\bvercel\b/.test(cmd) && /(?:--prod|--production)\b/.test(cmd)) {
			for (const [name, proj] of Object.entries(cfg.projects || {})) {
				if (proj.platform === "vercel" && dir.includes(proj.cwd)) return name;
			}
		}
		return null;
	};
	const findApproval = (approvalsPath, project) => {
		const approvals = loadJSON(approvalsPath, { approvals: [] });
		const now = new Date();
		for (const a of approvals.approvals || []) {
			if (a.project !== project) continue;
			if (new Date(a.expires_at) > now) return a;
		}
		return null;
	};
	const consumeApproval = (approvalsPath, project, approvedAt) => {
		try {
			const raw = fs.readFileSync(approvalsPath, "utf8");
			const approvals = JSON.parse(raw);
			const before = approvals.approvals.length;
			approvals.approvals = approvals.approvals.filter(
				(a) => !(a.project === project && a.approved_at === approvedAt && a.single_use));
			if (approvals.approvals.length < before) fs.writeFileSync(approvalsPath, JSON.stringify(approvals, null, 2));
		} catch {}
	};

	const cwd = (data && data.cwd) || process.cwd();
	const sessionId = (data && data.session_id) || "unknown";
	const primaryRoot = (opts && opts.rootDir) ? path.resolve(opts.rootDir) : findApprovalGateRoot(cwd, DEPLOY_DIR);
	const stripped = core.stripQuotesUnwrap(command);

	const hooksLibDir = path.resolve(__dirname, "..", "..", "..", ".claude", "hooks", "lib");
	const { shellClauses } = require(path.join(hooksLibDir, "git-command-parser.js"));
	const {
		classifyProdMutations,
		clauseText,
		executedShellFile,
		extractCommandTargets,
		classifyUnresolvedScriptTargets,
		classifyBaselineSudo,
		SCRIPT_READ_LIMIT,
	} = require(path.join(hooksLibDir, "deploy-command-classifier.js"));
	const { effectiveCommands } = require(path.join(hooksLibDir, "effective-argv.js"));
	const {
		assessReadiness,
		loadDeployGateConfig,
		canonicalTargetPath,
		findPolicyRootForPath,
		inspectDeployPolicyErrors,
		TEMPLATE: READINESS_TEMPLATE,
	} = require(path.join(hooksLibDir, "deploy-readiness.js"));
	const deployPlan = require(path.join(hooksLibDir, "deploy-plan.js"));

	// cwd 기반 루트와 명령이 실행하려는 대본/경로의 소속 저장소 루트를 모두 모은다(둘이 다르면 둘 다 적용).
	const evalRoots = [];
	const seenRootKeys = new Set();
	const addRoot = (candidate) => {
		if (!candidate) return;
		const resolved = path.resolve(candidate);
		const canonKey = canonicalTargetPath(resolved, "/");
		if (seenRootKeys.has(canonKey)) return;
		seenRootKeys.add(canonKey);
		evalRoots.push(resolved);
	};
	addRoot(primaryRoot);
 let registeredOperation=false;
 if(opts?.registeredRoot){
  const registeredRoot=path.resolve(opts.registeredRoot),cfg=loadDeployGateConfig(registeredRoot);
  const ownsPath=file=>{if(!file)return false;const relative=path.relative(registeredRoot,canonicalTargetPath(file,cwd));return!relative||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);};
  const knownTargets=extractCommandTargets(command,cwd,registeredRoot);
  const ownsService=classifyProdMutations(command,cwd,0,false,registeredRoot).some(hit=>require(path.join(hooksLibDir,"deploy-readiness.js")).matchServiceRule(hit.service,cfg));
  registeredOperation=ownsPath(cwd)||[...knownTargets.paths,...knownTargets.dirs].some(ownsPath)||ownsService;
  if(registeredOperation)addRoot(registeredRoot);
 }


 if(opts?.withPolicyRoot&&!opts[POLICY_SCOPE_ENTERED])return opts.withPolicyRoot(primaryRoot,registeredOperation,()=>deploy(command,data,{...opts,[POLICY_SCOPE_ENTERED]:true}));

	const targets = extractCommandTargets(command, cwd);
	if (targets.errors.length) {
		appendAudit({ event: "blocked-policy-read", session: sessionId, command: command.substring(0, 300), errors: targets.errors });
		return {
			reason: [
				"[Harness] 실행 대상 경로를 확인할 수 없어 막습니다(fail-closed).",
				...targets.errors.map((e) => `- ${e}`),
			].join("\n"),
		};
	}
	if (!(opts && opts.rootDir) && !process.env.DEPLOY_READINESS_ROOT) {
		const cwdPolicyRoot = findPolicyRootForPath(canonicalTargetPath(cwd, "/"));
		if (cwdPolicyRoot) addRoot(cwdPolicyRoot);
		for (const tp of [...targets.paths, ...targets.dirs]) {
			const scriptRoot = findPolicyRootForPath(tp);
			if (scriptRoot) addRoot(scriptRoot);
		}
	}

	const policyReadErrors = [];
	for (let i = 0; i < evalRoots.length; i++) {
		const r = evalRoots[i];
		const { errors } = inspectDeployPolicyErrors(r, {
			deployDir: i === 0 ? DEPLOY_DIR : path.join(r, ".claude", "deploy"),
			checkDeployGateEnv: i === 0,
		});
		for (const e of errors) if (!policyReadErrors.includes(e)) policyReadErrors.push(e);
	}
	if (policyReadErrors.length) {
		appendAudit({ event: "blocked-policy-read", session: sessionId, command: command.substring(0, 300), errors: policyReadErrors });
		return {
			reason: [
				"[Harness] 배포 정책 파일을 읽거나 해석하지 못해 막습니다(fail-closed).",
				...policyReadErrors.map((e) => `- ${e}`),
			].join("\n"),
		};
	}

	const clauses = shellClauses(command);
	const isCoveredByLegacyPlatform = (hit) => {
		if (!hit || hit.unclassified || typeof hit.service !== "string") return false;
		return (
			hit.service === "vercel:prod" ||
			hit.service === "gcloud:app:default" ||
			hit.service === "gcloud:builds:submit" ||
			hit.service.startsWith("gcloud:run:")
		);
	};

	const evaluateRootClassification = (rootDir, isPrimary) => {
		const rDeployDir = isPrimary ? DEPLOY_DIR : path.join(rootDir, ".claude", "deploy");
		const rConfigPath = path.join(rDeployDir, "config.json");
		const rApprovalsPath = path.join(rDeployDir, "approvals.json");
		const rConfig = loadJSON(rConfigPath, { projects: {} });
		const isDevService = (service) => {
			if (!service) return false;
			const s = String(service).toLowerCase();
			if (s.endsWith("-dev")) return true;
			for (const proj of Object.values(rConfig.projects || {})) {
				if (proj.dev_service && String(proj.dev_service).toLowerCase() === s) return true;
			}
			return false;
		};
		const matchLegacy = (rawClause) => {
			const subClauses = shellClauses(core.stripQuotesUnwrap(rawClause));
			const list = subClauses.length
				? subClauses.map((t) => t.join(" ").replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1"))
				: [rawClause];
			for (const sub of list) {
				for (const p of PROD_PATTERNS) {
					const m = sub.match(p.pattern);
					if (!m) continue;
					if (p.platform === "gcloud" && p.serviceGroup && !p.alwaysBlock && isDevService(m[p.serviceGroup])) continue;
					return { pattern: p, clause: sub };
				}
			}
			return null;
		};

		const useLegacyApprovals =
			fs.existsSync(rApprovalsPath) &&
			(!isPrimary || (!process.env.DEPLOY_READINESS_ROOT && !process.env.DEPLOY_APPROVAL_STATE_DIR)) &&
			!hasApprovalPlanGate(rootDir);

		const precomputedMutations = classifyProdMutations(command, cwd, 0, false, rootDir).filter((hit) => {
			if (hit && typeof hit.service === "string" && hit.service.startsWith("gcloud:run:")) {
				const svcName = hit.service.slice("gcloud:run:".length);
				if (svcName !== "replace" && isDevService(svcName)) return false;
			}
			return true;
		});
		const nonDevLegacyMatches = [];
		for (const tokens of clauses) {
			if (tokens.length === 0 || /^(?:echo|printf)$/.test(tokens[0])) continue;
			const rawClause = tokens.join(" ").replace(/'([^']*)'/g, "$1").replace(/"([^"]*)"/g, "$1");
			const matched = matchLegacy(rawClause);
			if (matched) nonDevLegacyMatches.push({ ...matched, tokens });
		}
		const onlyLegacyMutations =
			precomputedMutations.length === 0 ||
			(nonDevLegacyMatches.length > 0 && precomputedMutations.every(isCoveredByLegacyPlatform));

		if (useLegacyApprovals && onlyLegacyMutations) {
			const firstLegacy = nonDevLegacyMatches[0];
			const matchedPattern = firstLegacy ? firstLegacy.pattern : null;
			if (!matchedPattern) return { matched: false };
			const project = detectProject(firstLegacy.clause, rConfig, cwd);
			const approval = !matchedPattern.alwaysBlock ? findApproval(rApprovalsPath, project) : null;
			if (approval) {
				return {
					matched: true,
					legacyApproved: { approvalsPath: rApprovalsPath, project, approval },
				};
			}
			const projectLabel = project || "(project not detected from cwd)";
			const remainingMin = rConfig.default_ttl_minutes || 30;
			return {
				matched: true,
				legacyBlock: {
					audit: {
						event: "blocked", project: project || "unknown",
						command: stripped.substring(0, 200), session: sessionId,
						reason: project ? "no_approval" : "unknown_project",
					},
					reason:
						`[Harness] prod 배포 명령 차단: \`${matchedPattern.label}\`\n` +
						`프로젝트: ${projectLabel}\n\n` +
						"prod 배포는 사전 승인이 필요합니다.\n\n" +
						"승인 방법:\n" +
						`  1. .claude/deploy/approvals.json에 "${project || "project"}" 승인 항목 추가\n` +
						`  2. 또는 .claude/deploy/prod-deploy.sh 사용\n\n` +
						`승인 TTL: ${remainingMin}분\n` +
						"AI는 prod 배포를 직접 실행하지 않습니다.",
				},
			};
		}

		const hits = [...precomputedMutations];
		for (const { pattern: p, clause, tokens } of nonDevLegacyMatches) {
			if (
				hits.length > 0 &&
				[
					"vercel --prod",
					"gcloud run deploy",
					"gcloud app deploy",
					"gcloud builds submit",
					"gcloud run services update",
					"gcloud run services replace",
				].includes(p.label)
			) {
				continue;
			}
			const project = detectProject(clause, rConfig, cwd);
			hits.push({ service: `legacy:${project || p.label}`, label: p.label, project, clause: clauseText(tokens) });
		}
		const unclassified = hits.filter((hit) => hit.unclassified);
		const seen = new Set();
		const unique = hits.filter((h) => (seen.has(h.service) ? false : seen.add(h.service)));
		if (unique.length === 0) {
			let matches = [];
			try {
				matches = deployPlan.plansForCommand(command, rootDir);
				if (matches.length === 0) {
					for (const tokens of clauses) {
						if (!tokens.length || /^(?:echo|printf)$/.test(tokens[0])) continue;
						matches.push(...deployPlan.plansForCommand(clauseText(tokens), rootDir));
					}
				}
				// 단계 명령에 글자를 덧붙인 꼴(… 2>&1 | tail, timeout …, bash -c "…")도 관문에 건다. 승인은 하지 않고 글자 불일치로 막는다.
				if (matches.length === 0) matches.push(...deployPlan.plansCarryingCommand(command, rootDir, cwd));
			} catch { matches = []; }
			for (const m of matches) {
				const svc = Array.isArray(m.plan && m.plan.services) && m.plan.services.length ? m.plan.services : [`plan:${(m.plan && m.plan.planId) || "unknown"}`];
				for (const service of svc) if (!seen.has(service)) { seen.add(service); unique.push({ service, label: "계획서 단계 명령", clause: command.substring(0, 200) }); }
			}
		}
		return {
			matched: unclassified.length > 0 || unique.length > 0,
			root: rootDir,
			config: rConfig,
			hits,
			unclassified,
			unique,
		};
	};

	const rootResults = evalRoots.map((r, i) => evaluateRootClassification(r, i === 0));

	const allUnclassified = rootResults.flatMap((rr) => rr.unclassified || []);
	if (allUnclassified.length) {
		appendAudit({
			event: "blocked-unclassified",
			services: [...new Set(allUnclassified.map((hit) => hit.service))],
			session: sessionId,
			command: command.substring(0, 300),
			items: allUnclassified.map(({ service, label, clause, file }) => ({ service, label, clause, file: file || null })),
		});
		const lines = ["[Harness] 운영 도구가 보이지만 대상을 분류하지 못해 차단합니다."];
		for (const hit of allUnclassified.slice(0, 10)) {
			lines.push(`서비스: ${hit.service}`, `분류: ${hit.label}`, `절: ${hit.clause || "(원래 절을 확인할 수 없음)"}`, `스크립트 파일: ${hit.file || "(스크립트 파일 없음)"}`);
		}
		lines.push("", "대상을 글자 그대로 적거나 감싸기 인자를 고정하십시오.");
		return { reason: lines.join("\n") };
	}

	const opaque = effectiveCommands(command, cwd).find((e) => e.opaque);
	if (opaque) {
		appendAudit({ event: "blocked-opaque", session: sessionId, command: command.substring(0, 300), reason: opaque.opaque });
		return {
			reason: [
				`[Harness] 무엇이 실행되는지 확인할 수 없어 막습니다: ${opaque.opaque}`,
				"",
				"셸에 넘기는 프로그램은 파일로 저장한 뒤 bash <파일> 로 실행하거나, 명령에 그대로 적으십시오. 따옴표가 닫히지 않았다면 고쳐서 다시 실행하십시오.",
			].join("\n"),
		};
	}

	const tooLarge = effectiveCommands(command, cwd)
		.map((e) => executedShellFile(e.argv, e.dir, e.dirKnown !== false, command, true))
		.find((f) => {
			if (!f) return false;
			try { return fs.statSync(f).size > SCRIPT_READ_LIMIT; } catch { return false; }
		});
	if (tooLarge) {
		appendAudit({ event: "blocked-opaque", session: sessionId, command: command.substring(0, 300), reason: `script too large: ${tooLarge}` });
		return {
			reason: [
				`[Harness] 무엇이 실행되는지 확인할 수 없어 막습니다: 스크립트가 커서(${SCRIPT_READ_LIMIT / 1024 / 1024}MB 넘음) 안을 읽지 않습니다(${tooLarge})`,
				"",
				"스크립트를 나눠 주십시오. 승인자에게 붙여 넣어 실행할 명령을 넘기지 마십시오(승인 보고 양식으로 승인 요청).",
			].join("\n"),
		};
	}

	const matchedRoots = rootResults.filter((rr) => rr.matched);
	const blockOnBaseline = () => {
		const unresolvedHits = classifyUnresolvedScriptTargets(command, cwd);
		if (unresolvedHits.length) {
			appendAudit({
				event: "blocked-unclassified",
				services: [...new Set(unresolvedHits.map((h) => h.service))],
				session: sessionId,
				command: command.substring(0, 300),
				items: unresolvedHits.map(({ service, label, clause }) => ({ service, label, clause })),
			});
			return {
				reason: [
					"[Harness] 실행하려는 대본을 확인할 수 없어 막습니다(fail-closed).",
					...unresolvedHits.map((h) => `- ${h.label}: ${h.clause}`),
				].join("\n"),
			};
		}
		const sudoHits = classifyBaselineSudo(command, cwd);
		if (sudoHits.length) {
			appendAudit({
				event: "blocked-sudo-baseline",
				services: [...new Set(sudoHits.map((h) => h.service))],
				session: sessionId,
				command: command.substring(0, 300),
				items: sudoHits.map(({ service, label, clause }) => ({ service, label, clause })),
			});
			return {
				reason: [
					"[Harness] 승인된 저장소 정책 없이 sudo 명령을 실행할 수 없어 기본 차단 목록으로 막습니다(fail-closed).",
					...sudoHits.map((h) => `- [${h.service}] ${h.label}: ${h.clause}`),
				].join("\n"),
			};
		}
		return null;
	};

	if (matchedRoots.length === 0) return blockOnBaseline();

	const pendingLegacy = [];
	const notices = [];
	let hadPlanEvaluation = false;

	for (const mr of matchedRoots) {
		if (mr.legacyBlock) {
			appendAudit(mr.legacyBlock.audit);
			return { reason: mr.legacyBlock.reason };
		}
		if (mr.legacyApproved) {
			pendingLegacy.push(mr.legacyApproved);
			continue;
		}
		hadPlanEvaluation = true;
		const prodServices = mr.unique.map((h) => h.service);
		const runText = [...new Set(mr.hits.map((h) => h.clause).filter(Boolean))].join(" ; ") || command;
		const gateConfigInfo = loadDeployGateConfig(mr.root);
		const gateConfig = (gateConfigInfo && gateConfigInfo.config) || {};
		const evaluation = {
			command,
			cwd,
			services: prodServices,
			sessionId,
			transcriptPath: data && data.transcript_path,
			root: mr.root,
			approverId: (gateConfig.approver && gateConfig.approver.discordUserId) || (mr.config.approver && mr.config.approver.discordUserId),
			readiness: (planBinding) => assessReadiness(prodServices, { root: mr.root, auditPath: AUDIT_PATH, command: runText, cwd, planBinding }),
			readinessTemplate: READINESS_TEMPLATE,
			fileRefs: () => deployPlan.referencedFiles(command, cwd),
		};
		const res = opts?.withPlanScope ? await opts.withPlanScope(evaluation, ctx => deployPlan.evaluate(ctx)) : await deployPlan.evaluate(evaluation);
		appendAudit({ ...(res.audit || {}), services: prodServices, session: sessionId, command: command.substring(0, 300) });
		if (!res.allow) return { reason: res.reason };
		if (res.notice) notices.push(res.notice);
	}

	if (!hadPlanEvaluation) {
		const baselineBlock = blockOnBaseline();
		if (baselineBlock) return baselineBlock;
	}

	for (const { approvalsPath, project, approval } of pendingLegacy) {
		appendAudit({
			event: "executed", project: project || "unknown", session: sessionId,
			command: stripped.substring(0, 200), original_command: command.substring(0, 200),
			approved_by: approval.approved_by, approval_expires: approval.expires_at,
		});
		if (approval.single_use) {
			consumeApproval(approvalsPath, project, approval.approved_at);
			appendAudit({ event: "approval_consumed", project: project || "unknown", single_use: true });
		}
	}
	for (const notice of notices) process.stderr.write(`${notice}\n`);
	return null;
}


module.exports={deploy};
