import Database from 'better-sqlite3';
import { existsSync, copyFileSync } from 'fs';
import { createLogger } from '@ampere/shared/logger';
import { env } from '@ampere/shared/env';
import { type Migration, runMigrations } from '@ampere/shared/migrate';
import {
  type InstanceStatus as _InstanceStatus,
  INSTANCE_STATUS,
  PROVISIONING_STATUSES,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  statusSqlIn,
} from '@ampere/shared/instance-status';
import { toErrorMessage } from '@ampere/shared/errors';

const log = createLogger('orchestrator:db');

const DB_PATH = env.ORCHESTRATOR_DB_PATH;

let db: Database.Database;

export type ProvisionStage =
  | 'queued'
  | 'server_selected'
  | 'creating_container'
  | 'container_created'
  | 'openclaw_installed'
  | 'config_pushed'
  | 'gateway_started'
  | 'complete';
type ProvisioningStep = 'queued' | 'creating_container' | 'installing' | 'pushing_config' | 'starting_gateway';
export type InstanceStatus = _InstanceStatus;
export { INSTANCE_STATUS, PROVISIONING_STATUSES, ACTIVE_STATUSES, TERMINAL_STATUSES, statusSqlIn };

export const INTERMEDIATE_STATES = [...PROVISIONING_STATUSES];

export interface InstanceRow {
  id: string;
  user_email: string;
  user_id: string;
  telegram_bot_token: string;
  discord_bot_token: string;
  whatsapp_phone_number_id: string;
  whatsapp_access_token: string;
  signal_account: string;
  slack_bot_token: string;
  slack_app_token: string;
  internal_api_key: string;
  gateway_token: string;
  container_name: string;
  container_ip: string | null;
  server_id: string | null;
  plan: string;
  status: InstanceStatus;
  retry_count: number;
  provisioning_started_at: string | null;
  created_at: string;
  updated_at: string;
  error_message: string | null;
  provision_stage: ProvisionStage;
  device_auth_token: string | null;
  features: string; // JSON blob: { searxng?: 'installing' | 'installed' | 'error' }
  slept_at: string | null;
  actual_disk_mb: number | null;
  backup_url: string | null;
  backed_up_at: string | null;
  browser_server_token: string | null;
  user_meta: string;
  persona: string | null;
}

export function initDb(): Database.Database {
  // Backup DB before any migrations (Fix 2: prevent data loss)
  if (existsSync(DB_PATH)) {
    try {
      copyFileSync(DB_PATH, DB_PATH + '.bak');
    } catch (err: unknown) {
      log.debug('db.init_db_best_effort', { error: toErrorMessage(err) });
      /* best-effort */
    }
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Auto-heal: check integrity and rebuild indexes if corrupted
  // Index corruption (e.g. "wrong # of entries in index") is the most common
  // failure mode — caused by SIGKILL during active writes. REINDEX fixes it
  // without any data loss.
  try {
    const check = db.pragma('integrity_check') as { integrity_check: string }[];
    if (check[0]?.integrity_check !== 'ok') {
      const issues = check.map((r) => r.integrity_check).join('; ');
      log.warn('db.integrity_check', { issues: issues });
      log.warn('db.running', { msg: 'Running REINDEX to rebuild indexes...' });
      // Backup the corrupt DB for forensics
      try {
        copyFileSync(DB_PATH, DB_PATH + '.corrupt.bak');
      } catch (err: unknown) {
        /* best-effort */
      }
      db.exec('REINDEX');
      // Verify fix worked
      const recheck = db.pragma('integrity_check') as { integrity_check: string }[];
      if (recheck[0]?.integrity_check === 'ok') {
        log.info('db.reindex_successful', { msg: 'REINDEX successful — database recovered' });
      } else {
        log.error('db.reindex_partial', { integrityCheck: recheck[0]?.integrity_check });
      }
    }
  } catch (err: unknown) {
    log.error('db.integrity_check_failed', { error: toErrorMessage(err) });
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      user_id TEXT DEFAULT '',
      telegram_bot_token TEXT NOT NULL DEFAULT '',
      discord_bot_token TEXT NOT NULL DEFAULT '',
      internal_api_key TEXT NOT NULL,
      gateway_token TEXT NOT NULL DEFAULT '',
      container_name TEXT NOT NULL,
      container_ip TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_instances_email ON instances(user_email);
    CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
  `);

  // Servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      hetzner_id TEXT NOT NULL,
      ip TEXT NOT NULL,
      type TEXT NOT NULL,
      ram_mb INTEGER NOT NULL,
      disk_gb INTEGER NOT NULL,
      max_users INTEGER NOT NULL DEFAULT 0,
      current_users INTEGER NOT NULL DEFAULT 0,
      allocated_ram_mb INTEGER NOT NULL DEFAULT 0,
      allocated_disk_gb INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'provisioning',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_backfills (
      instance_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_version TEXT NOT NULL,
      user_id TEXT,
      user_email TEXT,
      container_name TEXT,
      server_id TEXT,
      status TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      last_success_at TEXT,
      error_message TEXT,
      PRIMARY KEY (instance_id, skill_name, skill_version)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_backfills_skill_status ON skill_backfills(skill_name, skill_version, status);
    CREATE INDEX IF NOT EXISTS idx_skill_backfills_user ON skill_backfills(user_id, skill_name, skill_version);
  `);

  // Config table for storing Hetzner keys and other config
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Run versioned migrations for ALTER TABLE changes
  const migrations: Migration[] = [
    { version: 1, description: 'add user_id', sql: 'ALTER TABLE instances ADD COLUMN user_id TEXT DEFAULT ""' },
    { version: 2, description: 'add gateway_token', sql: 'ALTER TABLE instances ADD COLUMN gateway_token TEXT NOT NULL DEFAULT ""' },
    { version: 3, description: 'add container_ip', sql: 'ALTER TABLE instances ADD COLUMN container_ip TEXT' },
    { version: 4, description: 'add server_id', sql: 'ALTER TABLE instances ADD COLUMN server_id TEXT' },
    { version: 5, description: 'add plan', sql: 'ALTER TABLE instances ADD COLUMN plan TEXT NOT NULL DEFAULT "free"' },
    { version: 6, description: 'add device_auth_token', sql: 'ALTER TABLE instances ADD COLUMN device_auth_token TEXT' },
    { version: 7, description: 'add retry_count', sql: 'ALTER TABLE instances ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0' },
    { version: 8, description: 'add provisioning_started_at', sql: 'ALTER TABLE instances ADD COLUMN provisioning_started_at TEXT' },
    { version: 9, description: 'add discord_bot_token', sql: 'ALTER TABLE instances ADD COLUMN discord_bot_token TEXT NOT NULL DEFAULT ""' },
    { version: 10, description: 'add whatsapp_phone_number_id', sql: 'ALTER TABLE instances ADD COLUMN whatsapp_phone_number_id TEXT NOT NULL DEFAULT ""' },
    { version: 11, description: 'add whatsapp_access_token', sql: 'ALTER TABLE instances ADD COLUMN whatsapp_access_token TEXT NOT NULL DEFAULT ""' },
    { version: 12, description: 'add signal_account', sql: 'ALTER TABLE instances ADD COLUMN signal_account TEXT NOT NULL DEFAULT ""' },
    { version: 13, description: 'add slack_bot_token', sql: 'ALTER TABLE instances ADD COLUMN slack_bot_token TEXT NOT NULL DEFAULT ""' },
    { version: 14, description: 'add slack_app_token', sql: 'ALTER TABLE instances ADD COLUMN slack_app_token TEXT NOT NULL DEFAULT ""' },
    { version: 15, description: 'add provision_stage', sql: `ALTER TABLE instances ADD COLUMN provision_stage TEXT DEFAULT 'queued'` },
    { version: 16, description: 'add features', sql: `ALTER TABLE instances ADD COLUMN features TEXT DEFAULT '{}'` },
    { version: 17, description: 'add slept_at', sql: 'ALTER TABLE instances ADD COLUMN slept_at DATETIME DEFAULT NULL' },
    { version: 18, description: 'add backup_url', sql: 'ALTER TABLE instances ADD COLUMN backup_url TEXT DEFAULT NULL' },
    { version: 19, description: 'add backed_up_at', sql: 'ALTER TABLE instances ADD COLUMN backed_up_at DATETIME DEFAULT NULL' },
    { version: 20, description: 'add actual_disk_mb', sql: 'ALTER TABLE instances ADD COLUMN actual_disk_mb INTEGER DEFAULT NULL' },
    { version: 21, description: 'add servers.hetzner_key_label', sql: 'ALTER TABLE servers ADD COLUMN hetzner_key_label TEXT' },
    { version: 22, description: 'add servers.storage_driver', sql: 'ALTER TABLE servers ADD COLUMN storage_driver TEXT DEFAULT NULL' },
    { version: 23, description: 'add browser_server_token', sql: 'ALTER TABLE instances ADD COLUMN browser_server_token TEXT DEFAULT NULL' },
    { version: 24, description: 'add persona', sql: 'ALTER TABLE instances ADD COLUMN persona TEXT DEFAULT NULL' },
    { version: 25, description: 'add user_meta', sql: `ALTER TABLE instances ADD COLUMN user_meta TEXT DEFAULT ''` },
  ];
  runMigrations(db, migrations, (msg, meta) => log.info(msg, meta));

  // Geo cache table for IP-based country verification
  db.exec(`
    CREATE TABLE IF NOT EXISTS geo_cache (
      uid TEXT PRIMARY KEY,
      country_code TEXT NOT NULL,
      ip TEXT NOT NULL,
      cached_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Backfill: running instances are fully provisioned
  db.exec(
    `UPDATE instances SET provision_stage = 'complete' WHERE status = '${INSTANCE_STATUS.RUNNING}' AND (provision_stage IS NULL OR provision_stage != 'complete')`,
  );

  // Migrate old 'creating' status to 'queued' for stuck instances
  db.exec(`UPDATE instances SET status = '${INSTANCE_STATUS.QUEUED}' WHERE status = 'creating'`);

  // ─── Unique Index for Duplicate Prevention ───────────────────
  // Prevents multiple active instances for the same user_id
  // Only applies when user_id is not empty and status is not terminal
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_instances_active_user_id 
      ON instances(user_id) 
      WHERE user_id != '' AND status NOT IN (${statusSqlIn([INSTANCE_STATUS.DELETED, INSTANCE_STATUS.FAILED, INSTANCE_STATUS.ERROR])})
    `);
    log.info('db.created', { msg: 'Created unique index idx_instances_active_user_id for duplicate prevention' });
  } catch (err: unknown) {
    // Index might already exist or there might be duplicates that need cleanup
    if (toErrorMessage(err).includes('UNIQUE constraint failed')) {
      log.warn('db.duplicate_active', { msg: 'Duplicate active instances detected — cleanup may be needed' });
    }
    // Ignore other errors (index already exists, etc.)
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// ─── Proxy DB (read-only, singleton) ───────────────────────────
const PROXY_DB_PATH = env.PROXY_DB_PATH;
let proxyDb: Database.Database | null = null;

/**
 * Get a read-only connection to the api-proxy keys DB.
 * Lazily initialized on first call; reused across the process lifetime.
 * Returns null if the DB file doesn't exist or can't be opened.
 */
export function getProxyDb(): Database.Database | null {
  if (proxyDb) return proxyDb;
  try {
    if (!existsSync(PROXY_DB_PATH)) return null;
    proxyDb = new Database(PROXY_DB_PATH);
    return proxyDb;
  } catch (err: unknown) {
    log.warn('db.failed', { PROXY_DB_PATH: PROXY_DB_PATH, error: toErrorMessage(err) });
    return null;
  }
}
