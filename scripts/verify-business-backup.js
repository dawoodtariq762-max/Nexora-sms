#!/usr/bin/env node
'use strict';
/**
 * AMS SMS — verify a BUSINESS DATA BACKUP, or preview retention.
 * ---------------------------------------------------------------------------
 * Restore test (default): copies the backup into an ISOLATED temporary
 * database, runs integrity_check, compares account / SMS / number-wise /
 * range-wise / account-wise counts and payment totals with the live database,
 * and confirms the excluded tables are absent. The live database is opened
 * READ-ONLY and is never modified.
 *
 * Retention: with --retention-dry-run nothing is deleted; the report shows
 * exactly which files are older than 5 calendar months. --prune performs the
 * real cleanup (same code path the panel/auto-backup timer uses).
 *
 * Usage (run from the application directory):
 *   node scripts/verify-business-backup.js                 # newest backup
 *   node scripts/verify-business-backup.js --file ams-sms-backup-<ts>.sqlite
 *   node scripts/verify-business-backup.js --json
 *   node scripts/verify-business-backup.js --retention-dry-run
 *
 * Env: BACKUP_DIR, DB_FILE, BACKUP_RETENTION_MONTHS (default 5)
 */
const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const dir = arg('dir') || process.env.BACKUP_DIR
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'backups') : null)
  || path.join(require('os').homedir(), 'ams-sms-backups');
if (arg('dir')) process.env.BACKUP_DIR = String(arg('dir'));

const dbFile = arg('db') || process.env.DB_FILE || path.join(process.cwd(), 'backend', 'data.sqlite');

let business;
try { business = require('../backend/businessBackup'); }
catch (e) {
  console.error('Cannot load backend/businessBackup.js — run this from the application directory:');
  console.error('  cd /root/AMS-SMS && node scripts/verify-business-backup.js');
  process.exit(2);
}

const asJson = !!arg('json');
const out = o => asJson ? console.log(JSON.stringify(o, null, 2)) : null;

function newestBackup() {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(f => business.isBackupFileName(f))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? files[0].f : null;
}

/* ---------------------------------------------------------------- */
if (arg('retention-dry-run') || arg('prune')) {
  const report = business.cleanupOldBackups({ dryRun: !arg('prune') });
  if (asJson) { out(report); }
  else {
    console.log('Backup directory : ' + report.dir);
    console.log('Retention        : ' + report.retention.months + ' calendar months (cutoff ' +
      report.retention.cutoff.slice(0, 10) + ')');
    console.log('Mode             : ' + (arg('prune') ? 'PRUNE (files are being deleted)' : 'DRY RUN (nothing deleted)'));
    console.log('Would delete     : ' + report.deleted.length + (report.deleted.length ? '\n  ' + report.deleted.join('\n  ') : ''));
    console.log('Kept             : ' + report.kept.length);
    console.log('Stale temp files : ' + report.removed_temp.length + (report.removed_temp.length ? '\n  ' + report.removed_temp.join('\n  ') : ''));
    if (report.skipped.length) console.log('Skipped          : ' + report.skipped.map(s => `${s.file} (${s.why})`).join(', '));
    if (report.errors.length) { console.log('Errors           : ' + report.errors.join('; ')); process.exit(1); }
  }
  process.exit(0);
}

/* ---------------------------------------------------------------- */
const file = arg('file') || newestBackup();
if (!file || file === true) {
  console.error('No backup found in ' + dir + ' (use --file <name>)');
  process.exit(2);
}
const full = path.isAbsolute(String(file)) ? String(file) : path.join(dir, String(file));
if (!fs.existsSync(full)) { console.error('Backup not found: ' + full); process.exit(2); }

const kind = business.detectBackupKind(full);
if (kind !== 'business') {
  console.error('Not a business-data backup (kind: ' + kind + '). This tool verifies business backups only.');
  process.exit(2);
}
if (!fs.existsSync(dbFile)) {
  console.warn('! Live database not found at ' + dbFile + ' — comparing against the backup\'s own recorded counts only.');
}

let result;
try {
  result = business.verifyRestoreTest(fs.existsSync(dbFile) ? dbFile : null, path.basename(full));
} catch (e) {
  console.error('Restore test failed: ' + e.message);
  process.exit(1);
}

if (asJson) { out(result); process.exit(result.ok ? 0 : 1); }

const fmt = v => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return (v.rows !== undefined ? v.rows + ' rows' : '—') + (v.amount_total ? ' · ' + v.amount_total : '');
  return String(v);
};
console.log('=========================================================');
console.log(' AMS SMS — business backup restore test');
console.log('=========================================================');
console.log('Backup file     : ' + result.backup.file);
console.log('Backup size     : ' + (result.backup.size / 1024).toFixed(1) + ' KB');
console.log('Version marker  : ' + result.version_marker + '  (' + result.backup.format + ')');
console.log('Timestamp (UTC) : ' + result.timestamp_marker);
console.log('Timestamp (UK)  : ' + result.uk_timestamp);
console.log('Integrity       : ' + result.integrity_check);
console.log('Restored into   : isolated temp database (deleted after the test)');
console.log('Live DB touched : ' + (result.live_database_touched ? 'YES (unexpected)' : 'no — read-only'));
console.log('---------------------------------------------------------');
for (const c of result.comparisons) {
  const mark = c.matches_source === false ? 'DRIFT' : (c.matches_source === true ? 'MATCH' : '  —  ');
  console.log(`${mark}  ${c.metric.padEnd(28)} restored=${fmt(c.restored)}   live=${fmt(c.source_now)}`);
  if (c.note) console.log('       ' + c.note);
}
console.log('---------------------------------------------------------');
console.log('Excluded tables present    : ' + (result.excluded_tables_present.length ? result.excluded_tables_present.join(', ') : 'none ✓'));
console.log('Sensitive columns present  : ' + (result.sensitive_columns_present.length ? result.sensitive_columns_present.join(', ') : 'none ✓'));
console.log('Orphan reference counts    : ' + JSON.stringify(result.orphan_counts));
console.log('---------------------------------------------------------');
console.log((result.ok ? '✓ RESTORE TEST PASSED' : '✗ RESTORE TEST FAILED') + ' in ' + result.duration_ms + ' ms');
process.exit(result.ok ? 0 : 1);
