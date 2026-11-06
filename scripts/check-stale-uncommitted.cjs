#!/usr/bin/env node
"use strict";
/**
 * Check workspace and projects/* git repositories for uncommitted changes
 * (modified or untracked files) whose file mtime is older than N hours (default 4).
 *
 * Output only — no wake triggers or Discord notifications.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_STALE_HOURS = 4;

function loadConfiguredHours(root) {
	if (process.env.NAIA_STALE_UNCOMMITTED_HOURS !== undefined) {
		const envVal = Number(process.env.NAIA_STALE_UNCOMMITTED_HOURS);
		if (Number.isFinite(envVal) && envVal >= 0) return envVal;
	}
	if (root) {
		const driftPath = path.join(root, ".agents", "context", "drift-guard.json");
		if (fs.existsSync(driftPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(driftPath, "utf8"));
				const val = Number(parsed && parsed.stale_uncommitted_hours);
				if (Number.isFinite(val) && val >= 0) return val;
			} catch {
				/* ignore */
			}
		}
		for (const f of ["agents-rules.json", "agents-rules-detail.json"]) {
			const p = path.join(root, ".agents", "context", f);
			if (!fs.existsSync(p)) continue;
			try {
				const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
				const val = Number(
					parsed?.conventions?.drift_guard?.stale_uncommitted_hours ??
						parsed?.drift_guard?.stale_uncommitted_hours,
				);
				if (Number.isFinite(val) && val >= 0) return val;
			} catch {
				/* ignore */
			}
		}
	}
	return DEFAULT_STALE_HOURS;
}

function isGitRepo(dir) {
	try {
		return fs.existsSync(path.join(dir, ".git"));
	} catch {
		return false;
	}
}

function discoverRepositories(root) {
	const resolvedRoot = path.resolve(root);
	const repos = [];
	const subRepoRelPrefixes = [];

	const projectsDir = path.join(resolvedRoot, "projects");
	if (fs.existsSync(projectsDir)) {
		try {
			const entries = fs
				.readdirSync(projectsDir, { withFileTypes: true })
				.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
				const subPath = path.join(projectsDir, entry.name);
				if (isGitRepo(subPath)) {
					const relName = `projects/${entry.name}`;
					subRepoRelPrefixes.push(`${relName}/`);
					repos.push({ name: relName, path: subPath, isRoot: false, skipPrefixes: [] });
				}
			}
		} catch {
			/* ignore */
		}
	}

	if (isGitRepo(resolvedRoot)) {
		repos.unshift({
			name: "workspace",
			path: resolvedRoot,
			isRoot: true,
			skipPrefixes: subRepoRelPrefixes,
		});
	}

	return repos;
}

function parsePorcelainPath(line) {
	if (!line || line.length < 4) return null;
	const status = line.slice(0, 2);
	let rawPath = line.slice(3);
	const arrowIdx = rawPath.indexOf(" -> ");
	if (arrowIdx >= 0 && (status.includes("R") || status.includes("C"))) {
		rawPath = rawPath.slice(arrowIdx + 4);
	}
	rawPath = rawPath.trim();
	if (rawPath.startsWith('"') && rawPath.endsWith('"')) {
		rawPath = rawPath.slice(1, -1);
	}
	return { status, relPath: rawPath };
}

function inspectRepo(repoInfo, thresholdMs, nowMs) {
	const res = spawnSync(
		"git",
		["-c", "core.quotePath=false", "-C", repoInfo.path, "status", "--porcelain", "-uall"],
		{
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (res.status !== 0 || !res.stdout) {
		return {
			name: repoInfo.name,
			path: repoInfo.path,
			uncommittedCount: 0,
			staleCount: 0,
			oldestHours: 0,
			oldestFile: null,
			staleFiles: [],
		};
	}

	const lines = res.stdout.split(/\r?\n/).filter(Boolean);
	const staleFiles = [];
	let uncommittedCount = 0;

	for (const line of lines) {
		const parsed = parsePorcelainPath(line);
		if (!parsed || !parsed.relPath) continue;
		const normRel = parsed.relPath.replace(/\\/g, "/");
		if (repoInfo.skipPrefixes.some((prefix) => normRel.startsWith(prefix))) {
			continue;
		}
		const fullPath = path.join(repoInfo.path, parsed.relPath);
		let stat;
		try {
			stat = fs.statSync(fullPath);
		} catch {
			continue;
		}
		if (stat.isDirectory()) continue;
		uncommittedCount++;

		const ageMs = Math.max(0, nowMs - stat.mtimeMs);
		if (ageMs >= thresholdMs) {
			const ageHours = ageMs / 3_600_000;
			staleFiles.push({
				path: normRel,
				status: parsed.status.trim() || "M",
				mtimeMs: stat.mtimeMs,
				ageHours,
			});
		}
	}

	staleFiles.sort((a, b) => b.ageHours - a.ageHours || a.path.localeCompare(b.path));
	const oldest = staleFiles[0] || null;

	return {
		name: repoInfo.name,
		path: repoInfo.path,
		uncommittedCount,
		staleCount: staleFiles.length,
		oldestHours: oldest ? Number(oldest.ageHours.toFixed(1)) : 0,
		oldestFile: oldest ? oldest.path : null,
		staleFiles,
	};
}

function checkStaleUncommitted(opts = {}) {
	const root = path.resolve(opts.root || process.cwd());
	const hours =
		opts.hours !== undefined && Number.isFinite(Number(opts.hours))
			? Number(opts.hours)
			: loadConfiguredHours(root);
	const nowMs = opts.nowMs !== undefined ? Number(opts.nowMs) : Date.now();
	const thresholdMs = hours * 3_600_000;

	const discovered = discoverRepositories(root);
	const repos = discovered.map((r) => inspectRepo(r, thresholdMs, nowMs));
	const staleRepos = repos.filter((r) => r.staleCount > 0);

	let oneLineWarning = "";
	if (staleRepos.length > 0) {
		const summary = staleRepos
			.map((r) => `${r.name}(${r.staleCount}건, 최대 ${r.oldestHours.toFixed(1)}h: ${r.oldestFile})`)
			.join(", ");
		oneLineWarning = `⚠ [Drift] ${hours}시간 넘게 커밋 안 된 변경 감지: ${summary} — 방치된 변경을 커밋·정리하거나 PR로 올리세요.`;
	}

	return {
		root,
		hours,
		repos,
		staleRepos,
		hasStale: staleRepos.length > 0,
		oneLineWarning,
	};
}

function parseCliArgs(argv) {
	const opts = { json: false, oneLine: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") {
			opts.json = true;
		} else if (arg === "--one-line") {
			opts.oneLine = true;
		} else if (arg === "--hours" && i + 1 < argv.length) {
			opts.hours = Number(argv[++i]);
		} else if (arg.startsWith("--hours=")) {
			opts.hours = Number(arg.slice("--hours=".length));
		} else if (arg === "--root" && i + 1 < argv.length) {
			opts.root = argv[++i];
		} else if (arg.startsWith("--root=")) {
			opts.root = arg.slice("--root=".length);
		}
	}
	return opts;
}

function main(argv = process.argv.slice(2)) {
	const cli = parseCliArgs(argv);
	const result = checkStaleUncommitted({
		root: cli.root || path.resolve(__dirname, ".."),
		hours: cli.hours,
	});

	if (cli.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	}

	if (cli.oneLine) {
		if (result.oneLineWarning) {
			process.stdout.write(`${result.oneLineWarning}\n`);
		}
		return 0;
	}

	if (!result.hasStale) {
		process.stdout.write(
			`[stale-uncommitted] ${result.hours}시간 넘은 미커밋 변경 없음 (${result.repos.length}개 저장소 점검).\n`,
		);
		return 0;
	}

	process.stdout.write(`${result.oneLineWarning}\n`);
	for (const repo of result.staleRepos) {
		process.stdout.write(
			`  - ${repo.name}: 미커밋 ${repo.staleCount}개 (${repo.oldestHours.toFixed(1)}h 경과, 최고령: ${repo.oldestFile})\n`,
		);
	}
	return 0;
}

if (require.main === module) {
	try {
		process.exitCode = main();
	} catch {
		process.exitCode = 0;
	}
}

module.exports = {
	checkStaleUncommitted,
	discoverRepositories,
	loadConfiguredHours,
	DEFAULT_STALE_HOURS,
	main,
};
