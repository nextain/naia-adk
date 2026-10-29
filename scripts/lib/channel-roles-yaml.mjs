/**
 * Naia ADK v0.2.0 — Zero-dependency YAML Parser & Markdown Renderer for Channel-Role Tables
 */

const ROLE_DISPLAY_NAMES = {
  coordinator: '조정 담당',
  ops: '운영 담당',
  reviewer: '검토 담당',
  assistant: '보조 담당',
};

export function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

export function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) {
    if (s.length >= 15) return s;
    return Number(s);
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function parseYamlValue(raw) {
  const s = raw.trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => parseYamlScalar(item));
  }
  if (s === '{}') return {};
  return parseYamlScalar(s);
}

function splitKeyValue(text) {
  const idx = text.indexOf(':');
  if (idx < 0) return null;
  const key = text.slice(0, idx).trim();
  const rest = text.slice(idx + 1).trim();
  return { key, rest };
}

/**
 * Parses a channels.yaml document (or JSON equivalent) into a normalized JavaScript object.
 */
export function parseChannelsYaml(rawText, sourceLabel = 'channels.yaml') {
  const trimmed = String(rawText || '').trim();
  if (!trimmed) {
    throw new Error(`${sourceLabel}: 빈 파일입니다`);
  }
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  const lines = String(rawText)
    .split(/\r?\n/)
    .map((raw, idx) => ({
      lineNo: idx + 1,
      cleaned: stripYamlComment(raw),
    }))
    .filter((l) => l.cleaned.trim().length > 0);

  const root = {};
  let section = null; // 'roles' | 'servers' | null
  let currentServer = null;
  let inChannels = false;
  let currentChannel = null;
  let inChannelListProp = null;

  for (const { lineNo, cleaned } of lines) {
    const indent = cleaned.match(/^(\s*)/)[1].length;
    const content = cleaned.trim();

    if (indent === 0) {
      inChannels = false;
      currentServer = null;
      currentChannel = null;
      inChannelListProp = null;
      const kv = splitKeyValue(content);
      if (!kv) throw new Error(`${sourceLabel}:${lineNo}: 잘못된 최상위 구문 "${content}"`);
      if (kv.rest === '') {
        section = kv.key;
        root[kv.key] = [];
      } else {
        section = null;
        root[kv.key] = parseYamlValue(kv.rest);
      }
      continue;
    }

    if (section === 'roles' && content.startsWith('-')) {
      const val = content.slice(1).trim();
      root.roles.push(parseYamlScalar(val));
      continue;
    }

    if (section === 'servers') {
      // Server item start (e.g. "  - key: internal")
      if (indent <= 2 && content.startsWith('-')) {
        const afterDash = content.slice(1).trim();
        inChannels = false;
        currentServer = {};
        currentChannel = null;
        inChannelListProp = null;
        root.servers.push(currentServer);
        if (afterDash) {
          const kv = splitKeyValue(afterDash);
          if (!kv) throw new Error(`${sourceLabel}:${lineNo}: 잘못된 서버 항목 "${content}"`);
          currentServer[kv.key] = kv.rest === '' ? [] : parseYamlValue(kv.rest);
        }
        continue;
      }

      if (!currentServer) {
        throw new Error(`${sourceLabel}:${lineNo}: 서버 항목 밖의 들여쓰기 구문 "${content}"`);
      }

      // Server property (e.g. "    channels:" or "    channels: []")
      if (!content.startsWith('-') && (!inChannels || indent <= 4)) {
        const kv = splitKeyValue(content);
        if (kv && (kv.key === 'channels' || !currentChannel)) {
          currentChannel = null;
          inChannelListProp = null;
          if (kv.key === 'channels') {
            inChannels = true;
            currentServer.channels = kv.rest === '' ? [] : parseYamlValue(kv.rest);
          } else {
            currentServer[kv.key] = kv.rest === '' ? null : parseYamlValue(kv.rest);
          }
          continue;
        }
      }

      // Inside channels list
      if (inChannels) {
        if (content.startsWith('-')) {
          const afterDash = content.slice(1).trim();
          const kv = splitKeyValue(afterDash);
          if (kv) {
            currentChannel = {};
            inChannelListProp = null;
            if (!Array.isArray(currentServer.channels)) currentServer.channels = [];
            currentServer.channels.push(currentChannel);
            currentChannel[kv.key] = kv.rest === '' ? [] : parseYamlValue(kv.rest);
          } else if (currentChannel && inChannelListProp) {
            currentChannel[inChannelListProp].push(parseYamlScalar(afterDash));
          } else {
            throw new Error(`${sourceLabel}:${lineNo}: 잘못된 채널 목록 항목 "${content}"`);
          }
          continue;
        }

        if (currentChannel) {
          const kv = splitKeyValue(content);
          if (!kv) throw new Error(`${sourceLabel}:${lineNo}: 잘못된 채널 속성 "${content}"`);
          if (kv.rest === '') {
            inChannelListProp = kv.key;
            currentChannel[kv.key] = [];
          } else {
            inChannelListProp = null;
            currentChannel[kv.key] = parseYamlValue(kv.rest);
          }
          continue;
        }
      }
    }

    throw new Error(`${sourceLabel}:${lineNo}: 해석할 수 없는 구문 "${content}"`);
  }

  return root;
}

function formatRoleName(role) {
  return ROLE_DISPLAY_NAMES[role] || role;
}

export function renderChannelsMarkdown({ resolvedCompanies, skippedServers }) {
  const lines = [
    '# 사내 메신저 채널과 깨움 (자동 생성)',
    '',
    '> 이 문서는 `channel-roles-gen.mjs`가 `channels.yaml` 및 `channel-ids.json`으로부터 결정론적으로 생성했습니다.',
    '',
    '## 1. 채널 목록과 담당',
    '',
    '| 회사 | 서버 | 채널 | 채널 번호 | 함께 부른 역할(깨움 대상) | 주 담당 | 다른 채널 사람이 이름으로 부르기 | 상태 |',
    '|---|---|---|---|---|---|---|---|',
  ];

  const descriptions = [];

  for (const comp of resolvedCompanies) {
    for (const srv of comp.servers) {
      if (srv.skipped) continue;
      for (const ch of srv.channels) {
        const wakeText = ch.wakeRoles.map(formatRoleName).join('·');
        const primaryText = formatRoleName(ch.primaryRole);
        const outsideText = ch.outsideCall === 'mention' ? '안 됨(봇 언급만)' : '됨';
        const statusText = ch.archived ? '보관(읽기 전용)' : '활성';
        lines.push(
          `| ${comp.company} | ${srv.key} (\`${srv.guildId}\`) | ${ch.name} | ${ch.channelId} | ${wakeText} | ${primaryText} | ${outsideText} | ${statusText} |`,
        );
        if (ch.description) {
          descriptions.push(`- **${ch.name}** (\`${ch.channelId}\`): ${ch.description}`);
        }
      }
    }
  }

  if (skippedServers.length > 0) {
    lines.push('');
    lines.push('### 미생성 서버 (건너뜀 — `guildId: null`)');
    for (const s of skippedServers) {
      lines.push(`- \`${s.company}/${s.serverKey}\`: guildId가 \`null\`이므로 건너뛰었습니다.`);
    }
  }

  lines.push('');
  lines.push('## 2. 채널 설명 문구');
  lines.push('');
  if (descriptions.length === 0) {
    lines.push('- (등록된 채널 설명 문구 없음)');
  } else {
    lines.push(...descriptions);
  }
  lines.push('');

  return lines.join('\n');
}
