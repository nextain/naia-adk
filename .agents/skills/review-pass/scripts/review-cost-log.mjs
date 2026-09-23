import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseStreamEvents, streamMetadata } from "./validate-review-output.mjs";

export function resolveRepoRoot(start = path.dirname(fileURLToPath(import.meta.url))) {
	let current = path.resolve(start);
	for (;;) {
		if (existsSync(path.join(current, ".git")) || existsSync(path.join(current, ".agents"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(start);
		current = parent;
	}
}

export function localDateString(date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

export function resolveCostLogPath(explicitPath) {
	if (explicitPath && typeof explicitPath === "string" && explicitPath.trim()) {
		return path.resolve(explicitPath.trim());
	}
	if (process.env.REVIEW_COST_LOG && process.env.REVIEW_COST_LOG.trim()) {
		return path.resolve(process.env.REVIEW_COST_LOG.trim());
	}
	const root = resolveRepoRoot();
	return path.join(root, ".agents", "progress", "review-cost", `${localDateString()}.jsonl`);
}

export function extractUsage(tool, raw) {
	if (typeof raw !== "string" || !raw.trim()) {
		return { usage: null, usageSource: null };
	}

	if (tool === "agy") {
		const { events } = parseStreamEvents(raw);
		for (const event of events.slice().reverse()) {
			for (const meta of streamMetadata(event)) {
				if (meta.usage && typeof meta.usage === "object") {
					const u = meta.usage;
					return {
						usage: {
							input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
							output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
							thinking_tokens: typeof u.thinking_tokens === "number" ? u.thinking_tokens : null,
							cache_read_tokens: typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : null,
							cache_write_tokens: typeof u.cache_write_tokens === "number" ? u.cache_write_tokens : null,
							total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
							cost_usd: typeof u.cost_usd === "number" ? u.cost_usd : null,
						},
						usageSource: "result.usage",
					};
				}
			}
		}
		return { usage: null, usageSource: null };
	}

	if (tool === "claude") {
		try {
			const data = JSON.parse(raw);
			if (data && typeof data === "object") {
				const u = data.usage;
				const totalCost = typeof data.total_cost_usd === "number"
					? data.total_cost_usd
					: (typeof u?.total_cost_usd === "number" ? u.total_cost_usd : null);
				if (u && typeof u === "object") {
					const cacheRead = typeof u.cache_read_input_tokens === "number"
						? u.cache_read_input_tokens
						: (typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : null);
					const cacheWrite = typeof u.cache_creation_input_tokens === "number"
						? u.cache_creation_input_tokens
						: (typeof u.cache_write_tokens === "number" ? u.cache_write_tokens : null);
					return {
						usage: {
							input_tokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
							output_tokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
							thinking_tokens: typeof u.thinking_tokens === "number" ? u.thinking_tokens : null,
							cache_read_tokens: cacheRead,
							cache_write_tokens: cacheWrite,
							total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
							cost_usd: totalCost,
						},
						usageSource: "claude_json",
					};
				}
				if (totalCost !== null) {
					return {
						usage: {
							input_tokens: null,
							output_tokens: null,
							thinking_tokens: null,
							cache_read_tokens: null,
							cache_write_tokens: null,
							total_tokens: null,
							cost_usd: totalCost,
						},
						usageSource: "claude_json",
					};
				}
			}
		} catch {}
		return { usage: null, usageSource: null };
	}

	const { events } = parseStreamEvents(raw);
	for (const event of events.slice().reverse()) {
		if (event && typeof event === "object") {
			const u = event.part?.tokens || event.tokens || event.usage;
			if (u && typeof u === "object") {
				const input = typeof u.input === "number" ? u.input : (typeof u.input_tokens === "number" ? u.input_tokens : null);
				const output = typeof u.output === "number" ? u.output : (typeof u.output_tokens === "number" ? u.output_tokens : null);
				return {
					usage: {
						input_tokens: input,
						output_tokens: output,
						thinking_tokens: typeof u.thinking_tokens === "number" ? u.thinking_tokens : null,
						cache_read_tokens: typeof u.cache_read_tokens === "number" ? u.cache_read_tokens : null,
						cache_write_tokens: typeof u.cache_write_tokens === "number" ? u.cache_write_tokens : null,
						total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : null,
						cost_usd: typeof u.cost_usd === "number" ? u.cost_usd : null,
					},
					usageSource: "tokens",
				};
			}
		}
	}

	return { usage: null, usageSource: null };
}

export function createCostLogEntry({
	ts = new Date().toISOString(),
	reviewId = null,
	stage = null,
	round = null,
	reviewerIndex = null,
	tool,
	model = null,
	repo,
	promptChars = 0,
	durationMs,
	outcome,
	failureReason = null,
	verdict = null,
	findingsCount = null,
	usage = null,
	usageSource = null,
}) {
	return {
		ts,
		review_id: reviewId,
		stage,
		round,
		reviewer_index: reviewerIndex,
		tool,
		model,
		repo,
		prompt_chars: promptChars,
		duration_ms: durationMs,
		outcome,
		failure_reason: failureReason,
		verdict,
		findings_count: findingsCount,
		usage,
		usage_source: usageSource,
	};
}

export async function recordReviewCost({
	costLog,
	reviewId = null,
	stage = null,
	round = null,
	reviewerIndex = null,
	tool,
	model = null,
	repo,
	promptChars = 0,
	durationMs,
	outcome,
	failureReason = null,
	verdict = null,
	findingsCount = null,
	rawOutput = "",
}) {
	const { usage, usageSource } = extractUsage(tool, rawOutput);
	const entry = createCostLogEntry({
		reviewId: reviewId ?? null,
		stage: stage ?? null,
		round: round ?? null,
		reviewerIndex: reviewerIndex ?? null,
		tool,
		model: model ?? null,
		repo,
		promptChars,
		durationMs,
		outcome,
		failureReason,
		verdict,
		findingsCount,
		usage,
		usageSource,
	});
	await appendCostLog(costLog, entry);
	return entry;
}

export async function appendCostLog(logPath, entry) {
	try {
		const resolved = resolveCostLogPath(logPath);
		await mkdir(path.dirname(resolved), { recursive: true });
		await appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf8");
	} catch (error) {
		console.error(`warning: failed to write review cost log: ${error.message}`);
	}
}
