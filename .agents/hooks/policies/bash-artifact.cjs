"use strict";
const path=require("node:path"),fs=require("node:fs"),os=require("node:os");
const {spawnSync}=require("node:child_process");
const core=require("../core/harness-core.js");
const {duplicateCodeFile}=require("./edit.js");
const {DEFAULT_ARTIFACT_EXTENSIONS,DEFAULT_ARTIFACT_SCRIPT_DIRS,ARTIFACT_DRIFT_MESSAGE,loadArtifactExtensions,loadArtifactScriptDirs,isArtifactProducerScript,splitShellSegments,tokenizeSegment,unwrapGroupingTokens,expandShellVars,expandHomePath,matchArtifactToken}=require("./bash-artifact-context.cjs");
const {DIRECT_SCRIPT_EXT_RE,extractFileTransferOp}=require("./bash-artifact-wrappers.cjs");
const {extractScriptFromTokens,checkScriptGitStatus}=require("./bash-artifact-scripts.cjs");
/**
 * uncommittedArtifact — block producing build/asset artifacts (.nva, .exe, .msi,
 * .dmg, .AppImage, .apk, .vrm, or configured extensions) from an uncommitted
 * (untracked/modified) script or an out-of-repo script (such as /tmp/...),
 * running an uncommitted script inside configured artifact_script_dirs even
 * without CLI artifact tokens, inline/stdin artifact generation, or copying/
 * renaming uncommitted artifacts or variant code files via cp/mv/ln/install/rsync.
 */
function uncommittedArtifact(command, data, opts) {
	if (!command || typeof command !== "string") return null;

	const baseCwd = (opts && opts.cwd) || (data && data.cwd) || process.cwd();
	const artifactExts = loadArtifactExtensions(baseCwd, opts);
	const segments = splitShellSegments(command);

	let effectiveCwd = path.resolve(baseCwd);
	const cwdStack = [];
	const varMap = new Map();
	const scriptsToCheck = [];
	const inlineOrStdinToCheck = [];
	const allArtifacts = [];

	let prevSep = "";
	let pipedEchoStrings = [];
	let pipedScriptCandidates = [];

	for (const seg of segments) {
		const rawTokens = tokenizeSegment(seg.text);
		const { tokens: unwrapped, openParens, closeParens } = unwrapGroupingTokens(rawTokens);
		for (let p = 0; p < openParens; p++) cwdStack.push(effectiveCwd);

		const finishSegment = (nextEchoStrings = [], nextScriptCandidates = []) => {
			for (let p = 0; p < closeParens; p++) {
				if (cwdStack.length > 0) effectiveCwd = cwdStack.pop();
			}
			prevSep = seg.sep;
			pipedEchoStrings = seg.sep === "|" ? nextEchoStrings : [];
			pipedScriptCandidates = seg.sep === "|" ? nextScriptCandidates : [];
		};

		if (unwrapped.length === 0) {
			finishSegment();
			continue;
		}

		// Record and expand shell variables (e.g., OUT=a.nva; python ... $OUT)
		const tokens = [];
		for (const rawTok of unwrapped) {
			const assignMatch = rawTok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
			if (assignMatch && tokens.length === 0) {
				const expandedVal = expandShellVars(assignMatch[2].replace(/^['"]|['"]$/g, ""), varMap);
				varMap.set(assignMatch[1], expandedVal);
				tokens.push(`${assignMatch[1]}=${expandedVal}`);
			} else {
				tokens.push(expandShellVars(rawTok, varMap));
			}
		}

		// Handle cd
		if (tokens[0] === "cd" && seg.sep !== "|") {
			let cdIdx = 1;
			while (cdIdx < tokens.length && (tokens[cdIdx] === "-P" || tokens[cdIdx] === "-L" || tokens[cdIdx] === "--")) {
				cdIdx++;
			}
			if (tokens[cdIdx]) {
				const targetDir = expandHomePath(tokens[cdIdx]);
				effectiveCwd = path.resolve(effectiveCwd, targetDir);
			}
			finishSegment();
			continue;
		}

		// Handle echo / printf
		if (tokens[0] === "echo" || tokens[0] === "printf") {
			if (seg.sep !== "|") {
				finishSegment();
				continue;
			}
			const echoArgs = tokens.slice(1).filter((t) => !t.startsWith("-"));
			for (const tok of echoArgs) {
				const matched = matchArtifactToken(tok, artifactExts);
				if (matched) allArtifacts.push(matched);
			}
			const candidates = [];
			for (const tok of echoArgs) {
				for (const part of tok.split(/\s+/)) {
					if (part && (DIRECT_SCRIPT_EXT_RE.test(part) || !part.startsWith("-"))) {
						candidates.push(part);
					}
				}
			}
			finishSegment(echoArgs, candidates);
			continue;
		}

		const segArtifacts = [];
		for (const tok of tokens) {
			const matched = matchArtifactToken(tok, artifactExts);
			if (matched) {
				segArtifacts.push(matched);
				allArtifacts.push(matched);
			}
		}

		// Check cp / mv / ln / install / rsync (Item 4: P1-3 & P1-7)
		const transferOp = extractFileTransferOp(tokens);
		if (transferOp) {
			for (const src of transferOp.sources) {
				let destPath = transferOp.dest;
				if (transferOp.destDir) {
					destPath = path.join(transferOp.destDir, path.basename(src));
				} else if (destPath && !transferOp.forceNoTargetDir) {
					const absDestProbe = path.resolve(effectiveCwd, expandHomePath(destPath));
					let isDestDir = destPath.endsWith("/") || transferOp.sources.length > 1;
					if (!isDestDir && fs.existsSync(absDestProbe)) {
						try {
							isDestDir = fs.statSync(absDestProbe).isDirectory();
						} catch {
							isDestDir = false;
						}
					}
					if (isDestDir) {
						destPath = path.join(destPath, path.basename(src));
					}
				}
				if (!destPath) continue;

				// (a) Target has an artifact extension and source is uncommitted
				const matchedDestArtifact = matchArtifactToken(destPath, artifactExts);
				if (matchedDestArtifact) {
					const srcCheck = checkScriptGitStatus(src, effectiveCwd);
					if (!srcCheck.ok) {
						return {
							reason:
								`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
								`원본: ${src} (${srcCheck.state}) → 산출물: ${matchedDestArtifact}`,
						};
					}
				}

				// (b) Target is a variant/copy name of a sibling code file (shared edit.js duplicateCodeFile)
				const absSrc = path.resolve(effectiveCwd, expandHomePath(src));
				const absDest = path.resolve(effectiveCwd, expandHomePath(destPath));
				const extraSiblings =
					path.dirname(absSrc) === path.dirname(absDest) ? [path.basename(absSrc)] : [];
				const dupDecision = duplicateCodeFile(
					{
						cwd: effectiveCwd,
						tool_name: "Write",
						tool_input: { file_path: destPath },
					},
					{
						...(opts || {}),
						cwd: effectiveCwd,
						extraSiblings,
					},
				);
				if (dupDecision && dupDecision.block) {
					return { reason: dupDecision.block };
				}
			}
			finishSegment();
			continue;
		}

		const extractCtx = {
			fromPipe: prevSep === "|",
			pipedCandidates: pipedScriptCandidates,
		};
		const extracted = extractScriptFromTokens(tokens, effectiveCwd, extractCtx);
		if (extracted) {
			if (extracted.inlineCommand) {
				const nested = uncommittedArtifact(
					extracted.inlineCommand,
					{ ...(data || {}), cwd: effectiveCwd },
					opts,
				);
				if (nested) return nested;
			}
			if (extracted.stdinProgram && prevSep === "|" && pipedEchoStrings.length > 0) {
				const pipedCmd = pipedEchoStrings.join(" ");
				const nested = uncommittedArtifact(
					pipedCmd,
					{ ...(data || {}), cwd: effectiveCwd },
					opts,
				);
				if (nested) return nested;
			}
			if (extracted.stdinProgram) {
				inlineOrStdinToCheck.push({
					label: `<stdin:${extracted.stdinProgram}>`,
					state: "uncommitted-stdin",
					segArtifacts,
				});
			} else if (extracted.inlineCode && !extracted.inlineCommand) {
				inlineOrStdinToCheck.push({
					label: `<inline:${extracted.inlineCode}>`,
					state: "inline-code",
					segArtifacts,
				});
			} else if (extracted.unresolvedPlaceholder) {
				inlineOrStdinToCheck.push({
					label: `${extracted.unresolvedPlaceholder} (${extracted.viaWrapper})`,
					state: "untracked",
					segArtifacts,
				});
			} else if (extracted.scriptArg) {
				scriptsToCheck.push({
					scriptArg: extracted.scriptArg,
					cwd: effectiveCwd,
					segArtifacts,
				});
			}
		}

		finishSegment();
	}

	if (allArtifacts.length > 0 && inlineOrStdinToCheck.length > 0) {
		const item = inlineOrStdinToCheck[0];
		const artifactLabel = item.segArtifacts[0] || allArtifacts[0];
		return {
			reason:
				`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
				`대본: ${item.label} (${item.state}) → 산출물: ${artifactLabel}`,
		};
	}

	for (const item of scriptsToCheck) {
		const check = checkScriptGitStatus(item.scriptArg, item.cwd);
		const dirPatterns = loadArtifactScriptDirs(
			item.cwd,
			opts,
			check.repoRoot ? [check.repoRoot] : [],
		);
		const inProducerDir = isArtifactProducerScript(
			item.scriptArg,
			item.cwd,
			check,
			dirPatterns,
		);
		if ((allArtifacts.length > 0 || inProducerDir) && !check.ok) {
			const artifactLabel =
				item.segArtifacts[0] || allArtifacts[0] || "(산출물 생산 폴더 대본)";
			return {
				reason:
					`[Harness] ${ARTIFACT_DRIFT_MESSAGE}\n` +
					`대본: ${item.scriptArg} (${check.state}) → 산출물: ${artifactLabel}`,
			};
		}
	}

	return null;
}


module.exports={uncommittedArtifact,loadArtifactExtensions,loadArtifactScriptDirs,DEFAULT_ARTIFACT_EXTENSIONS,DEFAULT_ARTIFACT_SCRIPT_DIRS,ARTIFACT_DRIFT_MESSAGE};
