import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const activeAttempts = new WeakMap();

export function verifiedActiveMention(proof, role, profile, key, text, transport) {
  const binding = activeAttempts.get(proof);
  return binding && binding.role === role && binding.pane === profile.pane_id && binding.thread === profile.session?.thread_id &&
    binding.key === key && binding.payload === sha(text) && binding.transport === transport;
}

// The Gateway writes this proof before making its wake visible. The exclusive
// writer of the separately registered directory is the authenticated Gateway.
export function gatewayMention(role, message, body) {
  if (!snowflake(message.guild_id) || !snowflake(message.author?.id) || message.author.bot || message.author.system ||
      message.webhook_id || !message.mentions?.some(user => user.id === role.botUserId) ||
      !new RegExp(`<@!?${role.botUserId}>`).test(message.content ?? '')) return null;
  return { schema: 'discord-human-mention/v1', role: role.id, bot: role.botUserId, author: message.author.id,
    guild: message.guild_id, channel: message.channel_id, message: message.id, wake_sha256: sha(body) };
}

export function originFile(directory, role, message) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !/^[A-Za-z0-9_-]+$/.test(role) || !snowflake(message)) throw new Error('invalid Gateway origin path');
  return path.join(directory, role, message + '.json');
}

export function activeMentionPolicy(value) {
  if (!value || !path.isAbsolute(value.origin_dir ?? '')) throw new Error('active_mentions needs an absolute origin_dir');
  if (value.excluded_channels !== undefined && (!Array.isArray(value.excluded_channels) ||
      !value.excluded_channels.every(snowflake))) throw new Error('active_mentions.excluded_channels must contain channel ids');
  if (value.format_command !== undefined && (!Array.isArray(value.format_command) || !value.format_command.length ||
      !value.format_command.every(part => typeof part === 'string' && part) || !path.isAbsolute(value.format_command[0]))) throw new Error('active_mentions.format_command must name an absolute trusted formatter');
  return value;
}

// A Markdown filename, mention-looking text, or priority environment value can
// only suggest a lookup. None of them establishes authorship or the target.
export function readGatewayMention(policy, role, bot, authors, message) {
  if (!policy || !snowflake(bot) || !snowflake(message)) return null;
  try {
    const file = originFile(policy.origin_dir, role, message);
    const stat = fs.lstatSync(file), directory = fs.statSync(path.dirname(file)), root = fs.statSync(policy.origin_dir);
    if (fs.realpathSync(file) !== file || !stat.isFile() || (stat.mode & 0o022) || (directory.mode & 0o022) ||
        (root.mode & 0o022) || stat.uid !== directory.uid || stat.uid !== root.uid) return null;
    const proof = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (proof.schema === 'discord-human-mention/v1' && proof.role === role && proof.bot === bot && proof.message === message &&
        /^[a-f0-9]{64}$/.test(proof.wake_sha256) && snowflake(proof.guild) && snowflake(proof.channel) && snowflake(proof.author) &&
        authors.includes(proof.author) && !policy.excluded_channels?.includes(proof.channel)) return proof;
  } catch { /* Missing or unreadable trusted origin leaves the ordinary delivery in place. */ }
  return null;
}

export function activeDispatch(registry, role, profile, key, text, transportSha256, sourceFile = null) {
  if (!profile.active_mentions || !/^[A-Za-z0-9_-]+$/.test(role) || !key || !transportSha256) return null;
  try {
    const policy = activeMentionPolicy(profile.active_mentions);
    const directory = policy.dispatcher_state_dir ?? registry.state_dir;
    if (!path.isAbsolute(directory)) return null;
    const file = path.join(directory, 'submissions', role + '.json');
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) return null;
    const attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (attempt.attempt !== key || attempt.role !== role || attempt.pane !== profile.pane_id || attempt.sha256 !== transportSha256 || attempt.gateway_only !== true) return null;
    const proof = readGatewayMention(policy, role, profile.bot_id, registry.delivery?.priority_user_ids ?? [],
      attempt.messageId);
    if (!proof || proof.wake_sha256 !== attempt.gateway_wake_sha256) return null;
    const grant = () => {
      activeAttempts.set(proof, { role, pane: profile.pane_id, thread: profile.session?.thread_id, key, payload: sha(text), transport: transportSha256 });
      return proof;
    };
    if (sha(text) === transportSha256) return grant();
    if (!policy.format_command || !sourceFile || fs.realpathSync(sourceFile) !== sourceFile ||
        path.dirname(sourceFile) !== path.join(directory, 'spool', role) || !fs.lstatSync(sourceFile).isFile()) return null;
    const original = fs.readFileSync(sourceFile);
    if (sha(original) !== transportSha256) return null;
    const [bin, ...args] = policy.format_command;
    const rendered = execFileSync(bin, args.map(arg => arg.replaceAll('{role}', role)), { input: original, timeout: 3000,
      maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    return sha(rendered) === sha(text) ? grant() : null;
  } catch { return null; }
}
