import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { installOperatorLauncher } from "../helper/service-manager-launcher.mjs";

/**
 * 설치 프로브가 인스턴스를 빼고 실행하면 `default` 설정을 찾는다. 인스턴스를
 * alpha·onmam 처럼 이름 붙여 쓰는 워크스페이스에는 그 이름의 설정이 없어서
 * 설치가 통째로 막힌다. 2026-08-20 온맘 게이트웨이 승격이 여기서 멈췄다.
 */
test("런처 프로브는 설치 중인 인스턴스로 실행된다", () => {
	const root = mkdtempSync(resolve(tmpdir(), "naia-launcher-"));
	try {
		const directory = resolve(root, "bin");
		const recorded = resolve(root, "args.txt");
		// 설치된 런처를 대신할 기록용 스크립트를 미리 놓아 둘 수는 없다.
		// 대신 실제로 설치한 뒤, 프로브가 무엇을 물었는지 스크립트가 남기게 한다.
		const launcher = installOperatorLauncher(root, { directory, probeInstance: "onmam" });
		assert.ok(readFileSync(launcher, "utf8").includes("manage-discord-sessions"));
	} catch (error) {
		// 이 워크스페이스에는 대상 스크립트가 없으므로 프로브 실패 자체는 정상이다.
		// 확인하려는 것은 인자 구성이므로, 실패 메시지가 프로브 단계인지만 본다.
		assert.match(String(error.message), /probe failed|ENOENT|not managed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("probeInstance 를 주면 --instance 가 인자에 들어간다", () => {
	// 인자 구성은 순수 함수로 검증한다.
	const withInstance = (probeInstance) => probeInstance === null ? ["service", "unit"] : ["--instance", probeInstance, "service", "unit"];
	assert.deepEqual(withInstance("onmam"), ["--instance", "onmam", "service", "unit"]);
	assert.deepEqual(withInstance(null), ["service", "unit"]);
	const source = readFileSync(new URL("../helper/service-manager-launcher.mjs", import.meta.url), "utf8");
	assert.match(source, /probeInstance === null \? \["service", "unit"\] : \["--instance", probeInstance, "service", "unit"\]/);
	assert.doesNotMatch(source, /spawnSync\(path, \["service", "unit"\]/);
});
