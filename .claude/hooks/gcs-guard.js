#!/usr/bin/env node
/**
 * GCS Guard Hook (PreToolUse on Bash) — host-agnostic 엔진
 *
 * 정책/버킷은 gcs-guard.config.json 에서 로드. 엔진은 fork 간 공통(수정 금지).
 *   - naia-adk(public): config는 example만 (실버킷명 X)
 *   - onmam-adk/alpha-adk(private): 실제 버킷명 + marker(gcs-guard.required)
 *
 * fail 정책 (codex 리뷰 반영):
 *   - marker(gcs-guard.required) 없음 = 비대상 repo → config 정상이면 enforce, 아니면 noop (fail-open 허용)
 *   - marker 있음 = 대상 repo → config missing/invalid/empty/typo → fail-CLOSED (모든 GCS CLI 차단)
 *
 * 탐지: command 원본에서 (따옴표 제거 안 함 — quoted bucket bypass 방지, codex 지적)
 *
 * 한계 (정규식 불가 — IAM 최소권한이 근본 방어):
 *   버킷명 완전 은닉($(cat f)/base64), python SDK, curl+bearer, shell indirection
 */

const fs = require("fs");
const path = require("path");

const VALID_RISK = new Set(["archive", "prod"]);

function loadPolicy() {
	const dir = __dirname;
	const markerRequired = fs.existsSync(path.join(dir, "gcs-guard.required"));

	let raw = null, parseError = false, missing = false;
	try {
		raw = fs.readFileSync(path.join(dir, "gcs-guard.config.json"), "utf8");
	} catch (e) {
		if (e && e.code === "ENOENT") missing = true;
		else parseError = true; // 읽기 오류
	}
	let cfg = null;
	if (raw !== null) {
		try {
			cfg = JSON.parse(raw);
		} catch {
			parseError = true;
		}
	}
	const buckets = cfg && cfg.buckets;
	const keys = buckets && typeof buckets === "object" ? Object.keys(buckets) : [];
	const validSchema =
		keys.length > 0 && keys.every((k) => VALID_RISK.has(buckets[k]));

	if (!markerRequired) {
		// 비대상 repo: 정상 config면 enforce, 그 외 noop (fail-open 허용)
		if (!parseError && !missing && validSchema)
			return { mode: "enforce", all: keys, archive: keys.filter((k) => buckets[k] === "archive") };
		return { mode: "noop" };
	}
	// 대상 repo (marker 존재): config 문제면 fail-CLOSED
	if (missing) return { mode: "failclosed", why: "config 파일 없음(gcs-guard.config.json)" };
	if (parseError) return { mode: "failclosed", why: "config JSON 파손" };
	if (!validSchema) return { mode: "failclosed", why: "config 비었거나 risk class 오타(archive|prod 만 허용)" };
	return { mode: "enforce", all: keys, archive: keys.filter((k) => buckets[k] === "archive") };
}

function bucketPattern(names) {
	if (!names.length) return null;
	const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
	return new RegExp(`(gs://|storage\\.googleapis\\.com/(storage/v1/b/)?|gcs:)(${alt})\\b`);
}

async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		process.exit(0); // 비정상 입력: crash 금지, 통과
	}
	if ((data.tool_name || "") !== "Bash") process.exit(0);

	const command = data.tool_input?.command || "";
	const pol = loadPolicy();
	if (pol.mode === "noop") process.exit(0);

	const block = (reason) => {
		process.stdout.write(JSON.stringify({ decision: "block", reason }));
		process.exit(0);
	};

	const anyGcsCli = /\b(gsutil|gcloud\s+(?:alpha\s+|beta\s+)?storage|rclone)\b/.test(command);

	// fail-CLOSED: 대상 repo인데 config 문제 → 모든 GCS CLI 차단
	if (pol.mode === "failclosed") {
		if (anyGcsCli) {
			block(
				"[GCS Guard] 가드 설정 오류로 GCS 명령을 차단합니다 (fail-closed)\n" +
					`사유: ${pol.why}\n` +
					"gcs-guard.config.json 을 복구/수정한 뒤 다시 시도하세요. (비용 사고 방지)",
			);
		}
		process.exit(0);
	}

	// === enforce ===
	// 탐지는 command 원본에서 (따옴표 안 버킷명도 탐지 — codex: quoted bypass 방지)
	const cmd = command;
	const prodPat = bucketPattern(pol.all);
	const archivePat = bucketPattern(pol.archive);
	const cliPat = /\b(gsutil|gcloud\s+(?:alpha\s+|beta\s+)?storage|rclone)\b/;

	// [prod] lifecycle (2026-05-06 사고)
	if (
		/gsutil\s+lifecycle\s+(set|del)\b/.test(cmd) ||
		/gcloud\s+storage\s+buckets\s+update\s+.*--lifecycle/.test(cmd)
	) {
		block(
			"[GCS Guard] Lifecycle Rule 변경 차단\n" +
				"2026-05-06 사고: lifecycle 오남용으로 운영 버킷 전체 ARCHIVE 전환. 버킷/규칙/이유 확인 필요.",
		);
	}

	// [prod] IAM 변경
	if (
		prodPat &&
		prodPat.test(cmd) &&
		(/gcloud\s+storage\s+buckets\s+(add|remove)-iam-policy-binding/.test(cmd) ||
			/gcloud\s+storage\s+buckets\s+set-iam-policy/.test(cmd) ||
			/gsutil\s+iam\s+set/.test(cmd))
	) {
		block("[GCS Guard] 운영 버킷 IAM 변경 차단 — GCP 콘솔에서 직접 수행하세요.");
	}

	// [prod] 대량 storage class rewrite
	if (
		/gsutil\s+(-m\s+)?rewrite\s+(-[a-z]+\s+)*-s\s+\w+\s+.*\/\*\*/.test(cmd) ||
		/gcloud\s+storage\s+objects\s+update\s+.*--storage-class.*--recursive/.test(cmd)
	) {
		block("[GCS Guard] 대량 storage class 변경 차단 — retrieval+early deletion fee. 대상/class/비용 확인.");
	}

	// [archive] 데이터 read = retrieval 비용 (#246)
	if (
		archivePat &&
		archivePat.test(cmd) &&
		cliPat.test(cmd) &&
		/\b(cp|cat|rsync|copy|sync|mv|move|du)\b/.test(cmd)
	) {
		block(
			"[GCS Guard] ARCHIVE 버킷 데이터 접근 차단 (retrieval 비용)\n" +
				"ARCHIVE class는 read마다 GB당 retrieval 요금. #246: 6시간 retrieval로 비용 폭증.\n" +
				"진단은 billing/audit로 우회, 꼭 필요하면 비용 추정 후 사용자 확인.",
		);
	}

	// [archive] 재귀 ls = Class B operations
	if (
		archivePat &&
		archivePat.test(cmd) &&
		/\bls\b/.test(cmd) &&
		(/\s-[a-zA-Z]*r/.test(cmd) || /--recursive/.test(cmd) || /\*\*/.test(cmd))
	) {
		block("[GCS Guard] ARCHIVE 버킷 재귀 ls 차단 (Class B 비용) — 단일 prefix ls 또는 billing/audit 우회.");
	}

	// [any GCS] gcloud storage rsync -n 함정
	if (/gcloud\s+storage\s+rsync/.test(cmd) && /\s-n\b/.test(cmd) && !/--dry-run/.test(cmd)) {
		block(
			"[GCS Guard] `gcloud storage rsync -n` 은 dry-run이 아닙니다 (실제 실행됨!)\n" +
				"gcloud의 dry-run은 `--dry-run`. `-n`은 gsutil 전용. #246 prod 오업로드 원인.",
		);
	}

	// [prod] 대량 transfer
	if (
		prodPat &&
		prodPat.test(cmd) &&
		!/--dry-run/.test(cmd) &&
		/(gcloud\s+(?:alpha\s+|beta\s+)?storage\s+(rsync|(cp|mv)\s+.*--recursive)|gsutil\s+(-m\s+)?(cp|rsync|mv)\s+(-[a-zA-Z]*\s+)*-r|rclone\s+(copy|sync|move))/.test(
			cmd,
		)
	) {
		block("[GCS Guard] 운영 버킷 대량 transfer 확인 필요 — 대상/방향/예상비용 보고 후 확인.");
	}

	process.exit(0);
}

main().catch(() => process.exit(0));
