/**
 * Backup service for AMS SMS — BUSINESS DATA BACKUP.
 * ---------------------------------------------------------------------------
 * This module is the stable façade used by backend/server.js and the panel:
 * its public functions keep their previous names and result shapes.
 *
 * What changed (and why):
 *   - createBackup() no longer copies the whole live database. It builds a
 *     small, self-contained business database (accounts, SMS history, range
 *     names, payment ledger, payment requests) via backend/businessBackup.js.
 *     On a database with millions of inventory numbers this is a tiny fraction
 *     of the size, which is what the retention window is now sized for.
 *   - Retention is 5 CALENDAR months (BACKUP_RETENTION_MONTHS), not a number of
 *     days. BACKUP_RETENTION_DAYS is ignored on purpose: it must not be able to
 *     shorten the approved retention window.
 *   - Backups are written to "<name>.sqlite.partial", validated (integrity +
 *     row counts + version marker), fsynced and only then renamed into place.
 *   - A business backup is NOT a full database image, so restoreBackup()
 *     refuses to overwrite the live database with one. It is verified instead
 *     by restore-testing it into an isolated temporary database.
 *   - Legacy full backups (created before this change) are still listed,
 *     downloadable, restorable and pruned by the same retention rule.
 *
 * Logging: file names, sizes and row counts only. No hashes, SMS content or
 * credentials are ever written to the log.
 */
const fs = require('fs');
const path = require('path');
const business = require('./businessBackup');

const BACKUP_PREFIX = business.BACKUP_PREFIX;
const LEGACY_BACKUP_PREFIXES = business.LEGACY_BACKUP_PREFIXES;
/* New backups use "ams-sms-backup-<ts>.sqlite". Backups created under the
   panel's earlier backup prefixes are still listed, restorable and pruned by
   retention — only the prefix differs. */
const BACKUP_NAME_RE = business.BACKUP_NAME_RE;

function isBackupFileName(base) { return business.isBackupFileName(base); }
function getDbFile(db) {
  return db && db.getDbFile ? db.getDbFile() : path.join(__dirname, 'data.sqlite');
}
function getBackupDir(db) { return business.getBackupDir(); }
function ensureBackupDir(db) { return business.ensureBackupDir(); }
function safeBackupName(name) { return business.safeBackupName(name); }
function backupPath(db, fileName) { return business.backupPath(fileName); }

function listBackups(db) {
  const dir = business.ensureBackupDir();
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sqlite') && (f.startsWith(BACKUP_PREFIX) || LEGACY_BACKUP_PREFIXES.some(p => f.startsWith(p))))
    .map(file => {
      const fullPath = path.join(dir, file);
      const st = fs.statSync(fullPath);
      const kind = business.detectBackupKind(fullPath);
      return {
        file,
        size: st.size,
        created_at: st.birthtime.toISOString(),
        modified_at: st.mtime.toISOString(),
        kind,                                        // 'business' | 'full' | 'invalid'
        restorable: kind === 'full',                 // only a full image may replace the live DB
        restore_test: kind === 'business',           // business backups are restore-tested
      };
    })
    .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
}

function createBackup(db, reason = 'manual') {
  if (db && db.save) db.save();
  return business.createBusinessBackup(db, reason);
}

function cleanupOldBackups(db, opts = {}) {
  return business.cleanupOldBackups(opts);
}

function deleteBackup(db, fileName) {
  const fullPath = business.backupPath(fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  if (business.isActiveWrite(fullPath) || business.isActiveWrite(fullPath + '.partial')) {
    const e = new Error('This backup is being written right now — try again in a moment');
    e.status = 409;
    throw e;
  }
  // Refuse to follow a symlink out of the backup directory.
  const st = fs.lstatSync(fullPath);
  if (!st.isFile()) throw new Error('Not a backup file');
  fs.unlinkSync(fullPath);
  return true;
}

function getLatestBackup(db) {
  return listBackups(db)[0] || null;
}

/**
 * Restore is only allowed from a COMPLETE database image.
 * A business backup deliberately does not contain the excluded tables, so
 * replacing the live file with one would destroy them. It is rejected with a
 * 409 and the operator is pointed at the restore test instead.
 */
function restoreBackup(db, fileName) {
  const fullPath = business.backupPath(fileName);
  if (!fs.existsSync(fullPath)) throw new Error('Backup not found');
  const kind = business.detectBackupKind(fullPath);

  if (kind === 'business') {
    const e = new Error(
      'This is a business-data backup (accounts, SMS, payments only). It cannot replace the live database ' +
      'because the excluded tables (inventory, providers, chat, credentials, settings) are not inside it. ' +
      'Use "Restore test" to verify it in an isolated temporary database instead.'
    );
    e.status = 409;
    e.kind = 'business';
    throw e;
  }
  if (kind !== 'full') {
    const e = new Error('This file is not a complete database image and cannot be restored (' + kind + ')');
    e.status = 409;
    e.kind = kind;
    throw e;
  }

  // Always create a FULL safety snapshot before replacing the live database —
  // a business backup is not a rollback point for a full restore.
  const safety = business.createFullSnapshot(db, 'pre-restore-safety');
  if (!db.replaceWithFile) throw new Error('Database restore is not supported by db layer');
  db.replaceWithFile(fullPath);
  return {
    ok: true,
    kind: 'full',
    restored_from: path.basename(fileName),
    safety_backup: safety.file,
  };
}

/** Restore test: materialise a business backup into an isolated temp DB and compare. */
function verifyRestoreTest(db, fileName, opts = {}) {
  return business.verifyRestoreTest(db, fileName, opts);
}

function getRetentionInfo(now = new Date()) {
  return business.retentionInfo(now);
}

function startAutomaticBackups(db, logger = console) {
  const enabled = String(process.env.BACKUP_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.log('• Automatic backups disabled');
    return null;
  }
  const hours = Math.max(1, parseFloat(process.env.BACKUP_INTERVAL_HOURS || '3'));   // interval preserved
  const ms = hours * 60 * 60 * 1000;

  if (process.env.BACKUP_RETENTION_DAYS) {
    logger.log('• Note: BACKUP_RETENTION_DAYS is ignored — retention is ' +
      business.retentionMonths() + ' calendar months (BACKUP_RETENTION_MONTHS)');
  }

  const run = (reason, label) => {
    try {
      const b = createBackup(db, reason);
      const cleanup = cleanupOldBackups(db, { log: logger });
      logger.log('✓ ' + label + ': ' + b.file + (cleanup && cleanup.deleted && cleanup.deleted.length
        ? ' | retention removed ' + cleanup.deleted.length + ' file(s)' : ''));
    } catch (e) {
      if (e && e.code === 'BACKUP_BUSY') return;
      logger.error('Backup error:', e.message);
    }
  };

  // Create a startup backup shortly after boot, then keep the existing interval.
  setTimeout(() => run('startup', 'Startup business backup created'), 15000);
  const timer = setInterval(() => run('auto', 'Auto business backup created'), ms);
  if (timer.unref) timer.unref();
  const info = business.retentionInfo();
  logger.log(`• Automatic business backups enabled: every ${hours} hour(s), dir: ${getBackupDir(db)}, ` +
    `retention: ${info.months} calendar months (cutoff ${info.cutoff.slice(0, 10)})`);
  return timer;
}

module.exports = {
  getBackupDir,
  listBackups,
  createBackup,
  cleanupOldBackups,
  deleteBackup,
  getLatestBackup,
  restoreBackup,
  backupPath,
  startAutomaticBackups,
  /* new surface */
  verifyRestoreTest,
  getRetentionInfo,
  detectBackupKind: business.detectBackupKind,
  createFullSnapshot: business.createFullSnapshot,
  BACKUP_FORMAT: business.BACKUP_FORMAT,
  BACKUP_VERSION: business.BACKUP_VERSION,
};
