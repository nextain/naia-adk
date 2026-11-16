"use strict";
/**
 * Time-window decisions — pure functions, no gate wiring.
 *
 *   mutationWindowStatus(window, now) — when an agent may change things
 *     { timezone: IANA name, days: [ISO weekday 1-7], start: "HH:mm", end: "HH:mm" }
 *   contactWindowStatus(schedule, now) — when a human may be contacted
 *     { timezone: "UTC" | IANA region, days: [1-7 | "mon".."sun"], start_hour, end_hour }
 *
 * Both windows are half-open: start is inside, end is outside. Overnight
 * windows are not supported (start must be before end). A result grants no
 * execution or transport authority; a gate decides what to do with it.
 * Invalid configuration or clock throws; there is no guessed default.
 */

const MUTATION_KEYS = new Set(["timezone", "days", "start", "end"]);
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_BY_NAME = new Map([
	["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7],
]);
const DAY_BY_NAME = new Map([
	["mon", 1], ["tue", 2], ["wed", 3], ["thu", 4], ["fri", 5], ["sat", 6], ["sun", 7],
]);
const CONTACT_KEYS = ["timezone", "days", "start_hour", "end_hour"];

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedNow(now) {
	const ms = now instanceof Date ? now.getTime() : now;
	if (typeof ms !== "number" || !Number.isFinite(ms)) throw new Error("time window clock must be a finite number or Date");
	return ms;
}

function assertTimezoneResolves(value, message) {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
	} catch {
		throw new Error(message);
	}
}

function localClock(timezone, ms) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(ms));
	const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
	const weekday = WEEKDAY_BY_NAME.get(values.weekday);
	if (!weekday) throw new Error("time window timezone did not produce a weekday");
	return { weekday, hour: Number(values.hour), minutes: Number(values.hour) * 60 + Number(values.minute) };
}

// ── mutation window ─────────────────────────────────────────────────────────

function timeMinutes(value, label) {
	if (typeof value !== "string" || !TIME_PATTERN.test(value)) throw new Error(`${label} must be HH:mm`);
	const [hour, minute] = value.split(":").map(Number);
	return hour * 60 + minute;
}

function mutationTimezone(value) {
	const message = "mutationWindow.timezone must be a valid IANA timezone";
	if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\0\r\n]/.test(value)) throw new Error(message);
	if (/^[+-]\d{2}(?::?\d{2})?$/.test(value)) throw new Error("mutationWindow.timezone must be a named IANA timezone");
	assertTimezoneResolves(value, message);
	return value;
}

/** Validate and canonicalize (days sorted). `undefined` means "no window configured". */
function normalizeMutationWindow(value) {
	if (value === undefined) return undefined;
	if (!isObject(value)) throw new Error("mutationWindow must be an object");
	for (const key of Object.keys(value)) {
		if (!MUTATION_KEYS.has(key)) throw new Error("mutationWindow contains an unsupported field");
	}
	const timezone = mutationTimezone(value.timezone);
	if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 7
		|| value.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
		throw new Error("mutationWindow.days must contain ISO weekdays 1-7");
	}
	if (new Set(value.days).size !== value.days.length) throw new Error("mutationWindow.days must be unique");
	const startMinutes = timeMinutes(value.start, "mutationWindow.start");
	const endMinutes = timeMinutes(value.end, "mutationWindow.end");
	if (startMinutes >= endMinutes) throw new Error("mutationWindow start must be before end; overnight windows are not supported");
	return { timezone, days: [...value.days].sort((a, b) => a - b), start: value.start, end: value.end };
}

function canonicalMutationWindow(value) {
	return normalizeMutationWindow(value) ?? null;
}

/**
 * @returns {{configured:boolean, allowed:boolean, reasonCode:string|null, window:object|null, local?:{weekday:number,minutes:number}}}
 * No window configured → allowed (nothing restricts mutation).
 */
function mutationWindowStatus(value, now = Date.now()) {
	const window = normalizeMutationWindow(value);
	if (window === undefined) return { configured: false, allowed: true, reasonCode: null, window: null };
	const local = localClock(window.timezone, checkedNow(now));
	const allowed = window.days.includes(local.weekday)
		&& local.minutes >= timeMinutes(window.start, "mutationWindow.start")
		&& local.minutes < timeMinutes(window.end, "mutationWindow.end");
	return {
		configured: true,
		allowed,
		reasonCode: allowed ? null : "mutation_window_closed",
		window,
		local: { weekday: local.weekday, minutes: local.minutes },
	};
}

// ── contact window ──────────────────────────────────────────────────────────

function contactDay(value, label) {
	const message = `${label} must be an integer day from 1 to 7 or a three-letter day name`;
	if (typeof value === "number") {
		if (Number.isInteger(value) && value >= 1 && value <= 7) return value;
		throw new Error(message);
	}
	if (typeof value !== "string" || value === "") throw new Error(message);
	const lower = value.toLowerCase();
	if (DAY_BY_NAME.has(lower)) return DAY_BY_NAME.get(lower);
	if (/^[1-7]$/.test(lower)) return Number(lower);
	throw new Error(message);
}

/** Validate and canonicalize a contact schedule (days become ISO numbers). */
function normalizeContactSchedule(schedule, label = "contact window") {
	if (!isObject(schedule)) throw new Error(`${label} must be an object`);
	for (const key of CONTACT_KEYS) {
		if (!(key in schedule)) throw new Error(`${label}.${key} is required`);
	}
	for (const key of Object.keys(schedule)) {
		if (!CONTACT_KEYS.includes(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
	}
	const { timezone } = schedule;
	// UTC is the only non-region spelling; a host-local timezone must not silently replace the schedule's.
	if (typeof timezone !== "string" || (timezone !== "UTC" && !/^[A-Za-z]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(timezone))) {
		throw new Error(`${label}.timezone must be UTC or an IANA region timezone`);
	}
	assertTimezoneResolves(timezone, `${label}.timezone must be a valid timezone`);
	if (!Array.isArray(schedule.days) || schedule.days.length === 0) throw new Error(`${label}.days must be a non-empty array`);
	const days = schedule.days.map((day, index) => contactDay(day, `${label}.days[${index}]`));
	if (new Set(days).size !== days.length) throw new Error(`${label}.days must not repeat a day`);
	for (const key of ["start_hour", "end_hour"]) {
		if (!Number.isInteger(schedule[key]) || schedule[key] < 0 || schedule[key] > 24) {
			throw new Error(`${label}.${key} must be an integer between 0 and 24`);
		}
	}
	if (schedule.end_hour <= schedule.start_hour) throw new Error(`${label}.end_hour must be after start_hour`);
	return { timezone, days, start_hour: schedule.start_hour, end_hour: schedule.end_hour };
}

/** @returns {{allowed:boolean, timezone:string, day:number, hour:number}} */
function contactWindowStatus(schedule, now = Date.now()) {
	const checked = normalizeContactSchedule(schedule);
	const local = localClock(checked.timezone, checkedNow(now));
	return {
		allowed: checked.days.includes(local.weekday) && local.hour >= checked.start_hour && local.hour < checked.end_hour,
		timezone: checked.timezone,
		day: local.weekday,
		hour: local.hour,
	};
}

module.exports = {
	normalizeMutationWindow,
	canonicalMutationWindow,
	mutationWindowStatus,
	normalizeContactSchedule,
	contactWindowStatus,
};
