const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// Message content is still delivered for DMs and messages that mention the bot.
// Those are the only accepted scopes, so a privileged MESSAGE_CONTENT intent is
// unnecessary and would make a fresh bot fail with Gateway close code 4014.
const DISCORD_INTENTS = 1 | 512 | 4_096;

function safeGatewayUrl(value) {
	const url = new URL(value ?? DEFAULT_GATEWAY_URL);
	if (url.protocol !== "wss:" || !/(^|\.)discord\.gg$/.test(url.hostname)) throw new Error("unsafe Discord Gateway URL");
	url.searchParams.set("v", "10");
	url.searchParams.set("encoding", "json");
	return url.toString();
}

export class DiscordGatewaySession {
	constructor({ token, stateRepository, onDispatch, onDisconnect = () => {}, webSocketFactory = (url) => new WebSocket(url), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, random = Math.random, now = () => new Date().toISOString() }) {
		if (typeof token !== "string" || token.length < 16) throw new Error("Discord credential is not ready");
		this.token = token;
		this.stateRepository = stateRepository;
		this.onDispatch = onDispatch;
		this.onDisconnect = onDisconnect;
		this.webSocketFactory = webSocketFactory;
		this.setIntervalImpl = setIntervalImpl;
		this.clearIntervalImpl = clearIntervalImpl;
		this.setTimeoutImpl = setTimeoutImpl;
		this.clearTimeoutImpl = clearTimeoutImpl;
		this.random = random;
		this.now = now;
		this.sequence = null;
		this.heartbeatTimer = null;
		this.lastHeartbeatAckAt = null;
		this.awaitingHeartbeatAck = false;
		this.dispatchChain = Promise.resolve();
	}

	connect() {
		const prior = this.stateRepository.load() ?? {};
		this.sequence = Number.isSafeInteger(prior.sequence) ? prior.sequence : null;
		this.awaitingHeartbeatAck = false;
		const url = safeGatewayUrl(prior.resumeUrl ?? DEFAULT_GATEWAY_URL);
		this.socket = this.webSocketFactory(url);
		this.socket.addEventListener("message", (event) => {
			this.dispatchChain = this.dispatchChain.then(() => this.#receive(event.data)).catch(() => this.close(4_002));
		});
		this.socket.addEventListener("close", (event) => {
			this.#stopHeartbeat();
			this.onDisconnect({ code: event?.code ?? null, resumable: !new Set([4_004, 4_010, 4_011, 4_012, 4_013, 4_014]).has(event?.code) });
		});
		return this.socket;
	}

	close(code = 1_000) {
		this.#stopHeartbeat();
		this.socket?.close(code);
	}

	drain() {
		return this.dispatchChain;
	}

	#send(payload) {
		this.socket.send(JSON.stringify(payload));
	}

	async #receive(raw) {
		let payload;
		try { payload = JSON.parse(raw); } catch { this.close(4_002); return; }
		const dispatchSequence = Number.isSafeInteger(payload.s) ? payload.s : null;
		if (payload.op === 10) this.#hello(payload.d);
		else if (payload.op === 11) {
			this.awaitingHeartbeatAck = false;
			this.lastHeartbeatAckAt = this.now();
			this.stateRepository.save({ heartbeatAckAt: this.lastHeartbeatAckAt });
		} else if (payload.op === 1) this.#heartbeat();
		else if (payload.op === 7) this.close(4_000);
		else if (payload.op === 9) {
			if (payload.d === false) this.stateRepository.clearResume();
			this.close(4_000);
		} else if (payload.op === 0) {
			await this.#dispatch(payload.t, payload.d, dispatchSequence);
			if (dispatchSequence !== null) {
				this.sequence = dispatchSequence;
				this.stateRepository.save({ sequence: this.sequence });
			}
		} else if (dispatchSequence !== null) {
			this.sequence = dispatchSequence;
			this.stateRepository.save({ sequence: this.sequence });
		}
	}

	#hello(data) {
		if (!Number.isSafeInteger(data?.heartbeat_interval) || data.heartbeat_interval < 1_000) throw new Error("invalid Discord heartbeat interval");
		this.#stopHeartbeat();
		const startHeartbeat = () => {
			this.#heartbeat();
			this.heartbeatTimer = this.setIntervalImpl(() => this.#heartbeat(), data.heartbeat_interval);
			this.heartbeatTimer?.unref?.();
		};
		this.heartbeatInitialTimer = this.setTimeoutImpl(startHeartbeat, Math.floor(this.random() * data.heartbeat_interval));
		this.heartbeatInitialTimer?.unref?.();
		const prior = this.stateRepository.load() ?? {};
		if (prior.sessionId && Number.isSafeInteger(prior.sequence)) {
			this.#send({ op: 6, d: { token: this.token, session_id: prior.sessionId, seq: prior.sequence } });
		} else {
			this.#send({ op: 2, d: { token: this.token, intents: DISCORD_INTENTS, properties: { os: process.platform, browser: "naia-adk", device: "naia-adk" } } });
		}
	}

	#heartbeat() {
		if (this.awaitingHeartbeatAck) { this.close(4_000); return; }
		this.#send({ op: 1, d: this.sequence });
		this.awaitingHeartbeatAck = true;
	}

	async #dispatch(type, data, sequence) {
		if (type === "READY") this.stateRepository.save({ sessionId: data.session_id, resumeUrl: safeGatewayUrl(data.resume_gateway_url), sequence });
		await this.onDispatch?.(type, data, sequence);
	}

	#stopHeartbeat() {
		if (this.heartbeatTimer) this.clearIntervalImpl(this.heartbeatTimer);
		if (this.heartbeatInitialTimer) this.clearTimeoutImpl(this.heartbeatInitialTimer);
		this.heartbeatTimer = null;
		this.heartbeatInitialTimer = null;
		this.awaitingHeartbeatAck = false;
	}
}

export class MemoryGatewayState {
	constructor(initial = {}) { this.value = { ...initial }; }
	load() { return { ...this.value }; }
	save(patch) { this.value = { ...this.value, ...patch }; }
	clearResume() { this.value = { sequence: null, sessionId: null, resumeUrl: null, heartbeatAckAt: this.value.heartbeatAckAt ?? null }; }
}

export class StoredGatewayState {
	constructor(store) { this.store = store; }
	load() { return this.store.loadGatewayState(); }
	save(patch) { this.store.saveGatewayState(patch); }
	clearResume() { this.store.clearGatewayResume(); }
}
