// 나이아 설정에서 페르소나를 읽는다.
//
// 나이아는 자기 페르소나로 대화하고, 업무는 같은 페르소나를 쓰는 별도 게이트웨이의
// 코딩 에이전트가 받는다. 사용자에게는 한 사람이어야 하기 때문이다. 그래서 업무
// 게이트웨이는 페르소나 글을 따로 적지 않고 나이아가 쓰는 설정에서 가져온다.
// 사상은 `.agents/context/discord-gateway-persona-sharing.yaml` 에 있다.
//
// 그 설정 파일에는 자격값도 들어 있다. 통째로 프롬프트에 실으면 비밀이 샌다.
// 그래서 **정해진 항목만** 읽는다. 목록에 없는 키는 파일에 무엇이 있든 무시한다.

import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

// 정본은 `config.json` 하나다. `packages/shell/src/lib/config.ts` 가 그 파일을
// "agent 소비: persona·이름·말투·locale·provider·model. SoT" 라고 못박고, 셸의 설정
// 화면과 온보딩이 저장할 때마다 여기에 쓴다.
//
// 같은 디렉터리의 `persona.json` 은 2026-05-15 이후 어떤 코드도 읽지 않는다. 한때
// 그것을 엮는 설계안이 있었지만(2026-06-29 G1) 코드가 그 뒤에 단일 SoT 로 정리됐다.
// 문서보다 코드가 최신이다. 더 긴 캐릭터 자료를 따로 두는 워크스페이스도 있지만,
// 프롬프트에 실리는 것은 언제나 `config.json` 의 `persona` 한 줄이다.

/** `config.json` 에서 읽는 항목. 이 목록 밖의 것은 읽지 않는다. */
export const NAIA_PERSONA_FIELDS = Object.freeze(["agentName", "persona", "userName", "locale", "speechStyle", "honorific"]);

const MAX_SETTINGS_BYTES = 256 * 1024;
const MAX_FIELD_LENGTH = 4_000;

/** 나이아 설정 파일의 자리. 작업공간이 아니라 ADK 루트 기준이다. */
export function naiaSettingsPath(adkRoot) {
	if (typeof adkRoot !== "string" || !isAbsolute(adkRoot)) throw new Error("naia settings root must be an absolute path");
	return resolve(adkRoot, "naia-settings/config.json");
}

/**
 * 한 줄짜리 항목. 줄바꿈을 허용하지 않는다.
 *
 * 이름·호칭·말투는 우리가 만든 문장 안에 끼워 넣는다. 거기에 줄바꿈이 들어가면
 * 프롬프트의 다른 절을 흉내 낼 수 있다 — `agentName` 에 "X\nRole: root" 를 넣으면
 * `Role:` 줄이 새로 생긴다. 설정 파일은 셸이 소유하지만, 그 파일이 프롬프트의
 * 구조를 바꿀 수 있어서는 안 된다.
 */
function singleLineField(value, label) {
	const text = boundedField(value, label);
	if (text === null) return null;
	if (/[\r\n]/.test(text)) throw new Error(`naia persona field ${label} must be a single line`);
	return text;
}

function boundedField(value, label) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new Error(`naia persona field ${label} must be text`);
	const trimmed = value.trim();
	if (trimmed.length > MAX_FIELD_LENGTH) throw new Error(`naia persona field ${label} is too long`);
	return trimmed === "" ? null : trimmed;
}

/** 줄바꿈을 그대로 둘 수 있는 항목. 자기 문단으로만 나가므로 구조를 못 바꾼다. */
const MULTILINE_FIELDS = new Set(["persona"]);

function readSelectedFields(path, fields, { optional = false } = {}) {
	let stat;
	try { stat = lstatSync(path); }
	catch (error) { if (optional && error?.code === "ENOENT") return {}; throw error; }
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("naia settings must be a real file");
	if (stat.size > MAX_SETTINGS_BYTES) throw new Error("naia settings file is too large");
	const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
	let parsed;
	try { parsed = JSON.parse(readFileSync(fd, "utf8")); }
	finally { closeSync(fd); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("naia settings must be an object");
	const selected = {};
	// 이름은 인스턴스 설정의 `persona.name` 과 같은 한도를 받는다. 출처가 다르다고
	// 프롬프트에 실리는 길이가 달라질 이유가 없다.
	const LIMITS = { agentName: 80, userName: 80, honorific: 40, locale: 32, speechStyle: 32 };
	for (const field of fields) {
		const value = MULTILINE_FIELDS.has(field) ? boundedField(parsed[field], field) : singleLineField(parsed[field], field);
		if (value !== null && LIMITS[field] !== undefined && value.length > LIMITS[field]) throw new Error(`naia persona field ${field} is too long`);
		if (value !== null) selected[field] = value;
	}
	return selected;
}

/**
 * 페르소나 재료를 모은다.
 *
 * 셸이 소유하는 파일이고 여기서는 읽기만 한다. 같은 파일에 provider·model·자격 관련
 * 값이 함께 있으므로 목록에 적은 항목만 읽는다.
 */
export function readNaiaPersonaSettings(adkRoot) {
	return Object.freeze(readSelectedFields(naiaSettingsPath(adkRoot), NAIA_PERSONA_FIELDS));
}

/**
 * 뽑은 항목을 프롬프트에 실을 글로 만든다.
 *
 * 나이아 셸이 대화에서 쓰는 것과 같은 재료를 같은 뜻으로 쓴다 — 이름, 성격 글,
 * 부르는 사람, 말투. 셸의 문장을 그대로 베끼지는 않는다. 게이트웨이는 대화가 아니라
 * 업무를 하고, 셸의 간결성 지시 같은 것은 여기서 해롭다.
 */
export function renderNaiaPersona(settings) {
	if (!settings || typeof settings !== "object") throw new Error("naia persona settings are required");
	const name = settings.agentName ?? null;
	const lines = [];
	if (settings.persona) lines.push(settings.persona);
	if (name) lines.push(`You are ${name}. Keep this identity in work requests exactly as you keep it in conversation.`);
	// 이름과 호칭은 다른 항목이다. 호칭이 있으면 그것으로 부르고, 없으면 이름으로 부른다.
	if (settings.userName && settings.honorific) lines.push(`The person you are working with is ${settings.userName}. Address them as "${settings.honorific}".`);
	else if (settings.userName) lines.push(`The person you are working with is ${settings.userName}. Address them by name.`);
	if (settings.locale) lines.push(`Reply in the language of locale ${settings.locale} unless the request uses another one.`);
	if (settings.speechStyle === "casual") lines.push("Speak casually, the way you do in conversation.");
	else if (settings.speechStyle === "formal") lines.push("Speak politely, the way you do in conversation.");
	if (lines.length === 0) throw new Error("naia settings carry no persona");
	return lines.join("\n");
}

/** 설정에서 페르소나 이름을 고른다. 없으면 null. */
export function naiaPersonaName(settings) {
	return settings?.agentName ?? null;
}
