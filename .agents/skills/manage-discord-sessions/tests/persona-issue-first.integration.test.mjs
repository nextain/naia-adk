// 유스케이스 통합 시험(ET) — 가짜 디스코드 한 대로 요청부터 회신까지.
//
// 단위 시험은 조각이 옳다고 말한다. 이 파일은 **사람이 겪는 한 바퀴**를 본다.
// 채널에 글을 쓰고, 봇이 자기 정체성으로 일하고, 이슈를 세우고, 회신이 채널에
// 나가고, 다음 요청이 그 이슈를 잇는 것까지.
//
// 진짜 디스코드에 붙지 않는다. 토큰이 필요하고 남의 서버에 글을 쓰며, 실패해도
// 원인이 우리 코드인지 네트워크인지 가릴 수 없다. 가짜 서버는
// `fixtures/mock-discord.mjs` 에 있고 무엇을 흉내 내지 않는지도 거기 적혀 있다.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { buildAgentContextSnapshot } from "../helper/agent-context.mjs";
import { DiscordMessageRouter } from "../helper/discord-router.mjs";
import { BOT, CHANNEL, GUILD, RUNTIME_REVISION, USER, binding, cleanupDiscordFixtureRoots, fixture } from "./fixtures/discord-fixture.mjs";
import { mockDiscord } from "./fixtures/mock-discord.mjs";

afterEach(cleanupDiscordFixtureRoots);

const TRACKER = { provider: "github", repo: "example-org/example-repo" };
const ISSUE = (n) => `https://github.com/${TRACKER.repo}/issues/${n}`;

/**
 * 운영 모양의 작업공간.
 *
 * 설정은 ADK 루트에 있고 작업공간은 그 **하위 디렉터리**다. 둘을 같은 자리에 두면
 * 운영에서 실제로 겪는 경로 관계를 한 번도 안 밟는다 — 4회차 적대리뷰가 짚었다.
 */
function workspaceWithNaiaSettings(adkRoot, { agentName = "Example Agent", persona = "따뜻한 AI 동반자", userName = "Owner", honorific = "boss", workspaceDir = "projects/work" } = {}) {
	const workspace = join(adkRoot, workspaceDir);
	mkdirSync(join(adkRoot, "naia-settings"), { recursive: true });
	mkdirSync(workspace, { recursive: true });
	writeFileSync(join(workspace, "AGENTS.md"), "# Entry\n", "utf8");
	writeFileSync(join(adkRoot, "naia-settings/config.json"), JSON.stringify({
		agentName, persona, userName, honorific, speechStyle: "formal", locale: "ko",
		// 같은 파일에 자격값이 함께 산다. 프롬프트로 새면 안 된다.
		NAIA_ANYLLM_API_KEY: "sk-must-not-appear",
	}), "utf8");
	return buildAgentContextSnapshot({ workspace, agentId: "work-agent", entrypoint: "AGENTS.md", contextFiles: [], personaSourceRoot: adkRoot });
}

/**
 * 운영의 대화 이력 적재기를 대신한다. 실제 서비스는 언제나 이것을 넘긴다.
 *
 * `history` 는 이미 렌더된 글이다(`promptWithDiscordConversation` 가 그대로 끼운다).
 * 여기서 구조체를 넘기면 실제 계약과 달라져 시험이 거짓으로 통과한다.
 */
function priorTurns() {
	return async () => ({
		state: "loaded",
		history: "participant[workspace-owner]: 지난번 그 건 어떻게 됐어?\nagent: 확인 중입니다.",
	});
}

function gatewayConfig({ actions = ["read", "reply", "write", "execute"], issueTracker = TRACKER } = {}) {
	return {
		schemaVersion: 2,
		workspace: { agentId: "work-agent", ...(issueTracker === null ? {} : { issueTracker }) },
		persona: { source: "naia-settings", instructions: "이 인스턴스는 맡은 채널의 업무만 처리한다." },
		role: { name: "issue-driven-development", allowedActions: actions, requiresApproval: [] },
		backend: { selected: "codex", profiles: { codex: { enabled: true } } },
		discord: {
			bindings: [{ ...binding(), operatorActions: true, historyVisibility: "none" }],
			operatorUserIds: [USER],
			participantProfiles: { [USER]: { label: "workspace-owner", relationship: "workspace owner", allowedActions: actions } },
		},
		runtime: { maxConcurrentJobs: 1, approvalPolicy: "never", permissionProfileEpoch: "et-v1" },
		recovery: { autoRetry: false },
	};
}

test("UCT_DSO_017_001 대화봇의 정체성 그대로 업무 채널에서 답한다", async () => {
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root, { agentName: "Example Agent", persona: "조용하고 따뜻하게 곁에 있다.", userName: "Owner", honorific: "boss" });
		const prompts = [];
		const router = new DiscordMessageRouter({
			config: gatewayConfig({ actions: ["read", "reply"], issueTracker: null }), store,
			token: "token-value-long-enough", botUserId: BOT, cwd: snapshot.workspaceRoot,
			runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot, runtimeRevision: RUNTIME_REVISION,
			send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async (input) => { prompts.push(input.prompt); return { backendOutcome: "success", attemptId: "a1", transientResult: "네, 확인했습니다." }; },
		});
		const { envelope, sequence } = discord.message("상태 알려줘");
		const accepted = await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		assert.equal(accepted.state, "accepted");
		await router.waitForIdle();

		// 정체성이 설정에서 그대로 온다
		assert.ok(prompts[0].includes("Persona: Example Agent"), "설정의 이름이 안 쓰였다");
		assert.ok(prompts[0].includes("조용하고 따뜻하게 곁에 있다."), "설정의 페르소나 글이 안 실렸다");
		assert.ok(prompts[0].includes('Address them as "boss"'), "호칭이 이름과 따로 안 실렸다");
		assert.ok(prompts[0].includes("이 인스턴스는 맡은 채널의 업무만 처리한다."), "인스턴스 경계가 사라졌다");
		// 같은 파일의 자격값은 절대 실리지 않는다
		assert.ok(!prompts[0].includes("must-not-appear"), "설정 파일의 자격값이 프롬프트로 샜다");
		// 대화 요청이므로 이슈 계약은 없다
		assert.ok(!prompts[0].includes("Issue-first contract"), "대화 요청에 이슈 계약이 실렸다");
		// 사람이 채널에서 답을 본다
		assert.equal(discord.lastResult(), "네, 확인했습니다.");
	} finally { store.close(); }
});

test("UCT_DSO_018_001 업무를 요청하면 이슈를 세우고 다음 요청이 그 이슈를 잇는다", async () => {
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		const prompts = [];
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async (input) => {
				prompts.push(input.prompt);
				// 첫 요청은 이슈를 세우고 밝힌다. 둘째는 이어받아 일한다.
				const body = prompts.length === 1 ? `이슈를 세우고 고쳤습니다.\n\nIssue: ${ISSUE(77)}` : `이어서 마무리했습니다.\n\nIssue: ${ISSUE(77)}`;
				return { backendOutcome: "success", attemptId: `a${prompts.length}`, transientResult: body };
			},
		});

		const first = discord.message("로그인 버그 고쳐줘");
		const acceptedFirst = await router.onDispatch("MESSAGE_CREATE", { ...first.envelope, guild_id: GUILD }, first.sequence);
		assert.equal(acceptedFirst.state, "accepted");
		await router.waitForIdle();

		// 계약이 실렸고, 프로젝트를 먼저 뒤지라고 말한다
		assert.ok(prompts[0].includes("Issue-first contract"), "업무 요청에 이슈 계약이 없다");
		assert.ok(prompts[0].includes("search the project"), "프로젝트 탐색 단계가 없다");
		assert.ok(prompts[0].includes(TRACKER.repo), "이슈 저장소가 계약에 없다");
		// 작업이 이슈 작업으로 기록되고 회신의 이슈가 거두어진다
		const firstJob = store.getJob(acceptedFirst.jobId, { includeEvents: false });
		assert.equal(firstJob.jobType, "issue_work", "업무 요청이 issue_work 로 안 기록됐다");
		assert.equal(firstJob.issueUrl, ISSUE(77), "회신의 이슈를 못 거뒀다");
		assert.equal(store.currentScopeIssue(firstJob.scopeKey), ISSUE(77), "대화에 현재 이슈가 안 남았다");
		// 사람이 채널에서 이슈 주소를 본다
		assert.ok(discord.lastResult().includes(ISSUE(77)), "회신이 이슈를 안 밝혔다");

		const second = discord.message("이어서 해줘");
		const acceptedSecond = await router.onDispatch("MESSAGE_CREATE", { ...second.envelope, guild_id: GUILD }, second.sequence);
		assert.equal(acceptedSecond.state, "accepted");
		await router.waitForIdle();
		assert.ok(prompts[1].includes(`was last working on ${ISSUE(77)}`), "다음 요청이 앞의 이슈를 안 이었다");
		assert.ok(prompts[1].includes("still open and actually covers this request"), "닫힌 이슈를 잇지 말라는 조건이 없다");
		assert.ok(prompts[1].includes("skip steps 3 and 4"), "이으면 검색·생성을 건너뛰라는 말이 없다");
	} finally { store.close(); }
});

test("UCT_DSO_018_002 질문에는 이슈를 세우지 않고 엉뚱한 이슈에 매이지도 않는다", async () => {
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			// 쓰기 권한자가 질문을 했고, 모델이 관련 이슈를 늘어놓았다. 선언은 하지 않았다.
			runner: async () => ({ backendOutcome: "success", attemptId: "a1", transientResult: `관련 이슈입니다.\n- ${ISSUE(12)}\n- ${ISSUE(13)}` }),
		});
		const { envelope, sequence } = discord.message("이 버그 뭐야?");
		const accepted = await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		await router.waitForIdle();
		const job = store.getJob(accepted.jobId, { includeEvents: false });
		assert.equal(job.issueUrl, null, "선언하지 않은 회신에서 이슈를 거뒀다");
		assert.equal(store.currentScopeIssue(job.scopeKey), null, "대화가 언급뿐인 이슈에 매였다");
		assert.ok(discord.lastResult().includes(ISSUE(12)), "회신 자체는 사람에게 그대로 전달되어야 한다");
	} finally { store.close(); }
});

test("UCT_DSO_017_002 대화 이력이 실려도 정체성과 계약이 한 번씩 남는다", async () => {
	// 운영은 언제나 대화 이력 적재기를 넘기고, 그 적재기가 프롬프트를 다시 쓴다.
	// 이력이 붙는 과정에서 정체성이 밀리거나 두 번 실리면 사람이 겪는 것이 달라진다.
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root, { persona: "조용하고 따뜻하게 곁에 있다." });
		const prompts = [];
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			loadHistory: priorTurns(),
			runner: async (input) => { prompts.push(input.prompt); return { backendOutcome: "success", attemptId: "a1", transientResult: `했습니다.\n\nIssue: ${ISSUE(5)}` }; },
		});
		const { envelope, sequence } = discord.message("이어서 고쳐줘");
		await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		await router.waitForIdle();
		assert.equal(prompts.length, 1, "이력 적재 때문에 요청이 안 돌았다");
		assert.equal(prompts[0].split("조용하고 따뜻하게 곁에 있다.").length - 1, 1, "정체성이 두 번 실렸다");
		assert.ok(prompts[0].includes("Issue-first contract"), "이력이 붙으면서 이슈 계약이 사라졌다");
		assert.ok(prompts[0].includes("지난번 그 건 어떻게 됐어?"), "대화 이력이 실리지 않았다");
		assert.ok(!prompts[0].includes("must-not-appear"), "자격값이 샜다");
	} finally { store.close(); }
});

test("UCT_DSO_017_003 설정이 바뀌면 도는 작업이 멈추고 재시작을 요구한다", async () => {
	// 정체성이 중간에 바뀌면 그 작업이 누구로 시작해 누구로 끝났는지 말할 수 없다.
	// spawn 직전 검사가 이것을 잡아야 하고, 잡으면 백엔드는 아예 안 불려야 한다.
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		let runnerCalls = 0;
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async () => { runnerCalls += 1; return { backendOutcome: "success", attemptId: "a1", transientResult: "ok" }; },
		});
		// 사람이 셸에서 페르소나를 바꿨다
		writeFileSync(join(root, "naia-settings/config.json"), JSON.stringify({ agentName: "Example Agent", persona: "바뀐 성격" }), "utf8");
		const { envelope, sequence } = discord.message("고쳐줘");
		const accepted = await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		assert.equal(accepted.state, "accepted");
		await router.waitForIdle();
		assert.equal(runnerCalls, 0, "정체성이 바뀌었는데 백엔드를 불렀다");
		const job = store.getJob(accepted.jobId, { includeEvents: true });
		assert.ok(["failed", "recovery_review"].includes(job.lifecycle), `정체성 드리프트인데 ${job.lifecycle} 로 끝났다`);
	} finally { store.close(); }
});

test("UCT_DSO_018_003 이슈를 밝히지 않고 끝나면 기록에 신호가 남는다", async () => {
	// 계약을 진 작업이 이슈 없이 끝나면, 기록만 봐서는 질문에 답한 것과 구별되지
	// 않는다. 바꾼 것이 어디에도 안 매인 채 조용히 묻힌다 — 4회차 적대리뷰가 짚었다.
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async () => ({ backendOutcome: "success", attemptId: "a1", transientResult: "고쳤습니다. 끝." }),
		});
		const { envelope, sequence } = discord.message("고쳐줘");
		const accepted = await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		await router.waitForIdle();
		const job = store.getJob(accepted.jobId, { includeEvents: true });
		assert.equal(job.issueUrl, null, "선언이 없는데 이슈가 남았다");
		assert.ok(job.events.some((event) => event.kind === "issue_declaration_missing"),
			"이슈 없이 끝난 업무 작업에 신호가 없다 — 기록만 보면 질문과 구별되지 않는다");
	} finally { store.close(); }
});

test("UCT_DSO_018_004 작업이 아니었다고 밝히면 대화로 되돌아간다", async () => {
	// 쓰기 권한자가 던진 질문은 계약을 지고 시작하지만 작업이 아니다. 침묵과
	// "작업 아님"을 한 덩어리로 묶으면, 그 질문이 추적 없이 끝난 작업과 기록상
	// 똑같아진다 — 5회차 적대리뷰가 짚었다.
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		const router = new DiscordMessageRouter({
			config: gatewayConfig(), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async () => ({ backendOutcome: "success", attemptId: "a1", transientResult: "질문에 답했습니다. 바꾼 것은 없습니다.\n\nIssue: none" }),
		});
		const { envelope, sequence } = discord.message("이거 왜 이래?");
		const accepted = await router.onDispatch("MESSAGE_CREATE", { ...envelope, guild_id: GUILD }, sequence);
		await router.waitForIdle();
		const job = store.getJob(accepted.jobId, { includeEvents: true });
		// 작업 종류는 호스트가 정한 그대로 둔다. 검증되지 않은 모델의 한 줄이 분류를
		// 낮추면, 실제로 파일을 바꾸고 none 이라고 쓴 작업이 대화로 위장된다.
		assert.equal(job.jobType, "issue_work", "모델의 한 줄이 호스트의 분류를 덮었다");
		assert.equal(job.issueUrl, null, "작업 아님인데 이슈가 기록됐다");
		assert.ok(job.events.some((event) => event.kind === "issue_declared_none"),
			"작업 아님 선언이 기록되지 않았다");
		assert.ok(!job.events.some((event) => event.kind === "issue_declaration_missing"),
			"밝혔는데 미선언 신호가 붙었다 — 침묵과 구별되지 않는다");
	} finally { store.close(); }
});

test("UCT_DSO_018_005 저장소를 바꾸면 옛 이슈를 잇지 않는다", async () => {
	// 트래커를 바꾸면 옛 이슈가 대화에 남는다. 그것을 이으라고 하면 모델이 남의
	// 저장소 이슈를 선언하고, 거두기는 저장소가 달라 거절한다 — 대화가 옛 이슈에
	// 영구히 묶이고 매 요청마다 미선언이 쌓인다.
	const { store, root } = fixture();
	const discord = mockDiscord({ botUserId: BOT, channelId: CHANNEL, userId: USER });
	try {
		const snapshot = workspaceWithNaiaSettings(root);
		const prompts = [];
		const make = (tracker) => new DiscordMessageRouter({
			config: gatewayConfig({ issueTracker: tracker }), store, token: "token-value-long-enough", botUserId: BOT,
			cwd: snapshot.workspaceRoot, runtimeRoot: join(root, "runtime"), agentContextSnapshot: snapshot,
			runtimeRevision: RUNTIME_REVISION, send: discord.send, deliver: async (input) => discord.deliver(input),
			runner: async (input) => { prompts.push(input.prompt); return { backendOutcome: "success", attemptId: `a${prompts.length}`, transientResult: `했습니다.\n\nIssue: ${ISSUE(21)}` }; },
		});
		const first = discord.message("고쳐줘");
		await make(TRACKER).onDispatch("MESSAGE_CREATE", { ...first.envelope, guild_id: GUILD }, first.sequence);
		await make(TRACKER).waitForIdle();
		assert.equal(store.currentScopeIssue(store.getJob((store.listJobs({ limit: 1 })[0]).jobId, { includeEvents: false }).scopeKey), ISSUE(21));

		// 저장소가 바뀌었다
		const moved = { provider: "github", repo: "example-org/moved-repo" };
		const second = discord.message("이어서 해줘");
		const router = make(moved);
		await router.onDispatch("MESSAGE_CREATE", { ...second.envelope, guild_id: GUILD }, second.sequence);
		await router.waitForIdle();
		assert.ok(!prompts[1].includes(ISSUE(21)), "저장소가 바뀌었는데 옛 이슈를 이으라고 했다");
		assert.ok(prompts[1].includes("Search the open issues of example-org/moved-repo"), "새 저장소에서 찾으라고 안 했다");
	} finally { store.close(); }
});
