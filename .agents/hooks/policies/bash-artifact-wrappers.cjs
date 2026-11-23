"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const {SHELLS,MULTICALL_BINARIES}=require("../../../.claude/hooks/lib/effective-argv.js");
function isShellBin(base) {
	return SHELLS.test(String(base || "").toLowerCase());
}

const PYTHON_BIN_RE = /^(?:python(?:\d+(?:\.\d+)*)?|py|pypy3?)$/i;
const NODE_BIN_RE = /^(?:node|nodejs|tsx|ts-node|bun)$/i;
const OTHER_SCRIPT_BIN_RE = /^(?:ruby|perl|php|rscript|pwsh|powershell)$/i;
const DIRECT_SCRIPT_EXT_RE = /\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|tsx|rb|pl|ps1)$/i;

const UV_TWO_ARG_FLAGS = new Set([
	"--python",
	"-p",
	"--with",
	"--with-editable",
	"--with-requirements",
	"--directory",
	"--project",
	"--config-file",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"--package",
	"--env-file",
]);

const NODE_TWO_ARG_FLAGS = new Set([
	"-r",
	"--require",
	"--import",
	"--loader",
	"--experimental-loader",
	"--tsconfig",
	"--env-file",
	"--conditions",
	"-C",
]);

const XARGS_TWO_ARG_FLAGS = new Set([
	"-L",
	"-n",
	"-P",
	"-s",
	"-a",
	"-d",
	"-E",
	"-e",
	"--max-args",
	"--max-procs",
	"--max-chars",
	"--arg-file",
	"--delimiter",
	"--eof",
	"--process-slot-var",
]);

const RSYNC_TWO_ARG_FLAGS = new Set([
	"-e",
	"--rsh",
	"--exclude",
	"--include",
	"--exclude-from",
	"--include-from",
	"--files-from",
	"--log-file",
	"--temp-dir",
	"--backup-dir",
	"--suffix",
	"--compare-dest",
	"--copy-dest",
	"--link-dest",
	"--chmod",
	"--chown",
	"--max-size",
	"--min-size",
	"--bwlimit",
	"--timeout",
	"--port",
]);

function isInterpreterName(base) {
	return (
		PYTHON_BIN_RE.test(base) ||
		NODE_BIN_RE.test(base) ||
		isShellBin(base) ||
		OTHER_SCRIPT_BIN_RE.test(base) ||
		base === "deno"
	);
}

function skipLeadingCommandWrappers(tokens, startIdx = 0, context = {}) {
	let idx = startIdx;
	while (idx < tokens.length) {
		const t = tokens[idx];
		if (t === "(" || t === "{" || t === "!" || t === "command" || t === "builtin" || t === "exec") {
			idx++;
			continue;
		}
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
			idx++;
			continue;
		}
		const base = path.basename(t);
		if (base === "env") {
			idx++;
			while (idx < tokens.length) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				if (
					(tokens[idx] === "-u" ||
						tokens[idx] === "--unset" ||
						tokens[idx] === "-C" ||
						tokens[idx] === "--chdir" ||
						tokens[idx] === "-S" ||
						tokens[idx] === "--split-string") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else if (tokens[idx].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
					idx++;
				} else {
					break;
				}
			}
			continue;
		}
		if (base === "nohup" || base === "time") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				idx++;
			}
			continue;
		}
		if (MULTICALL_BINARIES.includes(base.toLowerCase())) {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) idx++;
			continue;
		}
		if (base === "nice") {
			idx++;
			if ((tokens[idx] === "-n" || tokens[idx] === "--adjustment") && idx + 1 < tokens.length) idx += 2;
			else if (tokens[idx] && tokens[idx].startsWith("-")) idx++;
			continue;
		}
		if (base === "timeout") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (
					(tokens[idx] === "-k" ||
						tokens[idx] === "-s" ||
						tokens[idx] === "--kill-after" ||
						tokens[idx] === "--signal") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else {
					idx++;
				}
			}
			if (idx < tokens.length) idx++; // skip duration
			continue;
		}
		if (base === "sudo") {
			idx++;
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				if (tokens[idx] === "--") {
					idx++;
					break;
				}
				if (
					(tokens[idx] === "-u" ||
						tokens[idx] === "-g" ||
						tokens[idx] === "-C" ||
						tokens[idx] === "-D" ||
						tokens[idx] === "-h" ||
						tokens[idx] === "-p" ||
						tokens[idx] === "-r" ||
						tokens[idx] === "-t" ||
						tokens[idx] === "-T" ||
						tokens[idx] === "-U") &&
					idx + 1 < tokens.length
				) {
					idx += 2;
				} else {
					idx++;
				}
			}
			continue;
		}
		if (base === "xargs") {
			idx++;
			let replacePlaceholder = "{}";
			while (idx < tokens.length && tokens[idx].startsWith("-")) {
				const flag = tokens[idx];
				if (flag === "--") {
					idx++;
					break;
				}
				if (flag === "-I" || flag === "--replace") {
					if (idx + 1 < tokens.length) {
						replacePlaceholder = tokens[idx + 1] || "{}";
						idx += 2;
					} else {
						idx++;
					}
					continue;
				}
				if (flag.startsWith("-I") && flag.length > 2) {
					replacePlaceholder = flag.slice(2);
					idx++;
					continue;
				}
				if (flag.startsWith("--replace=")) {
					replacePlaceholder = flag.slice("--replace=".length) || "{}";
					idx++;
					continue;
				}
				if (XARGS_TWO_ARG_FLAGS.has(flag) && idx + 1 < tokens.length) {
					idx += 2;
					continue;
				}
				idx++;
			}
			context.viaXargs = true;
			context.placeholder = replacePlaceholder;
			continue;
		}
		if (base === "find") {
			let execIdx = -1;
			let findNameCandidate = null;
			const searchPaths = [];
			for (let j = idx + 1; j < tokens.length; j++) {
				const ft = tokens[j];
				if (ft === "-exec" || ft === "-execdir" || ft === "-ok" || ft === "-okdir") {
					execIdx = j;
					break;
				}
				if ((ft === "-name" || ft === "-iname" || ft === "-path" || ft === "-wholename") && j + 1 < tokens.length) {
					findNameCandidate = tokens[j + 1];
					j++;
					continue;
				}
				if (!ft.startsWith("-") && ft !== "!" && ft !== "(" && ft !== ")" && searchPaths.length === 0 && j === idx + 1) {
					searchPaths.push(ft);
				}
			}
			if (execIdx >= 0 && execIdx + 1 < tokens.length) {
				context.viaFindExec = true;
				context.placeholder = "{}";
				if (findNameCandidate) {
					const baseDir = searchPaths[0] && searchPaths[0] !== "." ? searchPaths[0] : "";
					context.findCandidate = baseDir
						? `${baseDir.replace(/\/+$/, "")}/${findNameCandidate}`
						: findNameCandidate;
				}
				while (tokens.length > execIdx + 1) {
					const tail = tokens[tokens.length - 1];
					if (tail === ";" || tail === "\\;" || tail === "+") tokens.pop();
					else break;
				}
				idx = execIdx + 1;
				continue;
			}
		}
		break;
	}
	return idx;
}

function extractFileTransferOp(rawTokens) {
	const tokens = [...rawTokens];
	const idx = skipLeadingCommandWrappers(tokens, 0, {});
	if (idx >= tokens.length) return null;
	const cmdBase = path.basename(tokens[idx]);
	if (
		cmdBase !== "cp" &&
		cmdBase !== "mv" &&
		cmdBase !== "ln" &&
		cmdBase !== "install" &&
		cmdBase !== "rsync"
	) {
		return null;
	}

	let i = idx + 1;
	let targetDir = null;
	let forceNoTargetDir = false;
	const positional = [];
	let endOfFlags = false;

	while (i < tokens.length) {
		const tok = tokens[i];
		if (!endOfFlags && tok === "--") {
			endOfFlags = true;
			i++;
			continue;
		}
		if (/^(?:\d*>>?|\&>>?|\d*<&?\d*)/.test(tok)) {
			i++;
			continue;
		}
		if (!endOfFlags && tok.startsWith("-") && tok !== "-") {
			if ((tok === "-t" || tok === "--target-directory") && i + 1 < tokens.length) {
				targetDir = tokens[i + 1];
				i += 2;
				continue;
			}
			if (tok.startsWith("--target-directory=")) {
				targetDir = tok.slice("--target-directory=".length);
				i++;
				continue;
			}
			if (tok === "-T" || tok === "--no-target-directory") {
				forceNoTargetDir = true;
				i++;
				continue;
			}
			if (
				cmdBase === "install" &&
				(tok === "-m" ||
					tok === "--mode" ||
					tok === "-o" ||
					tok === "--owner" ||
					tok === "-g" ||
					tok === "--group" ||
					tok === "-S" ||
					tok === "--suffix" ||
					tok === "-Z" ||
					tok === "--context") &&
				i + 1 < tokens.length
			) {
				i += 2;
				continue;
			}
			if (
				(cmdBase === "cp" || cmdBase === "mv" || cmdBase === "ln") &&
				(tok === "-S" || tok === "--suffix") &&
				i + 1 < tokens.length
			) {
				i += 2;
				continue;
			}
			if (cmdBase === "rsync" && RSYNC_TWO_ARG_FLAGS.has(tok) && i + 1 < tokens.length) {
				i += 2;
				continue;
			}
			i++;
			continue;
		}
		positional.push(tok);
		i++;
	}

	if (targetDir) {
		if (positional.length === 0) return null;
		return { cmd: cmdBase, sources: positional, dest: null, destDir: targetDir, forceNoTargetDir };
	}
	if (positional.length < 2) return null;
	return {
		cmd: cmdBase,
		sources: positional.slice(0, -1),
		dest: positional[positional.length - 1],
		destDir: null,
		forceNoTargetDir,
	};
}

function resolvePlaceholderScript(rawScriptArg, context) {
	if (!rawScriptArg) return null;
	const placeholder = (context && context.placeholder) || "{}";
	if (rawScriptArg === placeholder || rawScriptArg === "{}" || rawScriptArg.includes(placeholder)) {
		if (context && context.findCandidate && !/[*?\[]/.test(context.findCandidate)) {
			return {
				scriptArg: rawScriptArg.replace(placeholder, context.findCandidate).replace("{}", context.findCandidate),
			};
		}
		if (context && Array.isArray(context.pipedCandidates) && context.pipedCandidates.length > 0) {
			const candidate = context.pipedCandidates[0];
			return {
				scriptArg: rawScriptArg.replace(placeholder, candidate).replace("{}", candidate),
			};
		}
		return {
			unresolvedPlaceholder: rawScriptArg,
			viaWrapper: context && context.viaFindExec ? "find -exec" : "xargs",
		};
	}
	return { scriptArg: rawScriptArg };
}


module.exports={PYTHON_BIN_RE,NODE_BIN_RE,OTHER_SCRIPT_BIN_RE,DIRECT_SCRIPT_EXT_RE,UV_TWO_ARG_FLAGS,NODE_TWO_ARG_FLAGS,isInterpreterName,isShellBin,skipLeadingCommandWrappers,extractFileTransferOp,resolvePlaceholderScript};
