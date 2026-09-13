import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { naiaPersonaName, readNaiaPersonaSettings, renderNaiaPersona } from "./naia-persona.mjs";
import { TextDecoder } from "node:util";

export const AGENT_CONTEXT_LIMITS = Object.freeze({
	maxContextFiles: 16,
	maxFileBytes: 256 * 1024,
	maxTotalBytes: 1024 * 1024,
});

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const CONTEXT_SCHEMA = "naia-agent-context-v1";

export class AgentContextChangedError extends Error {
	constructor() {
		super("agent context changed; restart the Discord service");
		this.name = "AgentContextChangedError";
		this.code = "context_changed_restart_required";
	}
}

function configuredRelativePath(value, label) {
	if (typeof value !== "string" || value.length === 0 || value.length > 512 || isAbsolute(value) || value.includes("\\") || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must be a bounded POSIX relative path`);
	}
	const parts = value.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${label} must not contain empty or traversal segments`);
	return parts.join("/");
}

function insideWorkspace(workspaceRoot, candidate) {
	const child = relative(workspaceRoot, candidate);
	return child !== "" && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\") && !isAbsolute(child);
}

function resolveContextFile(workspaceRoot, relativePath) {
	let cursor = workspaceRoot;
	for (const part of relativePath.split("/")) {
		cursor = resolve(cursor, part);
		const stat = lstatSync(cursor);
		if (stat.isSymbolicLink()) throw new Error("agent context paths must not contain symbolic links");
	}
	const absolutePath = realpathSync(cursor);
	if (!insideWorkspace(workspaceRoot, absolutePath)) throw new Error("agent context path escaped the workspace");
	const stat = lstatSync(absolutePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("agent context path must be a real file");
	return absolutePath;
}

export function resolveAgentContextWorkspace(config) {
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("agent context workspace config is required");
	if (typeof config.workspace !== "string" || config.workspace.length === 0) throw new Error("agent context workspace is required");
	const configuredWorkspace = resolve(config.workspace);
	const filesystemRoot = parse(configuredWorkspace).root;
	let workspaceCursor = filesystemRoot;
	for (const part of configuredWorkspace.slice(filesystemRoot.length).split(/[\\/]+/).filter(Boolean)) {
		workspaceCursor = resolve(workspaceCursor, part);
		if (lstatSync(workspaceCursor).isSymbolicLink()) throw new Error("agent context workspace must not contain symbolic links");
	}
	const workspaceRoot = realpathSync(configuredWorkspace);
	const rootStat = lstatSync(workspaceRoot);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("agent context workspace must be a real directory");
	const entrypoint = configuredRelativePath(config.entrypoint, "entrypoint");
	if (config.contextFiles !== undefined && !Array.isArray(config.contextFiles)) throw new Error("contextFiles must be an array");
	const contextFiles = (config.contextFiles ?? []).map((value) => configuredRelativePath(value, "context file")).sort();
	// 페르소나 파일은 정체성이라 프로젝트 컨텍스트와 같은 자리에 렌더링하지 않는다.
	// 다만 무결성은 같은 장치로 지킨다 — 심링크 금지, 크기 제한, 해시 결박.
	const personaFile = config.personaFile === undefined || config.personaFile === null
		? null
		: configuredRelativePath(config.personaFile, "persona file");
	const relativePaths = [entrypoint, ...contextFiles, ...(personaFile === null ? [] : [personaFile])];
	if (relativePaths.length > AGENT_CONTEXT_LIMITS.maxContextFiles) throw new Error("agent context file count exceeds the limit");
	const personaIndex = personaFile === null ? -1 : relativePaths.length - 1;
	if (new Set(relativePaths).size !== relativePaths.length) throw new Error("agent context files must be unique");
	const seen = new Set();
	const files = relativePaths.map((relativePath, index) => {
		const absolutePath = resolveContextFile(workspaceRoot, relativePath);
		if (seen.has(absolutePath)) throw new Error("agent context files must resolve uniquely");
		seen.add(absolutePath);
		const kind = index === 0 ? "entrypoint" : (index === personaIndex ? "persona" : "context");
		return Object.freeze({ kind, relativePath, absolutePath });
	});
	return Object.freeze({ workspaceRoot, files: Object.freeze(files) });
}

function configuredAgentId(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) throw new Error("agentId must be a safe identifier");
	return value;
}

function hashSnapshotEntries(entries, agentId) {
	const hash = createHash("sha256");
	hash.update(`${CONTEXT_SCHEMA}\0${agentId}\0`, "utf8");
	for (const entry of entries) {
		const pathBytes = Buffer.from(`${entry.kind}\0${entry.relativePath}`, "utf8");
		const lengths = Buffer.allocUnsafe(12);
		lengths.writeUInt32BE(pathBytes.length, 0);
		lengths.writeBigUInt64BE(BigInt(entry.bytes.length), 4);
		hash.update(lengths);
		hash.update(pathBytes);
		hash.update(entry.bytes);
	}
	return hash.digest("hex");
}

function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function openedFilePath(fd, configuredPath) {
	const descriptorPath = `/proc/self/fd/${fd}`;
	return process.platform !== "win32" && existsSync(descriptorPath) ? realpathSync(descriptorPath) : realpathSync(configuredPath);
}

function assertOpenedFileIdentity({ fd, configuredPath, workspaceRoot, openedStat }) {
	const actualPath = openedFilePath(fd, configuredPath);
	if (!insideWorkspace(workspaceRoot, actualPath)) throw new Error("opened agent context file escaped the workspace");
	const currentPath = realpathSync(configuredPath);
	if (currentPath !== actualPath) throw new Error("agent context path changed while opening");
	const currentStat = lstatSync(currentPath);
	if (currentStat.isSymbolicLink() || !currentStat.isFile() || !sameFile(openedStat, currentStat)) throw new Error("agent context file identity changed while opening");
	return actualPath;
}

function openAnchoredContextFile(workspaceRoot, relativePath) {
	const procFdRoot = "/proc/self/fd";
	if (process.platform === "win32" || !existsSync(procFdRoot) || fsConstants.O_DIRECTORY === undefined) return null;
	const anchors = [];
	try {
		let directoryFd = openSync(workspaceRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
		anchors.push(directoryFd);
		if (realpathSync(`${procFdRoot}/${directoryFd}`) !== workspaceRoot) throw new Error("agent context workspace identity changed while opening");
		const parts = relativePath.split("/");
		for (const part of parts.slice(0, -1)) {
			directoryFd = openSync(`${procFdRoot}/${directoryFd}/${part}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0));
			anchors.push(directoryFd);
			if (!insideWorkspace(workspaceRoot, realpathSync(`${procFdRoot}/${directoryFd}`))) throw new Error("agent context directory escaped the workspace");
		}
		const fd = openSync(`${procFdRoot}/${directoryFd}/${parts.at(-1)}`, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		return { fd, closeAnchors: () => { while (anchors.length) closeSync(anchors.pop()); } };
	} catch (error) {
		while (anchors.length) closeSync(anchors.pop());
		throw error;
	}
}

function readBoundedContextFile(path, relativePath, workspaceRoot) {
	const anchored = openAnchoredContextFile(workspaceRoot, relativePath);
	const fd = anchored?.fd ?? openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) throw new Error("agent context path must be a real file");
		const actualPath = openedFilePath(fd, path);
		if (!insideWorkspace(workspaceRoot, actualPath)) throw new Error("opened agent context file escaped the workspace");
		if (!anchored) assertOpenedFileIdentity({ fd, configuredPath: path, workspaceRoot, openedStat: stat });
		if (stat.size > AGENT_CONTEXT_LIMITS.maxFileBytes) throw new Error("agent context file exceeds the size limit");
		const bytes = readFileSync(fd);
		if (bytes.length > AGENT_CONTEXT_LIMITS.maxFileBytes) throw new Error("agent context file exceeds the size limit");
		if (openedFilePath(fd, path) !== actualPath) throw new Error("opened agent context file changed while reading");
		if (!anchored) assertOpenedFileIdentity({ fd, configuredPath: path, workspaceRoot, openedStat: stat });
		return bytes;
	} finally {
		closeSync(fd);
		anchored?.closeAnchors();
	}
}

function renderStablePrefix(entries, contextHash, agentId) {
	const lines = [
		"Naia deterministic project context (authoritative project files).",
		`Configured-Agent: ${agentId}`,
		`Context-SHA256: ${contextHash}`,
		"Use this stable context before participant data or untrusted conversation history.",
	];
	for (const entry of entries) {
		// 페르소나는 프롬프트의 Persona 자리에서 한 번만 나온다. 여기서도 찍으면
		// 같은 글이 두 번 실려 문맥만 키우고, 정체성이 프로젝트 파일처럼 읽힌다.
		if (entry.kind === "persona") continue;
		lines.push("", `--- ${entry.kind}: ${entry.relativePath} (${entry.bytes.length} bytes) ---`, entry.text);
	}
	lines.push("", "--- end deterministic project context ---");
	return lines.join("\n");
}

/**
 * 파일이 아니라 이미 만들어진 글을 페르소나 자리에 넣을 때 쓰는 이름.
 *
 * 나이아 설정에서 가져온 페르소나가 여기로 온다. 그 설정 파일은 작업공간 밖(ADK
 * 루트)에 있고 자격값도 들어 있어 통째로 읽을 수 없다. 그래서 정해진 항목만 뽑아
 * 글로 만든 다음, 파일에서 읽은 것과 똑같이 컨텍스트 해시에 묶는다.
 */
export const RENDERED_PERSONA_PATH = "<naia-settings persona>";

function snapshotResolvedWorkspace(resolvedWorkspace, agentId, renderedPersona = null) {
	let totalBytes = 0;
	const entries = resolvedWorkspace.files.map((file) => {
		const bytes = readBoundedContextFile(file.absolutePath, file.relativePath, resolvedWorkspace.workspaceRoot);
		totalBytes += bytes.length;
		if (totalBytes > AGENT_CONTEXT_LIMITS.maxTotalBytes) throw new Error("agent context total size exceeds the limit");
		let text;
		try { text = UTF8.decode(bytes); }
		catch { throw new Error("agent context files must be valid UTF-8"); }
		return { ...file, bytes, text, sha256: createHash("sha256").update(bytes).digest("hex") };
	});
	// 해시를 내기 전에 넣는다. 뒤에 넣으면 정체성이 바뀌어도 컨텍스트 해시가 그대로라
	// spawn 직전 드리프트 검사가 못 잡는다.
	if (renderedPersona !== null) {
		if (entries.some((entry) => entry.kind === "persona")) throw new Error("a rendered persona cannot be combined with a persona file");
		if (typeof renderedPersona !== "string" || renderedPersona.trim() === "") throw new Error("rendered persona is empty");
		const bytes = Buffer.from(renderedPersona, "utf8");
		if (bytes.length > AGENT_CONTEXT_LIMITS.maxFileBytes) throw new Error("rendered persona exceeds the size limit");
		totalBytes += bytes.length;
		if (totalBytes > AGENT_CONTEXT_LIMITS.maxTotalBytes) throw new Error("agent context total size exceeds the limit");
		entries.push({ kind: "persona", relativePath: RENDERED_PERSONA_PATH, absolutePath: RENDERED_PERSONA_PATH, bytes, text: renderedPersona, sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	const contextHash = hashSnapshotEntries(entries, agentId);
	const manifestFiles = entries.map((entry) => Object.freeze({
		kind: entry.kind,
		path: entry.relativePath,
		bytes: entry.bytes.length,
		sha256: entry.sha256,
	}));
	const personaEntry = entries.find((entry) => entry.kind === "persona") ?? null;
	return Object.freeze({
		schemaVersion: 1,
		workspaceRoot: resolvedWorkspace.workspaceRoot,
		agentId,
		contextHash,
		totalBytes,
		personaFile: personaEntry === null ? null : personaEntry.relativePath,
		personaText: personaEntry === null ? null : personaEntry.text,
		manifest: Object.freeze({ schema: CONTEXT_SCHEMA, files: Object.freeze(manifestFiles) }),
		prefix: renderStablePrefix(entries, contextHash, agentId),
	});
}

export function buildAgentContextSnapshot(config) {
	// 나이아 설정에서 오는 페르소나는 여기서 읽고 렌더한다. 호출자가 글을 만들어
	// 넘기면 검증 경로가 같은 글을 다시 만들 수 없어 드리프트를 못 잡는다.
	const personaSourceRoot = config.personaSourceRoot ?? null;
	const settings = personaSourceRoot === null ? null : readNaiaPersonaSettings(personaSourceRoot);
	const renderedPersona = settings === null ? null : renderNaiaPersona(settings);
	const snapshot = snapshotResolvedWorkspace(resolveAgentContextWorkspace(config), configuredAgentId(config.agentId ?? "unspecified-agent"), renderedPersona);
	return settings === null ? snapshot : Object.freeze({ ...snapshot, personaSourceRoot, personaAgentName: naiaPersonaName(settings) });
}

export function verifyAgentContextBeforeAttempt(startupSnapshot) {
	if (!startupSnapshot || startupSnapshot.schemaVersion !== 1 || typeof startupSnapshot.contextHash !== "string" || !Array.isArray(startupSnapshot.manifest?.files)) {
		throw new Error("a valid startup agent context snapshot is required");
	}
	try {
		const entrypoint = startupSnapshot.manifest.files.find((file) => file.kind === "entrypoint");
		const contextFiles = startupSnapshot.manifest.files.filter((file) => file.kind === "context").map((file) => file.path);
		const personaFiles = startupSnapshot.manifest.files.filter((file) => file.kind === "persona").map((file) => file.path);
		if (!entrypoint || startupSnapshot.manifest.files.filter((file) => file.kind === "entrypoint").length !== 1) throw new Error("startup agent context manifest is invalid");
		if (personaFiles.length > 1) throw new Error("startup agent context manifest is invalid");
		// 렌더된 페르소나는 파일이 아니므로 작업공간에서 찾지 않는다. 나이아 설정을
		// 다시 읽어 다시 만든다 — 셸에서 페르소나를 바꾸면 여기서 해시가 어긋난다.
		const rendered = personaFiles[0] === RENDERED_PERSONA_PATH;
		if (rendered && typeof startupSnapshot.personaSourceRoot !== "string") throw new Error("startup agent context manifest is invalid");
		const resolvedWorkspace = resolveAgentContextWorkspace({ workspace: startupSnapshot.workspaceRoot, entrypoint: entrypoint.path, contextFiles, personaFile: rendered ? null : personaFiles[0] ?? null });
		const current = snapshotResolvedWorkspace(resolvedWorkspace, configuredAgentId(startupSnapshot.agentId), rendered ? renderNaiaPersona(readNaiaPersonaSettings(startupSnapshot.personaSourceRoot)) : null);
		if (current.contextHash !== startupSnapshot.contextHash) throw new AgentContextChangedError();
		return Object.freeze({ contextHash: current.contextHash, verified: true });
	} catch (error) {
		if (error instanceof AgentContextChangedError) throw error;
		throw new AgentContextChangedError();
	}
}
