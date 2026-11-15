import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_REVIEW_CAP_CONFIG = Object.freeze({
    cap: 2,
    fixPattern: /fix\d/,
    revPattern: /rev\d/,
    briefPattern: /^brief-(.+)\.md$/,
    resultFile: round => `result-${round}.md`,
    failPattern: /^판정: FAIL/,
});

function matches(pattern, value) {
    if (typeof pattern === 'function')
        return Boolean(pattern(value));
    if (pattern instanceof RegExp)
        return pattern.test(value);
    if (typeof pattern === 'string')
        return new RegExp(pattern).test(value);
    return false;
}

export function readHeader(text, key) {
    if (typeof text !== 'string' || !text)
        return '';
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^${escaped}:[ \\t]*(.*?)[ \\t\\r]*$`, 'm').exec(text);
    if (match)
        return match[1].trim();
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            const val = parsed[key] ?? parsed[key.replace(/-/g, '_')];
            if (typeof val === 'string')
                return val.trim();
        }
    }
    catch { /* ordinary markdown/text instruction */ }
    return '';
}

export function parseReviewHeaders(text) {
    return {
        lane: readHeader(text, 'review-lane'),
        reset: readHeader(text, 'review-cap-reset'),
    };
}

export function extractRoundName(instructionPath, id = '', config = {}) {
    const briefPattern = config.briefPattern ?? DEFAULT_REVIEW_CAP_CONFIG.briefPattern;
    if (instructionPath) {
        const base = path.basename(String(instructionPath));
        if (typeof briefPattern === 'function') {
            const extracted = briefPattern(base);
            if (extracted)
                return String(extracted);
        }
        else if (briefPattern instanceof RegExp) {
            const match = briefPattern.exec(base);
            if (match?.[1])
                return match[1];
        }
        const stem = path.basename(base, path.extname(base));
        if (stem && stem !== 'brief' && stem !== 'instruction')
            return stem;
    }
    return String(id || '');
}

export function classifyRound(round, config = {}) {
    const name = String(round || '');
    const fixPattern = config.fixPattern ?? DEFAULT_REVIEW_CAP_CONFIG.fixPattern;
    const revPattern = config.revPattern ?? config.reviewPattern ?? DEFAULT_REVIEW_CAP_CONFIG.revPattern;
    const isRev = matches(revPattern, name);
    const hasFix = matches(fixPattern, name);
    const isFix = hasFix && !isRev;
    const isLoop = config.loopPattern != null ? matches(config.loopPattern, name) : (hasFix || isRev);
    return { round: name, isFix, isRev, isReview: isRev, isLoop };
}

export function resolveResultFile(round, dir = '', config = {}) {
    const spec = config.resultFile ?? config.resultPattern ?? config.resultName ?? DEFAULT_REVIEW_CAP_CONFIG.resultFile;
    const name = typeof spec === 'function'
        ? spec(round, dir)
        : String(spec).replace(/\{round\}|%s/g, String(round));
    return dir ? path.resolve(dir, name) : name;
}

export function firstLine(text) {
    if (typeof text !== 'string' || !text)
        return '';
    const newline = text.indexOf('\n');
    const line = newline === -1 ? text : text.slice(0, newline);
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export function isFailVerdict(text, config = {}) {
    const line = firstLine(text);
    const failPattern = config.failPattern ?? config.verdictPattern ?? DEFAULT_REVIEW_CAP_CONFIG.failPattern;
    if (typeof failPattern === 'string')
        return line.startsWith(failPattern);
    return matches(failPattern, line);
}

export function formatWakeNote({ lane, count, fails, message }) {
    return `[검수 상한] 갈래 ${lane}: 코드 검수 FAIL ${count}번(${fails.join(' ')}). ${message}\n` +
        '하네스북 10.15·10.16: 같은 방식으로 다시 고치지 말고 반례를 먼저 시험으로 고정하거나 설계·범위를 바꾼 뒤, 다음 고침 지시서에 review-cap-reset: <바꾼 방식> 를 적고 띄울 것.\n';
}

export function evaluateReviewCap({ mode = 'check', round = '', lane = '', reset = '', entries = [], cap, config = {} } = {}) {
    const limit = Number(cap ?? config.cap ?? DEFAULT_REVIEW_CAP_CONFIG.cap);
    if (!Number.isInteger(limit) || limit < 1)
        throw Error(`Invalid review cap: ${cap ?? config.cap}`);
    const { isFix, isRev, isLoop } = classifyRound(round, config);
    const trimmedLane = String(lane || '').trim();
    const trimmedReset = String(reset || '').trim();
    if (!trimmedLane) {
        if (mode === 'check' && isLoop) {
            return {
                allowed: false,
                blocked: true,
                exitCode: 3,
                round,
                lane: '',
                reset: trimmedReset,
                isFix,
                isRev,
                isLoop,
                since: 0,
                fails: [],
                count: 0,
                cap: limit,
                reason: `review-cap: ${round} 는 고침·검수 회차인데 지시서에 'review-lane:' 줄이 없음 — 갈래를 적어야 띄움`,
                wakeMessage: null,
                wakeNote: null,
            };
        }
        return {
            allowed: true,
            blocked: false,
            exitCode: 0,
            round,
            lane: '',
            reset: trimmedReset,
            isFix,
            isRev,
            isLoop,
            since: 0,
            fails: [],
            count: 0,
            cap: limit,
            reason: null,
            wakeMessage: null,
            wakeNote: null,
        };
    }
    let since = 0;
    for (const entry of entries) {
        if (entry.isSelf || entry.round === round)
            continue;
        if (String(entry.lane || '').trim() !== trimmedLane)
            continue;
        if (!String(entry.reset || '').trim())
            continue;
        const mtime = Number(entry.briefMtimeMs ?? entry.briefMtime ?? 0);
        if (mtime > since)
            since = mtime;
    }
    const fails = [];
    for (const entry of entries) {
        if (String(entry.lane || '').trim() !== trimmedLane)
            continue;
        if (!entry.hasResult)
            continue;
        const resMtime = Number(entry.resultMtimeMs ?? entry.resultMtime ?? 0);
        if (!(resMtime > since))
            continue;
        const failed = typeof entry.failed === 'boolean'
            ? entry.failed
            : isFailVerdict(entry.resultText ?? entry.resultFirstLine ?? '', config);
        if (failed)
            fails.push(entry.round);
    }
    const count = fails.length;
    if (mode === 'check') {
        if (isRev) {
            return {
                allowed: true,
                blocked: false,
                exitCode: 0,
                round,
                lane: trimmedLane,
                reset: trimmedReset,
                isFix,
                isRev,
                isLoop,
                since,
                fails,
                count,
                cap: limit,
                reason: null,
                wakeMessage: null,
                wakeNote: null,
            };
        }
        if (count >= limit) {
            if (!trimmedReset) {
                const wakeMessage = `고침 ${round} 띄우기를 막음.`;
                const wakeNote = formatWakeNote({ lane: trimmedLane, count, fails, message: wakeMessage });
                return {
                    allowed: false,
                    blocked: true,
                    exitCode: 3,
                    round,
                    lane: trimmedLane,
                    reset: '',
                    isFix,
                    isRev,
                    isLoop,
                    since,
                    fails,
                    count,
                    cap: limit,
                    reason: `review-cap: 갈래 ${trimmedLane} 코드 검수 FAIL ${count}번(${fails.join(' ')}) — ${round} 를 막음. 방식을 바꾸고 review-cap-reset: 줄을 적을 것`,
                    wakeMessage,
                    wakeNote,
                };
            }
            return {
                allowed: true,
                blocked: false,
                exitCode: 0,
                round,
                lane: trimmedLane,
                reset: trimmedReset,
                resetUsed: true,
                notice: `review-cap: 갈래 ${trimmedLane} FAIL ${count}번 뒤 방식 바꿈으로 띄움: ${trimmedReset}`,
                isFix,
                isRev,
                isLoop,
                since,
                fails,
                count,
                cap: limit,
                reason: null,
                wakeMessage: null,
                wakeNote: null,
            };
        }
        return {
            allowed: true,
            blocked: false,
            exitCode: 0,
            round,
            lane: trimmedLane,
            reset: trimmedReset,
            isFix,
            isRev,
            isLoop,
            since,
            fails,
            count,
            cap: limit,
            reason: null,
            wakeMessage: null,
            wakeNote: null,
        };
    }
    if (mode === 'after') {
        if (isRev && count >= limit) {
            const wakeMessage = `검수 ${round} 가 FAIL 로 끝남, 다음 고침은 막힘.`;
            const wakeNote = formatWakeNote({ lane: trimmedLane, count, fails, message: wakeMessage });
            return {
                allowed: true,
                blocked: false,
                exitCode: 0,
                round,
                lane: trimmedLane,
                reset: trimmedReset,
                isFix,
                isRev,
                isLoop,
                since,
                fails,
                count,
                cap: limit,
                reason: null,
                wakeMessage,
                wakeNote,
            };
        }
        return {
            allowed: true,
            blocked: false,
            exitCode: 0,
            round,
            lane: trimmedLane,
            reset: trimmedReset,
            isFix,
            isRev,
            isLoop,
            since,
            fails,
            count,
            cap: limit,
            reason: null,
            wakeMessage: null,
            wakeNote: null,
        };
    }
    throw Error(`Invalid review-cap mode: ${mode}`);
}

export function scanRoundEntries(dir, selfInstructionPath = '', selfRound = '', config = {}, io = fs) {
    const briefPattern = config.briefPattern ?? DEFAULT_REVIEW_CAP_CONFIG.briefPattern;
    const resolvedDir = path.resolve(dir);
    const resolvedSelf = selfInstructionPath ? path.resolve(selfInstructionPath) : '';
    let names = [];
    try {
        names = io.readdirSync(resolvedDir).slice().sort();
    }
    catch {
        return [];
    }
    const entries = [];
    for (const name of names) {
        let entryRound = null;
        if (typeof briefPattern === 'function') {
            entryRound = briefPattern(name);
        }
        else if (briefPattern instanceof RegExp) {
            const match = briefPattern.exec(name);
            entryRound = match?.[1] ?? null;
        }
        if (!entryRound)
            continue;
        const briefPath = path.join(resolvedDir, name);
        let briefText = '', briefMtimeMs = 0;
        try {
            briefText = io.readFileSync(briefPath, 'utf8');
            briefMtimeMs = io.statSync(briefPath).mtimeMs;
        }
        catch {
            continue;
        }
        const { lane, reset } = parseReviewHeaders(briefText);
        const resultPath = resolveResultFile(entryRound, resolvedDir, config);
        let hasResult = false, resultMtimeMs = 0, resultFirstLine = '';
        try {
            const stat = io.statSync(resultPath);
            if (stat.isFile()) {
                hasResult = true;
                resultMtimeMs = stat.mtimeMs;
                resultFirstLine = firstLine(io.readFileSync(resultPath, 'utf8'));
            }
        }
        catch { /* absent result file is ignored */ }
        entries.push({
            round: entryRound,
            briefPath,
            isSelf: (resolvedSelf && path.resolve(briefPath) === resolvedSelf) || (Boolean(selfRound) && entryRound === selfRound),
            lane,
            reset,
            briefMtimeMs,
            hasResult,
            resultMtimeMs,
            resultFirstLine,
            failed: hasResult ? isFailVerdict(resultFirstLine, config) : false,
        });
    }
    return entries;
}

export function writeWakeNote(wakeDir, lane, wakeNote, now = new Date(), io = fs) {
    if (!wakeDir || !wakeNote)
        return null;
    const resolvedDir = path.resolve(wakeDir);
    io.mkdirSync(resolvedDir, { recursive: true });
    const date = now instanceof Date ? now : new Date(now);
    const stamp = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const safeLane = String(lane || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const wakeFile = path.join(resolvedDir, `${stamp}-review-cap-${safeLane}.md`);
    io.writeFileSync(wakeFile, wakeNote, 'utf8');
    return wakeFile;
}

export function runReviewCap(mode, options = {}, io = fs) {
    const config = options.config || options;
    const instructionPath = options.instruction ? path.resolve(options.instruction) : (options.dir && options.round ? path.join(path.resolve(options.dir), `brief-${options.round}.md`) : '');
    const dir = options.dir ? path.resolve(options.dir) : (instructionPath ? path.dirname(instructionPath) : '');
    const round = options.round || extractRoundName(instructionPath, options.id, config);
    let text = options.instructionText ?? '';
    if (!text && instructionPath) {
        try {
            text = io.readFileSync(instructionPath, 'utf8');
        }
        catch {
            text = '';
        }
    }
    const { lane, reset } = parseReviewHeaders(text);
    const entries = Array.isArray(options.entries)
        ? options.entries
        : (dir ? scanRoundEntries(dir, instructionPath, round, config, io) : []);
    const cap = options.cap ?? (process.env.REVIEW_CAP ? Number(process.env.REVIEW_CAP) : config.cap ?? DEFAULT_REVIEW_CAP_CONFIG.cap);
    const result = evaluateReviewCap({ mode, round, lane, reset, entries, cap, config });
    const wakeDir = options.wakeDir !== undefined ? options.wakeDir : (process.env.REVIEW_CAP_WAKE_DIR || '');
    const wakeFile = (result.wakeNote && wakeDir) ? writeWakeNote(wakeDir, result.lane, result.wakeNote, options.now, io) : null;
    return { ...result, wakeFile };
}

export const checkReviewCap = (options, io) => runReviewCap('check', options, io);
export const afterReviewCap = (options, io) => runReviewCap('after', options, io);
