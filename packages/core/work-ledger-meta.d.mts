export interface WorkLedgerRoleReportConfig {
  every_min?: number;
  channel?: string;
}

export interface WorkLedgerRoleConfig {
  role: string;
  wake_dir?: string;
  guild_id?: string;
  guildId?: string;
  direct_channels?: string[];
  channels?: string[];
  report?: WorkLedgerRoleReportConfig;
}

export interface WorkLedgerConfig {
  version?: number;
  ledger_root?: string;
  ledger_dir?: string;
  guild_id?: string;
  guildId?: string;
  defaults?: {
    guild_id?: string;
    guildId?: string;
  };
  provider?: {
    type?: string;
    token_env?: string;
    guild_id?: string;
    guildId?: string;
  };
  roles: WorkLedgerRoleConfig[];
}

export interface WorkLedgerMeta {
  root: string;
  dir: string;
  config: WorkLedgerConfig | null;
}

export interface WorkLedgerLocationResult {
  configured: boolean;
  available: boolean;
  root: string | null;
  dir: string | null;
  configPath: string | null;
  config: WorkLedgerConfig | null;
  guildId: string | null;
  error: string | null;
}

export function safeLedgerName(value: string): string;
export function ledgerFilePath(root: string, role: string): string;
export function validateWorkLedgerConfig(raw: unknown): WorkLedgerConfig;
export function readWorkLedgerMeta(config: {
  workLedgerConfig?: string;
  workLedgerRoot?: string;
  workLedgerDir?: string;
}): Promise<WorkLedgerMeta | null>;
export function resolveWorkLedgerLocation(
  adkRoot: string,
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<WorkLedgerLocationResult>;
