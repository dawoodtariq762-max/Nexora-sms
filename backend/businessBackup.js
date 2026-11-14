'use strict';
/**
 * AMS SMS — BUSINESS DATA BACKUP
 * ============================================================================
 * Replaces the previous FULL database copy (VACUUM INTO of the whole live file)
 * with a small, self-contained SQLite database that carries ONLY approved
 * business data:
 *
 *   1. accounts           users            (id, username, bcrypt hash, identity)
 *   2. SMS history        sms_records      (content + ownership + payout inputs)
 *   3. range reference    ranges_ref       (id + name ONLY, a derived reference —
 *                                          never the ranges inventory table)
 *   4. payment history    payment_ledger   (agent ledger: earned/eligible/status)
 *                         payment_requests_v2 (withdrawals: amounts/status/txid)
 *
 * Everything else (chat, API/SMPP credentials, providers, inventory, limits,
 * sharing, complaints, branding, logs, jobs, settings, temporary records) is
 * NOT copied. The allowlist below is deny-by-default: a column is only ever
 * written to a backup when it is named in this file. New columns added to the
 * live schema therefore cannot leak into backups until they are reviewed and
 * added here deliberately.
 *
 * HOW A BACKUP IS BUILT (consistent + atomic)
 *   1. VACUUM INTO  -> a consistent point-in-time snapshot of the live database
 *                      in a temporary file (O(1) Node memory, single read txn).
 *   2. copy         -> the allowlisted columns are copied table-by-table from
 *                      that immutable snapshot into a brand-new database file
 *                      written as "<name>.sqlite.partial".
 *   3. validate     -> integrity_check + per-table row counts + version marker.
 *   4. fsync+rename -> the validated file is promoted atomically to its final
 *                      name. A crash can only ever leave a ".partial" file,
 *                      which retention removes; it can never leave a truncated
 *                      backup with a valid-looking name.
 *
 * The intermediate full snapshot is deleted in a `finally` block so peak disk
 * usage is one transient copy of the database — the same as the old behaviour.
 *
 * RESTORE SEMANTICS (important)
 *   A business backup is NOT a complete database image. It must never be used to
 *   replace the live file: that would delete every excluded table. Therefore
 *   `restoreBackup()` in ./backup.js refuses business backups and only accepts
 *   legacy full images. Business backups are verified by restoring them into an
 *   isolated temporary database (`verifyRestoreTest`) exactly as required.
 *
 * RETENTION
 *   5 CALENDAR months (not 180 days): the cutoff is computed with month
 *   arithmetic and day clamping, so 31 March - 1 month = 28/29 February.
 *   Only completed backup files directly inside the configured backup directory
 *   are ever deleted. Files currently being written, symlinks, directories and
 *   anything outside the directory are never touched. Abandoned *.partial /
 *   snapshot temp files older than BACKUP_STALE_TMP_HOURS are cleaned up.
 *
 * LOGGING
 *   Only file names, sizes, timings and row counts are ever logged. No password
 *   hashes, SMS content, wallet data or credentials are logged or returned.
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/* ------------------------------------------------------------------ *
 * Constants / naming (shared with ./backup.js and the deploy scripts)
 * ------------------------------------------------------------------ */
const BACKUP_PREFIX = 'ams-sms-backup-';
const LEGACY_BACKUP_PREFIXES = ['qtech-sms-backup-', 'nova-sms-backup-', 'almada-sms-backup-'];
const BACKUP_NAME_RE = /^(?:ams|qtech|almada|nova)-sms-backup-\d{4}-\d{2}-\d{2}T[\w-]+\.sqlite$/;
const PARTIAL_SUFFIX = '.partial';
const STALE_TMP_RE = /^(?:\.)?(?:ams|qtech|almada|nova)?-?sms-backup-[\w.-]+\.sqlite\.(?:partial|tmp)$|^\.ams-business-snapshot-[\w.-]+\.tmp$/;

const BACKUP_FORMAT = 'ams-sms-business-backup';
const BACKUP_VERSION = 1;                 // bump when the included set changes
const APPLICATION_ID = 0x414d5342;        // 'AMSB' — written into the file header
const DEFAULT_RETENTION_MONTHS = 5;
const DEFAULT_STALE_TMP_HOURS = 6;

/* Absolute paths of files being written right now (never pruned). */
const activeWrites = new Set();
let runInProgress = false;

/* ------------------------------------------------------------------ *
 * Included data — deny by default
 * ------------------------------------------------------------------ *
 * `required` columns must exist in the live schema (schema-drift guard).
 * `optional` columns are copied only when the live schema still has them.
 * Anything that is not named here is deliberately excluded.
 */
const SPEC = [
  {
    table: 'users',
    label: 'Accounts',
    required: ['id', 'username', 'password', 'role', 'name', 'parent_id', 'active', 'created_at'],
    optional: ['email', 'whatsapp', 'contact', 'skype', 'payment_type', 'is_super_manager'],
    // excluded on purpose: chat_display_name, legal_version, legal_accepted_at
    // (chat profile / legal UI state, not account identity or financial data)
  },
  {
    table: 'sms_records',
    label: 'SMS records',
    required: ['id', 'number_id', 'number', 'range_id', 'cli', 'message', 'received_at',
      'payout_rate', 'payout_amount', 'manager_id', 'agent_id', 'client_id'],
    optional: ['sender_type', 'otp_code', 'is_otp', 'is_test', 'test_batch_id', 'source',
      'payment_type', 'limit_reason'],
  },
  {
    // Derived reference table: range id + historical range name only.
    // The full `ranges` inventory (prefix, rates, currency, limits, provider,
    // status, timestamps) is NOT included.
    table: 'ranges_ref',
    from: 'ranges',
    label: 'Range names (reference only)',
    required: ['id', 'name'],
    optional: [],
    noIndexes: true,
  },
  {
    table: 'payment_ledger',
    label: 'Payment ledger',
    required: ['id', 'sms_record_id', 'agent_id', 'manager_id', 'range_id', 'payment_type',
      'amount', 'earned_at', 'cycle_key', 'eligible_at', 'status', 'request_id', 'created_at'],
    optional: [],
  },
  {
    table: 'payment_requests_v2',
    label: 'Payment requests',
    required: ['id', 'agent_id', 'manager_id', 'payment_type', 'amount', 'status',
      'requested_at', 'paid_at', 'rejected_at', 'txid', 'created_at'],
    optional: ['processed_by', 'admin_notes', 'reject_reason'],
    // excluded on purpose: wallet_address, binance_uid (payout destination
    // identifiers — not required to reconstruct totals; txid stays as reference)
    // excluded on purpose: screenshot_url (points at a file outside the backup)
  },
];

/* Tables that must never appear inside a business backup. Used by the
   restore test to prove the excluded data really is absent. */
const FORBIDDEN_TABLES = [
  'chat_credentials', 'chat_conversations', 'chat_messages', 'chat_attachments',
  'chat_presence', 'chat_lock_prefs',
  'api_credentials', 'api_integrations', 'api_integration_seen', 'api_integration_logs',
  'api_request_logs',
  'ams_providers', 'provider_payments', 'sync_providers', 'sync_seen', 'sync_logs',
  'smpp_connections', 'smpp_seen', 'smpp_logs', 'smpp_outbox',
  'numbers', 'ranges', 'range_test_numbers', 'number_import_batches', 'number_history',
  'cli_limits', 'daily_limit_rules', 'sharing_users', 'sharing_forward_logs',
  'complaints', 'complaint_replies',
  'app_settings', 'carrier_settings', 'system_security', 'payment_v2_settings',
  'payment_schedule', 'agent_wallets', 'payment_audit_logs', 'payment_notifications_v2',
  'jobs', 'audit_logs', 'activity_ips', 'idempotency_keys', 'webhook_logs',
  'failed_sms_queue', 'sms_daily_stats', 'meta',
];

/* Documented ID relationships between included tables. Foreign-key CONSTRAINTS
   are intentionally not reproduced in the backup (the targets — numbers, ranges,
   providers — are excluded), but every ID is preserved verbatim so the
   relationships can be reconstructed with a join. */
const RELATIONS = [
  ['users.parent_id', 'users.id', 'account hierarchy (manager/agent/client chain)'],
  ['sms_records.manager_id', 'users.id', 'SMS owner — manager'],
  ['sms_records.agent_id', 'users.id', 'SMS owner — agent'],
  ['sms_records.client_id', 'users.id', 'SMS owner — client'],
  ['sms_records.range_id', 'ranges_ref.id', 'range name reference (id + name only)'],
  ['sms_records.number_id', 'number value (snapshotted)', 'number_id kept; numbers table excluded'],
  ['payment_ledger.sms_record_id', 'sms_records.id', 'one ledger row per agent-involved SMS'],
  ['payment_ledger.agent_id', 'users.id', 'ledger owner — agent'],
  ['payment_ledger.manager_id', 'users.id', 'ledger owner — manager'],
  ['payment_ledger.range_id', 'ranges_ref.id', 'range name reference'],
  ['payment_ledger.request_id', 'payment_requests_v2.id', 'withdrawal that settled the ledger rows'],
  ['payment_requests_v2.agent_id', 'users.id', 'withdrawal owner — agent'],
  ['payment_requests_v2.manager_id', 'users.id', 'withdrawal approver — manager'],
  ['payment_requests_v2.processed_by', 'users.id', 'account that processed the withdrawal'],
];

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function qIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}
function qLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}
function isBackupFileName(base) {
  return BACKUP_NAME_RE.test(String(base || ''));
}
function getBackupDir() {
  return process.env.BACKUP_DIR
    || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null)
    // VPS-safe default: outside the application folder.
    || path.join(os.homedir(), 'ams-sms-backups');
}
function ensureBackupDir() {
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function safeBackupName(name) {
  const base = path.basename(String(name || ''));
  if (!isBackupFileName(base)) throw new Error('Invalid backup file name');
  return base;
}
function backupPath(fileName) {
  return path.join(ensureBackupDir(), safeBackupName(fileName));
}
function withinDir(dir, filePath) {
  const realDir = fs.realpathSync(dir);
  const parent = fs.realpathSync(path.dirname(filePath));
  return parent === realDir;
}
function fsyncFile(filePath) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); fs.fsyncSync(fd); }
  catch (_) { /* fsync is best-effort on some filesystems */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}
function fsyncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch (_) { /* directories cannot be fsynced on every platform */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} } }
}

/* ------------------------------------------------------------------ *
 * Decimal helpers — amounts are TEXT decimals in this schema, so totals
 * are summed with BigInt (never floats) to stay exact.
 * ------------------------------------------------------------------ */
function decimalParts(value) {
  const raw = String(value == null || value === '' ? '0' : value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = (negative ? raw.slice(1) : raw).split('.');
  return { n: BigInt(whole + frac) * (negative ? -1n : 1n), scale: frac.length };
}
function decimalAdd(a, b) {
  const x = a, y = b;
  const scale = Math.max(x.scale, y.scale);
  const sum = x.n * 10n ** BigInt(scale - x.scale) + y.n * 10n ** BigInt(scale - y.scale);
  return { n: sum, scale };
}
function decimalToString(d) {
  if (!d) return '0';
  const negative = d.n < 0n;
  let digits = (negative ? -d.n : d.n).toString().padStart(d.scale + 1, '0');
  let out = digits;
  if (d.scale) out = digits.slice(0, -d.scale) + '.' + digits.slice(-d.scale);
  out = out.replace(/\.?0+$/, '');
  if (!out || out === '-') out = '0';
  return (negative && out !== '0' ? '-' : '') + out;
}
const zeroDecimal = () => ({ n: 0n, scale: 0 });

/* ------------------------------------------------------------------ *
 * Backup kind detection — by file content, never by file name
 * ------------------------------------------------------------------ */
const kindCache = new Map();
function detectBackupKind(filePath) {
  let st;
  try { st = fs.statSync(filePath); } catch (_) { return 'missing'; }
  const key = filePath + '|' + st.size + '|' + st.mtimeMs;
  if (kindCache.has(key)) return kindCache.get(key);
  let kind = 'unknown';
  let handle;
  try {
    handle = new Database(filePath, { readonly: true, fileMustExist: true });
    const hasTable = t => !!handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    let appId = 0;
    try { appId = Number(handle.pragma('application_id', { simple: true })); } catch (_) { appId = 0; }
    if (appId === APPLICATION_ID) kind = 'business';
    else if (hasTable('backup_meta')) {
      let fmt = '';
      try { const row = handle.prepare("SELECT value FROM backup_meta WHERE key='backup_format' LIMIT 1").get(); fmt = row ? String(row.value) : ''; } catch (_) {}
      kind = fmt === BACKUP_FORMAT ? 'business' : 'unknown';
    } else if (hasTable('users') && hasTable('sms_records')) {
      /* complete application image (full backup, current or pre-AMS) */
      kind = 'full';
    } else if (hasTable('sms_records')) {
      kind = 'partial-legacy';
    }
    /* No integrity_check here: listBackups() probes every file and a full
       integrity scan of a legacy multi-hundred-MB image would be far too slow.
       Integrity is validated when a backup is written and again on restore test. */
  } catch (_) { kind = 'invalid'; }
  finally { try { if (handle) handle.close(); } catch (_) {} }
  if (kindCache.size > 500) kindCache.clear();
  kindCache.set(key, kind);
  return kind;
}

/* ------------------------------------------------------------------ *
 * Schema introspection on the snapshot
 * ------------------------------------------------------------------ */
function sourceColumns(src, table) {
  let rows;
  try { rows = src.pragma('table_info(' + qIdent(table) + ')'); }
  catch (_) { return null; }
  if (!rows || !rows.length) return null;
  return rows.map(r => ({
    cid: r.cid, name: r.name, type: r.type || '',
    notnull: r.notnull, dflt_value: r.dflt_value, pk: r.pk,
  }));
}

function resolveColumns(spec, available, warnings) {
  const present = new Set(available.map(c => c.name));
  const missingRequired = spec.required.filter(c => !present.has(c));
  if (missingRequired.length) {
    throw new Error(`Backup aborted: table "${spec.from || spec.table}" is missing required column(s): ${missingRequired.join(', ')}`);
  }
  const include = [];
  for (const name of spec.required) include.push(available.find(c => c.name === name));
  for (const name of spec.optional) {
    if (present.has(name)) include.push(available.find(c => c.name === name));
    else warnings.push(`${spec.from || spec.table}.${name} not present in this database — skipped`);
  }
  const allowed = new Set([...spec.required, ...spec.optional]);
  const dropped = available.filter(c => !allowed.has(c.name)).map(c => c.name);
  return { include, dropped };
}

function buildTableDdl(outTable, columns) {
  const defs = columns.map(c => {
    let def = qIdent(c.name) + (c.type ? ' ' + c.type : '');
    if (c.notnull) def += ' NOT NULL';
    /* PRAGMA table_info() returns the default WITHOUT its parentheses, so an
       expression default (datetime('now')) must be re-wrapped to stay valid. */
    if (c.dflt_value !== null && c.dflt_value !== undefined) def += ' DEFAULT (' + c.dflt_value + ')';
    return def;
  });
  const pk = columns.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => qIdent(c.name));
  if (pk.length) defs.push('PRIMARY KEY (' + pk.join(', ') + ')');
  return `CREATE TABLE ${qIdent(outTable)} (\n  ${defs.join(',\n  ')}\n)`;
}

/* Compact index set for the RESTORED database.
   The live sms_records table carries ~15 reporting indexes; copying all of them
   made the "small" backup nearly as large as the live file. Only the indexes
   that matter for the required reporting (total, number-wise, range-wise,
   account-wise, date-wise, payment joins) are recreated — and the two UNIQUE
   constraints that guarantee one ledger row per SMS and one row per username
   are preserved as unique indexes. */
const OUTPUT_INDEXES = {
  users: [
    'CREATE UNIQUE INDEX ux_bk_users_username ON users(username)',
    'CREATE INDEX ix_bk_users_role ON users(role)',
    'CREATE INDEX ix_bk_users_parent ON users(parent_id)',
  ],
  sms_records: [
    'CREATE INDEX ix_bk_sms_received ON sms_records(received_at)',
    'CREATE INDEX ix_bk_sms_number ON sms_records(number)',
    'CREATE INDEX ix_bk_sms_range ON sms_records(range_id)',
    'CREATE INDEX ix_bk_sms_manager ON sms_records(manager_id)',
    'CREATE INDEX ix_bk_sms_agent ON sms_records(agent_id)',
    'CREATE INDEX ix_bk_sms_client ON sms_records(client_id)',
    'CREATE INDEX ix_bk_sms_cli ON sms_records(cli)',
  ],
  payment_ledger: [
    'CREATE UNIQUE INDEX ux_bk_ledger_sms ON payment_ledger(sms_record_id)',
    'CREATE INDEX ix_bk_ledger_agent ON payment_ledger(agent_id)',
    'CREATE INDEX ix_bk_ledger_manager ON payment_ledger(manager_id)',
    'CREATE INDEX ix_bk_ledger_status ON payment_ledger(status)',
    'CREATE INDEX ix_bk_ledger_cycle ON payment_ledger(cycle_key)',
    'CREATE INDEX ix_bk_ledger_request ON payment_ledger(request_id)',
  ],
  payment_requests_v2: [
    'CREATE INDEX ix_bk_req_agent ON payment_requests_v2(agent_id)',
    'CREATE INDEX ix_bk_req_status ON payment_requests_v2(status)',
  ],
};

function createOutputIndexes(out, outTable, warnings) {
  const created = [];
  for (const sql of (OUTPUT_INDEXES[outTable] || [])) {
    const name = (sql.match(/INDEX\s+(\w+)/) || [])[1] || sql;
    try { out.exec(sql); created.push(name); }
    catch (e) { warnings.push(`index ${name} skipped: ${e.message}`); }
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * Metrics used by the restore test (streaming, O(1) memory)
 * ------------------------------------------------------------------ */
function digestQuery(handle, sql, params = []) {
  const hash = crypto.createHash('sha256');
  let rows = 0, total = zeroDecimal();
  let hasAmount = false;
  const stmt = handle.prepare(sql);
  for (const row of stmt.iterate(...params)) {
    rows++;
    const parts = [];
    for (const [k, v] of Object.entries(row)) {
      parts.push(k + '=' + (v === null || v === undefined ? '' : String(v)));
      if (k === 'amount' || k === 'payout_amount') {
        const d = decimalParts(v);
        if (d) { total = decimalAdd(total, d); hasAmount = true; }
      }
    }
    hash.update(parts.join('\u001f') + '\n');
  }
  return { rows, digest: hash.digest('hex'), amount_total: hasAmount ? decimalToString(total) : null };
}

function tableCount(handle, table) {
  try { return Number(handle.prepare(`SELECT COUNT(*) AS c FROM ${qIdent(table)}`).get().c || 0); }
  catch (_) { return null; }
}

function collectMetrics(handle) {
  const has = t => !!handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const m = {};
  m.tables = (handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() || [])
    .map(r => r.name).sort();
  m.users_total = has('users') ? tableCount(handle, 'users') : 0;
  m.users_by_role = has('users')
    ? digestQuery(handle, 'SELECT role AS k, COUNT(*) AS c FROM users GROUP BY role ORDER BY role') : null;
  m.sms_total = has('sms_records') ? tableCount(handle, 'sms_records') : 0;
  m.sms_by_number = has('sms_records')
    ? digestQuery(handle, 'SELECT number AS k, COUNT(*) AS c FROM sms_records GROUP BY number ORDER BY number') : null;
  m.sms_by_range = has('sms_records')
    ? digestQuery(handle, 'SELECT range_id AS k, COUNT(*) AS c FROM sms_records GROUP BY range_id ORDER BY range_id') : null;
  m.sms_by_account = has('sms_records')
    ? digestQuery(handle, 'SELECT manager_id AS k, agent_id AS a, client_id AS cl, COUNT(*) AS c FROM sms_records GROUP BY manager_id, agent_id, client_id ORDER BY manager_id, agent_id, client_id') : null;
  m.sms_by_day = has('sms_records')
    ? digestQuery(handle, 'SELECT substr(received_at,1,10) AS k, COUNT(*) AS c FROM sms_records GROUP BY k ORDER BY k') : null;
  m.sms_payout_total = has('sms_records')
    ? digestQuery(handle, 'SELECT payout_amount AS amount, payout_rate AS r FROM sms_records').amount_total : null;
  m.ledger_total = has('payment_ledger') ? tableCount(handle, 'payment_ledger') : 0;
  m.ledger_by_account = has('payment_ledger')
    ? digestQuery(handle, 'SELECT agent_id AS a, manager_id AS m, payment_type AS p, status AS s, amount AS amount FROM payment_ledger ORDER BY agent_id, manager_id, payment_type, status, id') : null;
  m.ledger_amount_total = has('payment_ledger')
    ? digestQuery(handle, 'SELECT amount AS amount, status AS s FROM payment_ledger').amount_total : null;
  m.requests_total = has('payment_requests_v2') ? tableCount(handle, 'payment_requests_v2') : 0;
  m.requests_by_status = has('payment_requests_v2')
    ? digestQuery(handle, 'SELECT status AS s, amount AS amount FROM payment_requests_v2 ORDER BY id') : null;
  m.range_names = has('ranges_ref')
    ? digestQuery(handle, 'SELECT id AS k, name AS n FROM ranges_ref ORDER BY id')
    : (has('ranges')
      /* live side: same id+name projection from the inventory table, so the
         restored reference can be compared with the source it came from */
      ? digestQuery(handle, 'SELECT id AS k, name AS n FROM ranges ORDER BY id') : null);
  return m;
}

const METRIC_LABELS = {
  users_total: 'Account count',
  users_by_role: 'Accounts by role',
  sms_total: 'SMS count',
  sms_by_number: 'Number-wise SMS count',
  sms_by_range: 'Range-wise SMS count',
  sms_by_account: 'Account-wise SMS count',
  sms_by_day: 'Daily SMS count',
  sms_payout_total: 'SMS payout total',
  ledger_total: 'Ledger row count',
  ledger_by_account: 'Ledger by account/type/status',
  ledger_amount_total: 'Ledger amount total',
  requests_total: 'Payment request count',
  requests_by_status: 'Requests by status/amount',
  range_names: 'Range name reference',
};

/* ------------------------------------------------------------------ *
 * Create a business backup
 * ------------------------------------------------------------------ */
function createBusinessBackup(db, reason = 'manual', opts = {}) {
  if (runInProgress) {
    const e = new Error('A backup is already running — this run was skipped');
    e.code = 'BACKUP_BUSY';
    throw e;
  }
  runInProgress = true;
  const log = opts.log || console;
  const dir = ensureBackupDir();
  const started = Date.now();
  const file = `${BACKUP_PREFIX}${ts()}.sqlite`;
  const finalPath = path.join(dir, file);
  const partPath = finalPath + PARTIAL_SUFFIX;
  const snapshotPath = path.join(dir, `.ams-business-snapshot-${process.pid}-${Date.now()}.tmp`);
  activeWrites.add(partPath);
  activeWrites.add(snapshotPath);

  let snapshotMode = 'vacuum-into';
  const warnings = [];
  const tableReport = [];
  let src, out;

  try {
    /* 1 — consistent snapshot of the live database -------------------
       The snapshot is taken on a DEDICATED connection, never on the app
       connection: every non-GET /api request holds an open BEGIN IMMEDIATE
       batch transaction (server.js middleware), and VACUUM cannot run inside a
       transaction. A second connection reads the last committed state — in WAL
       mode readers are never blocked by that writer — so the snapshot is still
       a single consistent point in time. */
    const sourceDbFile = db && db.getDbFile ? db.getDbFile() : null;
    if (!sourceDbFile) throw new Error('no database file to back up');
    try {
      const holder = new Database(sourceDbFile);
      try {
        holder.pragma('busy_timeout = 10000');
        holder.exec(`VACUUM INTO ${qLiteral(snapshotPath)}`);
      } finally { try { holder.close(); } catch (_) {} }
    } catch (e) {
      snapshotMode = 'export-buffer';
      warnings.push('VACUUM INTO unavailable — fell back to exportBuffer()');
      if (!db || typeof db.exportBuffer !== 'function' || (db.inTransaction && db.inTransaction())) throw e;
      const buf = db.exportBuffer();
      fs.writeFileSync(snapshotPath, Buffer.from(buf));
    }
    fsyncFile(snapshotPath);

    /* 2 — build the small business database from that snapshot ------- */
    src = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    out = new Database(partPath);
    try { fs.chmodSync(partPath, 0o600); } catch (_) {}
    out.pragma('journal_mode = DELETE');   // single file, no -wal to transport
    out.pragma('synchronous = FULL');
    out.pragma('foreign_keys = OFF');      // targets of some FKs are excluded
    out.exec(`ATTACH DATABASE ${qLiteral(snapshotPath)} AS snap`);

    out.exec(`CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

    const plan = [];
    for (const spec of SPEC) {
      const srcTable = spec.from || spec.table;
      const available = sourceColumns(src, srcTable);
      if (!available) throw new Error(`Backup aborted: required table "${srcTable}" is missing from this database`);
      const { include, dropped } = resolveColumns(spec, available, warnings);
      const ddl = buildTableDdl(spec.table, include);
      out.exec(ddl);
      plan.push({ spec, srcTable, include, dropped });
    }

    out.exec('BEGIN');
    for (const item of plan) {
      const cols = item.include.map(c => qIdent(c.name)).join(', ');
      const sql = `INSERT INTO main.${qIdent(item.spec.table)} (${cols}) SELECT ${cols} FROM snap.${qIdent(item.srcTable)}`;
      out.prepare(sql).run();
      const rows = tableCount(out, item.spec.table);
      const indexes = item.spec.noIndexes ? [] : createOutputIndexes(out, item.spec.table, warnings);
      tableReport.push({ table: item.spec.table, label: item.spec.label, rows, columns: item.include.length, indexes, dropped_columns: item.dropped });
      if (item.dropped.length) warnings.push(`${item.spec.table}: ${item.dropped.length} non-allowlisted column(s) not copied`);
    }
    out.exec('COMMIT');

    /* 3 — version marker + timestamp inside the file ----------------- */
    const sourceSize = (() => { try { return fs.statSync(db && db.getDbFile ? db.getDbFile() : snapshotPath).size; } catch (_) { return null; } })();
    const meta = {
      backup_format: BACKUP_FORMAT,
      backup_version: String(BACKUP_VERSION),
      backup_kind: 'business',
      created_at: new Date().toISOString(),
      created_at_uk: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'full', timeStyle: 'long' }).format(new Date()),
      reason: String(reason),
      snapshot_mode: snapshotMode,
      source_db: db && db.getDbFile ? path.basename(db.getDbFile()) : '',
      source_size_bytes: sourceSize === null ? '' : String(sourceSize),
      retention_months: String(retentionMonths()),
      sqlite_version: String(src.pragma('user_version', { simple: true }) !== undefined ? (src.prepare('SELECT sqlite_version() AS v').get().v) : ''),
      node_version: process.version,
      tables: JSON.stringify(tableReport.map(t => ({ table: t.table, rows: t.rows }))),
      relations: JSON.stringify(RELATIONS),
    };
    const insMeta = out.prepare('INSERT INTO backup_meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, v);
    out.pragma(`user_version = ${BACKUP_VERSION}`);
    out.pragma(`application_id = ${APPLICATION_ID}`);
    out.exec('DETACH DATABASE snap');
    out.close();
    out = null;
    src.close();
    src = null;

    /* 4 — validate, then promote atomically ------------------------- */
    const check = validateBackupFile(partPath, { expectTables: tableReport });
    if (!check.ok) throw new Error('Backup validation failed: ' + check.error);
    fsyncFile(partPath);
    fs.renameSync(partPath, finalPath);         // atomic on the same filesystem
    /* Account hashes are inside the file: keep it owner-only. */
    try { fs.chmodSync(finalPath, 0o600); } catch (_) {}
    fsyncDir(dir);
    activeWrites.delete(partPath);
    activeWrites.delete(snapshotPath);
    try { fs.unlinkSync(snapshotPath); } catch (_) {}

    const size = fs.statSync(finalPath).size;
    const sourceBytes = sourceSize || 0;
    log.log(`✓ Business backup created: ${file} (${(size / 1024 / 1024).toFixed(2)} MB${sourceBytes ? ' vs live database ' + (sourceBytes / 1024 / 1024).toFixed(2) + ' MB' : ''})`);
    log.log('  tables: ' + tableReport.map(t => `${t.table}=${t.rows}`).join(' '));
    if (warnings.length) log.log('  notes: ' + warnings.join(' | '));

    return {
      file,
      size,
      reason,
      created_at: new Date().toISOString(),
      kind: 'business',
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      duration_ms: Date.now() - started,
      tables: tableReport.map(t => ({ table: t.table, rows: t.rows })),
      warnings,
    };
  } catch (e) {
    try { if (out) out.close(); } catch (_) {}
    try { if (src) src.close(); } catch (_) {}
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (_) {}
    throw e;
  } finally {
    runInProgress = false;
    activeWrites.delete(partPath);
    activeWrites.delete(snapshotPath);
    try { if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * Validation of a finished backup file
 * ------------------------------------------------------------------ */
function validateBackupFile(filePath, { expectTables = null } = {}) {
  let handle;
  try {
    handle = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = handle.pragma('integrity_check', { simple: true });
    if (String(integrity) !== 'ok') return { ok: false, error: 'integrity_check: ' + integrity };
    const appId = Number(handle.pragma('application_id', { simple: true }));
    if (appId !== APPLICATION_ID) return { ok: false, error: 'missing business-backup application_id marker' };
    const metaRows = handle.prepare('SELECT key, value FROM backup_meta').all();
    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
    if (meta.backup_format !== BACKUP_FORMAT) return { ok: false, error: 'missing backup_format marker' };
    if (!meta.backup_version || !meta.created_at) return { ok: false, error: 'missing version/timestamp marker' };
    if (expectTables) {
      for (const t of expectTables) {
        const actual = tableCount(handle, t.table);
        if (actual !== t.rows) return { ok: false, error: `row count mismatch for ${t.table}: expected ${t.rows}, found ${actual}` };
      }
    }
    return { ok: true, meta, version: Number(meta.backup_version), created_at: meta.created_at };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { if (handle) handle.close(); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * Retention — 5 CALENDAR months
 * ------------------------------------------------------------------ */
function retentionMonths() {
  const raw = process.env.BACKUP_RETENTION_MONTHS;
  const n = raw === undefined || raw === '' ? DEFAULT_RETENTION_MONTHS : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_MONTHS;
}
function staleTmpHours() {
  const n = parseInt(process.env.BACKUP_STALE_TMP_HOURS || String(DEFAULT_STALE_TMP_HOURS), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_TMP_HOURS;
}
/** Calendar-month subtraction with day clamping (31 Mar − 1 month = 28/29 Feb). */
function subtractCalendarMonths(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const target = new Date(Date.UTC(y, m - months, 1,
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target;
}
function retentionCutoff(now = new Date(), months = retentionMonths()) {
  return subtractCalendarMonths(now, months);
}
function retentionInfo(now = new Date()) {
  const months = retentionMonths();
  return {
    mode: 'calendar-months',
    months,
    cutoff: retentionCutoff(now, months).toISOString(),
    computed_at: now.toISOString(),
  };
}

function cleanupOldBackups(opts = {}) {
  const dir = ensureBackupDir();
  const now = opts.now ? new Date(opts.now) : new Date();
  const dryRun = !!opts.dryRun;
  const log = opts.log || null;
  const months = retentionMonths();
  const cutoff = retentionCutoff(now, months);
  const cutoffMs = cutoff.getTime();
  const staleMs = staleTmpHours() * 60 * 60 * 1000;
  const report = {
    dir,
    retention: { mode: 'calendar-months', months, cutoff: cutoff.toISOString() },
    deleted: [], kept: [], skipped: [], removed_temp: [], errors: [],
  };

  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (e) { report.errors.push('cannot read backup dir: ' + e.message); return report; }

  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(full); } catch (_) { continue; }
    if (!st.isFile()) { if (!st.isSymbolicLink()) continue; report.skipped.push({ file: name, why: 'symlink' }); continue; }
    let inside = false;
    try { inside = withinDir(dir, full); } catch (_) { inside = false; }
    if (!inside) { report.skipped.push({ file: name, why: 'outside backup dir' }); continue; }

    /* Abandoned temporary files (never completed, not currently in use). */
    if (STALE_TMP_RE.test(name) && !isBackupFileName(name)) {
      if (activeWrites.has(full)) { report.skipped.push({ file: name, why: 'being written' }); continue; }
      if (now.getTime() - st.mtimeMs >= staleMs) {
        if (!dryRun) { try { fs.unlinkSync(full); } catch (e) { report.errors.push(name + ': ' + e.message); continue; } }
        report.removed_temp.push(name);
      }
      continue;
    }

    if (!isBackupFileName(name)) continue;          // not a backup of ours
    if (activeWrites.has(full)) { report.skipped.push({ file: name, why: 'being written' }); continue; }

    if (st.mtimeMs < cutoffMs) {
      if (!dryRun) {
        try { fs.unlinkSync(full); }
        catch (e) { report.errors.push(name + ': ' + e.message); continue; }
      }
      report.deleted.push(name);
    } else {
      report.kept.push(name);
    }
  }

  if (log) {
    log.log(`• Backup retention (${months} calendar months, cutoff ${cutoff.toISOString().slice(0, 10)}): ` +
      `${report.deleted.length} deleted, ${report.kept.length} kept` +
      (report.removed_temp.length ? `, ${report.removed_temp.length} stale temp file(s) removed` : ''));
    for (const d of report.deleted) log.log('  deleted ' + d);
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * Restore test in an isolated temporary database
 * ------------------------------------------------------------------ */
function verifyRestoreTest(dbOrFile, fileName, opts = {}) {
  const dir = ensureBackupDir();
  const fullPath = backupPath(fileName);
  if (!fs.existsSync(fullPath)) throw Object.assign(new Error('Backup not found'), { status: 404 });
  const kind = detectBackupKind(fullPath);
  if (kind !== 'business') {
    throw Object.assign(new Error('Restore test applies to business backups only (found: ' + kind + ')'), { status: 400 });
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ams-restore-'));
  const restoredPath = path.join(tmpDir, 'restored.sqlite');
  const started = Date.now();
  let restored;
  try {
    fs.copyFileSync(fullPath, restoredPath);           // isolated copy — live DB untouched
    fsyncFile(restoredPath);
    restored = new Database(restoredPath, { readonly: true, fileMustExist: true });

    const integrity = restored.pragma('integrity_check', { simple: true });
    const appId = Number(restored.pragma('application_id', { simple: true }));
    const meta = Object.fromEntries(restored.prepare('SELECT key, value FROM backup_meta').all().map(r => [r.key, r.value]));
    const expectedCounts = (() => { try { return JSON.parse(meta.tables || '[]'); } catch (_) { return []; } })();

    /* Read-only view of the CURRENT live database for a source-vs-restored
       comparison. Any difference is reported, never "fixed". */
    let live = null, liveHandle = null;
    try {
      const liveFile = dbOrFile && typeof dbOrFile === 'object' && dbOrFile.getDbFile
        ? dbOrFile.getDbFile()
        : (typeof dbOrFile === 'string' ? dbOrFile : null);
      if (liveFile && fs.existsSync(liveFile)) {
        liveHandle = new Database(liveFile, { readonly: true, fileMustExist: true });
        live = liveHandle;
      }
    } catch (_) { live = null; }

    const restoredMetrics = collectMetrics(restored);
    const liveMetrics = live ? collectMetrics(live) : null;

    const comparisons = [];
    for (const key of Object.keys(METRIC_LABELS)) {
      const r = restoredMetrics[key];
      const l = liveMetrics ? liveMetrics[key] : null;
      const sameAsBackupCounts = !(key in { users_total: 1, sms_total: 1, ledger_total: 1, requests_total: 1 })
        || expectedCounts.some(t => t.rows === r);
      const identical = l === null ? null : JSON.stringify(l) === JSON.stringify(r);
      comparisons.push({
        metric: METRIC_LABELS[key],
        restored: r,
        source_now: l,
        matches_source: identical,
        note: identical === false ? 'Live database changed after this backup (new SMS/payments) — expected drift, not a restore failure' : '',
        restored_has_data: !!(r && (typeof r === 'object' ? (r.rows > 0 || r > 0) : r)),
      });
    }

    /* Excluded data must be absent. */
    const presentTables = new Set(restoredMetrics.tables);
    const forbiddenPresent = FORBIDDEN_TABLES.filter(t => presentTables.has(t));
    const leaks = [];
    for (const t of presentTables) {
      let cols;
      try { cols = restored.pragma('table_info(' + qIdent(t) + ')').map(c => c.name); } catch (_) { continue; }
      for (const bad of ['chat_password_hash', 'chat_pin_hash', 'api_key', 'api_secret', 'password_hash_token', 'wallet_address', 'binance_uid']) {
        if (cols.includes(bad)) leaks.push(`${t}.${bad}`);
      }
    }

    /* Referential sanity of the preserved IDs (report-only). */
    const orphans = {};
    const orphanQuery = (name, sql) => {
      try { orphans[name] = Number(restored.prepare(sql).get().c || 0); } catch (_) { orphans[name] = null; }
    };
    orphanQuery('sms_owner_not_in_users', "SELECT COUNT(*) AS c FROM sms_records WHERE COALESCE(manager_id,agent_id,client_id) IS NOT NULL AND COALESCE(manager_id,-1) NOT IN (SELECT id FROM users) AND COALESCE(agent_id,-1) NOT IN (SELECT id FROM users) AND COALESCE(client_id,-1) NOT IN (SELECT id FROM users)");
    orphanQuery('ledger_sms_missing', "SELECT COUNT(*) AS c FROM payment_ledger WHERE sms_record_id IS NOT NULL AND sms_record_id NOT IN (SELECT id FROM sms_records)");
    orphanQuery('sms_range_name_missing', "SELECT COUNT(*) AS c FROM sms_records WHERE range_id IS NOT NULL AND range_id NOT IN (SELECT id FROM ranges_ref)");

    const restoreOk = String(integrity) === 'ok'
      && appId === APPLICATION_ID
      && meta.backup_format === BACKUP_FORMAT
      && forbiddenPresent.length === 0
      && leaks.length === 0;

    const result = {
      ok: restoreOk,
      kind: 'business',
      backup: { file: fileName, size: fs.statSync(fullPath).size, created_at: meta.created_at || '', version: Number(meta.backup_version || 0), format: meta.backup_format || '' },
      restored_to: os.tmpdir() + ' (isolated, deleted after test)',
      live_database_touched: false,
      integrity_check: String(integrity),
      application_id: appId,
      version_marker: Number(meta.backup_version || 0),
      timestamp_marker: meta.created_at || '',
      uk_timestamp: meta.created_at_uk || '',
      comparisons,
      excluded_tables_present: forbiddenPresent,
      sensitive_columns_present: leaks,
      orphan_counts: orphans,
      duration_ms: Date.now() - started,
    };
    return result;
  } finally {
    try { if (restored) restored.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ *
 * Full safety snapshot (only used before restoring a LEGACY full image)
 * ------------------------------------------------------------------ */
function createFullSnapshot(db, reason = 'pre-restore-safety') {
  const dir = ensureBackupDir();
  const file = `${BACKUP_PREFIX}${ts()}-full.sqlite`;
  const fullPath = path.join(dir, file);
  const partPath = fullPath + PARTIAL_SUFFIX;
  activeWrites.add(partPath);
  try {
    if (db && db.inTransaction && db.inTransaction()) throw new Error('Cannot snapshot while a write transaction is open');
    db.exec(`VACUUM INTO ${qLiteral(partPath)}`);
    const probe = new Database(partPath, { readonly: true, fileMustExist: true });
    try {
      const check = probe.pragma('integrity_check', { simple: true });
      if (String(check) !== 'ok') throw new Error('integrity_check failed: ' + check);
    } finally { probe.close(); }
    fsyncFile(partPath);
    fs.renameSync(partPath, fullPath);
    fsyncDir(dir);
    return { file, size: fs.statSync(fullPath).size, kind: 'full', reason, created_at: new Date().toISOString() };
  } finally {
    activeWrites.delete(partPath);
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (_) {}
  }
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  APPLICATION_ID,
  SPEC,
  RELATIONS,
  FORBIDDEN_TABLES,
  BACKUP_PREFIX,
  LEGACY_BACKUP_PREFIXES,
  BACKUP_NAME_RE,
  isBackupFileName,
  getBackupDir,
  ensureBackupDir,
  safeBackupName,
  backupPath,
  detectBackupKind,
  createBusinessBackup,
  createFullSnapshot,
  validateBackupFile,
  verifyRestoreTest,
  collectMetrics,
  cleanupOldBackups,
  retentionCutoff,
  retentionInfo,
  retentionMonths,
  subtractCalendarMonths,
  decimalAdd,
  decimalToString,
  decimalParts,
  isActiveWrite: p => activeWrites.has(p),
};
