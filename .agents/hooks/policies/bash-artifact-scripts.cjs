"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const {PYTHON_BIN_RE,NODE_BIN_RE,OTHER_SCRIPT_BIN_RE,DIRECT_SCRIPT_EXT_RE,UV_TWO_ARG_FLAGS,NODE_TWO_ARG_FLAGS,isInterpreterName,isShellBin,skipLeadingCommandWrappers,extractFileTransferOp,resolvePlaceholderScript}=require("./bash-artifact-wrappers.cjs");
const {expandHomePath}=require("./bash-artifact-context.cjs");
function extractScriptFromTokens(rawTokens, effectiveCwd, context = {}) {
	const tokens = [...rawTokens];
	let idx = skipLeadingCommandWrappers(tokens, 0, context);

	if (idx >= tokens.length) return null;
	let cmdToken = tokens[idx];
	let cmdBase = path.basename(cmdToken);

	// Handle uv run / poetry run / pipenv run / pdm run
	if ((cmdBase === "uv" || cmdBase === "poetry" || cmdBase === "pipenv" || cmdBase === "pdm") && tokens[idx + 1] === "run") {
		idx += 2;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "--") {
				idx++;
				break;
			}
			if (UV_TWO_ARG_FLAGS.has(tok)) {
				idx += 2;
				continue;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			break;
		}
		if (idx >= tokens.length) return null;
		const nextBase = path.basename(tokens[idx]);
		if (isInterpreterName(nextBase)) {
			cmdToken = tokens[idx];
			cmdBase = nextBase;
		} else {
			return resolvePlaceholderScript(tokens[idx], context);
		}
	}

	// Handle npx / pnpx / bunx / pnpm / yarn / npm invoking tsx / ts-node / node
	if (/^(?:npx|pnpx|bunx|pnpm|yarn)$/i.test(cmdBase)) {
		let scan = idx + 1;
		while (scan < tokens.length) {
			const tok = tokens[scan];
			if (tok === "exec" || tok === "dlx" || tok === "run" || tok === "-y" || tok === "--yes") {
				scan++;
				continue;
			}
			if ((tok === "-p" || tok === "--package") && scan + 1 < tokens.length) {
				scan += 2;
				continue;
			}
			if (tok.startsWith("-")) {
				scan++;
				continue;
			}
			break;
		}
		if (scan < tokens.length && isInterpreterName(path.basename(tokens[scan]))) {
			idx = scan;
			cmdToken = tokens[idx];
			cmdBase = path.basename(cmdToken);
		}
	}

	if (PYTHON_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-c" || tok === "--command" || (tok.startsWith("-c") && tok.length > 2)) {
				return { inlineCode: `${cmdBase} -c` };
			}
			if (tok === "-m" && idx + 1 < tokens.length) {
				const modName = tokens[idx + 1];
				const modRel = modName.replace(/\./g, "/");
				const candidates = [
					`${modRel}.py`,
					`${modRel}/__main__.py`,
					`${modRel}/__init__.py`,
				];
				for (const relCandidate of candidates) {
					const absCandidate = path.resolve(effectiveCwd, relCandidate);
					try {
						if (fs.existsSync(absCandidate) && fs.statSync(absCandidate).isFile()) {
							return { scriptArg: relCandidate };
						}
					} catch {
						/* ignore */
					}
				}
				if (modName.includes(".")) {
					const topPkg = modRel.split("/")[0];
					const topPkgAbs = path.resolve(effectiveCwd, topPkg);
					try {
						if (fs.existsSync(topPkgAbs) && fs.statSync(topPkgAbs).isDirectory()) {
							return { scriptArg: `${modRel}.py` };
						}
					} catch {
						/* ignore */
					}
				}
				// External/stdlib module (e.g. pytest, unittest, pip): -m consumes the rest of argv
				return null;
			}
			if ((tok === "-W" || tok === "-X") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				return { stdinProgram: cmdBase };
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		if (context.viaXargs && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			return { scriptArg: context.pipedCandidates[0] };
		}
		if (context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		return null;
	}

	if (NODE_BIN_RE.test(cmdBase)) {
		idx++;
		if (cmdBase.toLowerCase() === "bun" && tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "--eval" || tok === "-p" || tok === "--print") {
				return { inlineCode: `${cmdBase} ${tok}` };
			}
			if (NODE_TWO_ARG_FLAGS.has(tok) && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				return { stdinProgram: cmdBase };
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		if (context.viaXargs && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			return { scriptArg: context.pipedCandidates[0] };
		}
		if (context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		return null;
	}

	if (cmdBase.toLowerCase() === "deno") {
		idx++;
		if (tokens[idx] === "run") idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "eval") return { inlineCode: "deno eval" };
			if ((tok === "--config" || tok === "-c" || tok === "--import-map" || tok === "--lock") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") return { stdinProgram: "deno" };
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (context.fromPipe) return { stdinProgram: "deno" };
		return null;
	}

	if (isShellBin(cmdBase)) {
		idx++;
		let stdinFlag = false;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-c" && idx + 1 < tokens.length) {
				return { inlineCommand: tokens[idx + 1], inlineCode: `${cmdBase} -c` };
			}
			if (tok === "-s") {
				stdinFlag = true;
				idx++;
				continue;
			}
			if ((tok === "-o" || tok === "+o") && idx + 1 < tokens.length) {
				idx += 2;
				continue;
			}
			if (tok === "-") {
				stdinFlag = true;
				idx++;
				break;
			}
			if (tok === "--") {
				idx++;
				break;
			}
			if (tok.startsWith("-") || tok.startsWith("+")) {
				idx++;
				continue;
			}
			if (stdinFlag) {
				return { stdinProgram: cmdBase };
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (stdinFlag || context.fromPipe) {
			return { stdinProgram: cmdBase };
		}
		if (idx < tokens.length) {
			return resolvePlaceholderScript(tokens[idx], context);
		}
		return null;
	}

	if (OTHER_SCRIPT_BIN_RE.test(cmdBase)) {
		idx++;
		while (idx < tokens.length) {
			const tok = tokens[idx];
			if (tok === "-e" || tok === "-Command" || tok === "-c" || tok === "-r") {
				return { inlineCode: `${cmdBase} ${tok}` };
			}
			if (tok === "-File" || tok === "-f") {
				if (idx + 1 < tokens.length) return resolvePlaceholderScript(tokens[idx + 1], context);
				return null;
			}
			if (tok === "-") return { stdinProgram: cmdBase };
			if (tok.startsWith("-")) {
				idx++;
				continue;
			}
			return resolvePlaceholderScript(tok, context);
		}
		if (context.fromPipe) return { stdinProgram: cmdBase };
		return null;
	}

	// Direct script path execution (e.g. ./stream_render.py, /tmp/gen.sh, scripts/bake.py)
	const expandedCmd = expandHomePath(cmdToken);
	if (
		cmdToken.includes("/") &&
		(DIRECT_SCRIPT_EXT_RE.test(cmdToken) ||
			expandedCmd.startsWith("/tmp/") ||
			expandedCmd.startsWith(os.tmpdir() + path.sep))
	) {
		return resolvePlaceholderScript(cmdToken, context);
	}

	return null;
}

function findExistingDir(startDir) {
	let cur = path.resolve(startDir);
	while (cur && !fs.existsSync(cur)) {
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return cur;
}

function checkScriptGitStatus(scriptArg, effectiveCwd) {
	const expanded = expandHomePath(scriptArg);
	const absScript = path.resolve(effectiveCwd, expanded);
	const probeDir = findExistingDir(path.dirname(absScript));

	const topRes = spawnSync("git", ["-C", probeDir, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (topRes.status !== 0 || !topRes.stdout || !topRes.stdout.trim()) {
		return { ok: false, state: "outside-git", absScript };
	}

	const repoRoot = fs.realpathSync.native
		? (() => {
				try {
					return fs.realpathSync.native(topRes.stdout.trim());
				} catch {
					return path.resolve(topRes.stdout.trim());
				}
			})()
		: path.resolve(topRes.stdout.trim());

	let realScript = absScript;
	if (fs.existsSync(absScript)) {
		try {
			realScript = fs.realpathSync.native ? fs.realpathSync.native(absScript) : fs.realpathSync(absScript);
		} catch {
			realScript = absScript;
		}
		try {
			const stat = fs.statSync(realScript);
			if (stat.isDirectory()) {
				const mainPy = path.join(realScript, "__main__.py");
				if (fs.existsSync(mainPy)) {
					realScript = mainPy;
				} else {
					return { ok: true, state: "directory", absScript, repoRoot };
				}
			}
		} catch {
			/* ignore */
		}
	} else {
		return { ok: false, state: "untracked", absScript, repoRoot };
	}

	const rel = path.relative(repoRoot, realScript);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return { ok: false, state: "outside-git", absScript };
	}
	const relPosix = rel.replace(/\\/g, "/");

	const headRes = spawnSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (headRes.status !== 0) {
		return { ok: false, state: "uncommitted-repo", absScript, repoRoot, relPosix };
	}

	const lsRes = spawnSync("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relPosix], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (lsRes.status !== 0) {
		return { ok: false, state: "untracked", absScript, repoRoot, relPosix };
	}

	const statusRes = spawnSync(
		"git",
		["-c", "core.quotePath=false", "-C", repoRoot, "status", "--porcelain", "--untracked-files=all", "--", relPosix],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (statusRes.status !== 0 || (statusRes.stdout && statusRes.stdout.trim().length > 0)) {
		return { ok: false, state: "modified", absScript, repoRoot, relPosix };
	}

	return { ok: true, state: "committed", absScript, repoRoot, relPosix };
}


module.exports={extractScriptFromTokens,checkScriptGitStatus};
