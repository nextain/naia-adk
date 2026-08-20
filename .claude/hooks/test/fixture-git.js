"use strict";
/**
 * 테스트가 진짜 저장소에 커밋하지 못하게 막는다.
 *
 * 2026-08-20 에 실제로 그런 일이 있었다. 픽스처 커밋 약 290개가 이 저장소의
 * main 위에 쌓였고, 그 상태가 원격으로 나가 파일 1536개가 지워진 main 이 됐다.
 * 커밋 메시지는 "fixture baseline", "candidate", "target" 이었다 — 사람이 만든
 * 것이 아니라 테스트가 만든 것이다.
 *
 * 픽스처는 대부분 `mkdtemp` 로 임시 디렉터리를 만들고 `git init` 을 한다. 그
 * 자체는 옳다. 문제는 그 격리가 한 번이라도 어긋났을 때 git 이 조용히 위로
 * 올라가 감싸고 있는 저장소를 찾아낸다는 것이다. cwd 가 undefined 로 넘어가거나,
 * init 이 실패했는데 그대로 진행하거나, 임시 경로가 저장소 안쪽이면 그렇게 된다.
 * 그때 커밋은 실패하지 않는다. 엉뚱한 곳에 성공한다.
 *
 * 구조만으로는 진짜 저장소와 픽스처를 구분할 수 없다. 둘 다 `.git` 이 있고 둘 다
 * 자기가 최상위다. 그래서 픽스처는 만들 때 표식을 하나 남기고, 커밋은 그 표식이
 * 있는 곳에서만 허용한다. 표식이 없으면 그곳은 누군가의 진짜 작업물이다.
 * 조용히 성공하는 것보다 시끄럽게 멈추는 편이 낫다.
 */
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const FIXTURE_MARKER = "naia-test-fixture";

/** git 이 이 디렉터리 밖으로 올라가지 못하게 막은 환경. */
function sealedEnv(root, env = process.env) {
	return {
		...env,
		GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(root)),
		GIT_DIR: path.join(path.resolve(root), ".git"),
		GIT_WORK_TREE: path.resolve(root),
	};
}

/**
 * 이 디렉터리가 자기 저장소인지 확인한다. 아니면 던진다.
 *
 * 픽스처를 만든 쪽이 `git init` 을 빠뜨렸거나 실패했는데 눈치채지 못한 경우를
 * 여기서 잡는다.
 */
function assertOwnRepository(root) {
	const resolved = path.resolve(root);
	if (!fs.existsSync(path.join(resolved, ".git"))) {
		throw new Error(`[FIXTURE GUARD] ${resolved} 에 .git 이 없습니다. 픽스처가 감싸는 저장소에 커밋하려 합니다.`);
	}
	const top = cp.spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: resolved,
		env: sealedEnv(resolved),
		encoding: "utf8",
	});
	if (top.status !== 0) {
		throw new Error(`[FIXTURE GUARD] ${resolved} 의 저장소를 확인할 수 없습니다: ${(top.stderr || "").trim()}`);
	}
	const toplevel = fs.realpathSync(top.stdout.trim());
	if (toplevel !== fs.realpathSync(resolved)) {
		throw new Error(`[FIXTURE GUARD] 커밋 대상이 픽스처가 아니라 ${toplevel} 입니다. 픽스처: ${resolved}`);
	}
	if (!fs.existsSync(path.join(resolved, ".git", FIXTURE_MARKER))) {
		throw new Error(`[FIXTURE GUARD] ${resolved} 는 픽스처가 아닙니다. initFixtureRepository 로 만든 저장소에서만 쓸 수 있습니다.`);
	}
	return resolved;
}

/**
 * 픽스처 안에서만 도는 git. cwd 를 생략할 수 없고, 대상이 자기 저장소가 아니면
 * 실행 자체를 하지 않는다.
 */
function fixtureGit(root, args, options = {}) {
	if (typeof root !== "string" || !root) {
		throw new Error("[FIXTURE GUARD] 픽스처 경로 없이 git 을 실행할 수 없습니다.");
	}
	const resolved = assertOwnRepository(root);
	const result = cp.spawnSync("git", args, {
		...options,
		cwd: resolved,
		env: sealedEnv(resolved, options.env),
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(`[FIXTURE GUARD] git ${args.join(" ")} 실패: ${(result.stderr || result.stdout || "").trim()}`);
	}
	return (result.stdout || "").trim();
}

/** 픽스처 저장소를 만든다. 여기까지 통과해야 커밋이 가능해진다. */
function initFixtureRepository(root, { name = "Fixture", email = "fixture@example.invalid" } = {}) {
	const resolved = path.resolve(root);
	const init = cp.spawnSync("git", ["init", "-q"], { cwd: resolved, env: sealedEnv(resolved), encoding: "utf8" });
	if (init.status !== 0) {
		throw new Error(`[FIXTURE GUARD] 픽스처 저장소를 만들지 못했습니다: ${(init.stderr || "").trim()}`);
	}
	fs.writeFileSync(path.join(resolved, ".git", FIXTURE_MARKER), "테스트 픽스처입니다. 사람 작업물이 아닙니다.\n");
	fixtureGit(resolved, ["config", "user.name", name]);
	fixtureGit(resolved, ["config", "user.email", email]);
	fixtureGit(resolved, ["config", "core.autocrlf", "false"]);
	return resolved;
}

module.exports = { FIXTURE_MARKER, assertOwnRepository, fixtureGit, initFixtureRepository, sealedEnv };
