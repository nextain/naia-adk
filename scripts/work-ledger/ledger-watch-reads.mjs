export function createMessengerReads({config,sleep,state,errors,warnings,wake,safeIdPart,readCache,failedThisRound}) {
    let readStarted = false;
    let retryWaitMs = 0;
    async function readMessages(messenger, channel, since) {
      const key = `messages:${channel}`;
      if (!readCache.has(key))
        readCache.set(key, readWithRetry(() => messenger.messages(channel, since)));
      return readCache.get(key);
    }
    async function readReply(messenger, channel, id) {
      if (!messenger.replyReference) return null;
      const key = `reply:${JSON.stringify([channel, id])}`;
      if (!readCache.has(key)) {
        readCache.set(key, readWithRetry(() => messenger.replyReference(channel, id)).catch(error => {
          if (error.status === 403 || error.status === 404) return null;
          throw error;
        }));
      }
      return readCache.get(key);
    }
    async function readWithRetry(read) {
      const interval = config.channel_read_interval_ms ?? 300;
      if (readStarted && interval > 0) await sleep(interval);
      readStarted = true;
      try {
        return await read();
      } catch (error) {
        const limited = error.status === 429 || /HTTP 429/.test(error.message || "");
        if (!limited || error.retry_exhausted) throw error;
        const seconds = Number(error.retry_after ?? 1);
        const delay = (Number.isFinite(seconds) && seconds >= 0 ? seconds : 1) * 1000;
        if (delay > 5000 || retryWaitMs + delay > 30000) throw error;
        retryWaitMs += delay;
        await sleep(delay);
        return read();
      }
    }
    async function channelFailure(role, channel, error, suffix = "") {
      if (!(error.status === 429 || /HTTP 429/.test(error.message || ""))) {
        if (!failedThisRound.has(channel)) delete state.channel_failures[channel];
        errors.push(`messenger:${role}:${channel}${suffix}`);
        await wake(
          role, `messenger-error-${safeIdPart(channel)}${suffix ? "-threads" : ""}`,
          "감시 실패", "메신저 읽기 실패",
          `채널: ${channel}\n오류: ${error.message || String(error)}`,
        );
        return;
      }
      if (!failedThisRound.has(channel)) {
        state.channel_failures[channel] = (state.channel_failures[channel] || 0) + 1;
        failedThisRound.add(channel);
      }
      warnings.push(`messenger:${role}:${channel}: ${error.message || String(error)}`);
      if (state.channel_failures[channel] >= 3)
        await wake(
          role, `messenger-error-${safeIdPart(channel)}`,
          "감시 실패", "메신저 읽기 연속 실패",
          `채널: ${channel}\n연속 실패: ${state.channel_failures[channel]}회\n오류: ${error.message || String(error)}`,
        );
    }
    return {readMessages,readReply,readWithRetry,channelFailure};
}
