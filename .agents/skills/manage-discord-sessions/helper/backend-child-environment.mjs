import { closeSync, constants as fsConstants, chmodSync, existsSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { assertPrivateAuthenticationSource, protectOwnerOnly } from "./platform-security.mjs";

const SAFE_ENV_KEYS = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"]);
const API_KEY_BY_BACKEND = { codex: "CODEX_API_KEY", claude: "ANTHROPIC_API_KEY" };

export function resolveExecutionCwd(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("execution cwd is required");
	if (!isAbsolute(cwd)) throw new Error("execution cwd must be absolute");
	const resolvedCwd = resolve(cwd);
	const stat = lstatSync(resolvedCwd);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("execution cwd must be a real directory");
	return resolvedCwd;
}

function assertRealFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a real file`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${label} owner mismatch`);
}

function privateDirectory(path) {
	const resolvedPath = resolve(path);
	const root = parse(resolvedPath).root;
	let cursor = root;
	for (const part of resolvedPath.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
		cursor = resolve(cursor, part);
		if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`private path contains a symbolic link: ${cursor}`);
	}
	mkdirSync(resolvedPath, { recursive: true, mode: 0o700 });
	const stat = lstatSync(resolvedPath);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`private path must be a real directory: ${resolvedPath}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`private path owner mismatch: ${resolvedPath}`);
	chmodSync(resolvedPath, 0o700);
	protectOwnerOnly(resolvedPath, "directory", "private directory");
}

function copyCredential(source, target, label) {
	if (!existsSync(source)) return false;
	assertRealFile(source, label);
	assertPrivateAuthenticationSource(source, label);
	privateDirectory(dirname(target));
	const sourceFd = openSync(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	let targetFd;
	try {
		targetFd = openSync(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			let offset = 0;
			while (offset < bytesRead) offset += writeSync(targetFd, buffer, offset, bytesRead - offset);
		}
	} finally {
		closeSync(sourceFd);
		if (targetFd !== undefined) closeSync(targetFd);
	}
	chmodSync(target, 0o600);
	protectOwnerOnly(target, "file", label);
	return true;
}

function defaultRuntimeRoot(parentEnv) {
	const base = parentEnv.XDG_RUNTIME_DIR && resolve(parentEnv.XDG_RUNTIME_DIR) === parentEnv.XDG_RUNTIME_DIR
		? parentEnv.XDG_RUNTIME_DIR
		: join(tmpdir(), `naia-adk-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
	return join(base, "messenger-sessions");
}

export function prepareChildEnvironment({ backendId, attemptId, runtimeRoot, parentEnv = process.env, authRoot = homedir(), workspacePath = null, prepareAuthentication = true }) {
	const childHome = resolve(runtimeRoot ?? defaultRuntimeRoot(parentEnv), "children", attemptId);
	privateDirectory(childHome);
	try {
		const env = {};
		for (const key of SAFE_ENV_KEYS) if (parentEnv[key]) env[key] = parentEnv[key];
		if (env.PATH) {
			const workspace = workspacePath ? resolve(workspacePath) : null;
			env.PATH = env.PATH.split(delimiter).filter((entry) => {
				if (!entry || !isAbsolute(entry) || entry.split(/[\\/]+/).includes("node_modules")) return false;
				const resolvedEntry = resolve(entry);
				if (!workspace) return true;
				const child = relative(workspace, resolvedEntry);
				return child !== "" && (child.startsWith("..") || isAbsolute(child));
			}).join(delimiter);
		}
		env.HOME = childHome;
		env.NO_COLOR = "1";
		for (const key of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "TMPDIR"]) {
			env[key] = join(childHome, key.toLowerCase());
			privateDirectory(env[key]);
		}
		const apiKeyName = API_KEY_BY_BACKEND[backendId];
		if (prepareAuthentication && apiKeyName && parentEnv[apiKeyName]) env[apiKeyName] = parentEnv[apiKeyName];
		let authenticationPrepared = Boolean(prepareAuthentication && apiKeyName && parentEnv[apiKeyName]);
		if (backendId === "codex") {
			const codexHome = join(childHome, ".codex");
			privateDirectory(codexHome);
			env.CODEX_HOME = codexHome;
			if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".codex", "auth.json"), join(codexHome, "auth.json"), "Codex authentication");
		} else if (backendId === "claude") {
			privateDirectory(join(childHome, ".claude"));
			if (prepareAuthentication) authenticationPrepared ||= copyCredential(join(authRoot, ".claude", ".credentials.json"), join(childHome, ".claude", ".credentials.json"), "Claude authentication");
		} else {
			throw new Error(`unsupported backend environment: ${backendId}`);
		}
		return { childHome, env, authenticationPrepared };
	} catch (error) {
		if (existsSync(childHome)) cleanupChildEnvironment(childHome);
		throw error;
	}
}

export function cleanupChildEnvironment(childHome) {
	const stat = lstatSync(childHome);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("refusing to clean an unsafe child environment");
	rmSync(childHome, { recursive: true, force: false });
}
