/**
 * NEXORA — Creator Account registration + Admin Request Panel.
 *
 * Self-service registration for people who want an Agent or Manager panel.
 * Every request must carry real application-testing proof: an uploaded
 * screenshot plus the CLI shown in that screenshot.
 *
 * Design rules (deliberately minimal, nothing existing is rebuilt):
 *   • one new table  -> creator_requests
 *   • screenshots are written OUTSIDE the public web root and are only ever
 *     streamed to a signed-in Admin through an authenticated route
 *   • uploads are validated by magic bytes on the server, never by the
 *     browser-supplied mime type or filename
 *   • an approved request creates the user with the EXISTING users table and
 *     role system; nothing about permissions is reimplemented here
 *
 * Routes
 *   POST /api/creator/register            (public, rate limited)   multipart
 *   GET  /api/creator/screenshot/:id      (admin)                   private image
 *   GET  /api/creator/requests            (admin)                   list + filters
 *   GET  /api/creator/requests/:id        (admin)                   full detail
 *   POST /api/creator/requests/:id/approve(admin)
 *   POST /api/creator/requests/:id/reject (admin)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = Math.max(1, parseInt(process.env.CREATOR_MAX_UPLOAD_MB || '8', 10) || 8) * 1024 * 1024;
const ALLOWED = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};
/* Two open requests per IP per rolling day — the documented business rule. */
const IP_LIMIT = Math.max(1, parseInt(process.env.CREATOR_IP_LIMIT || '2', 10) || 2);
const IP_WINDOW_HOURS = Math.max(1, parseInt(process.env.CREATOR_IP_WINDOW_HOURS || '24', 10) || 24);

/* Accepted dial codes are whatever the browser sends; this only sanity-checks
   the shape, so a legitimately new country never gets blocked. */
const PHONE_RE = /^\+?[0-9][0-9\s\-()]{5,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

module.exports = function creatorRequests(app, ctx) {
  const { db, authRequired, requireRole, logAction } = ctx;
  const admin = [authRequired, requireRole('admin')];

  /* ------------------------------------------------------------------ *
   * Upload location — outside the static web root on purpose.
   * ------------------------------------------------------------------ */
  const LEGACY_UPLOAD_DIR = path.join(__dirname, 'creator-uploads');
  const DEFAULT_UPLOAD_DIR = path.join(process.env.DATA_DIR || path.dirname(process.env.DB_FILE || path.join(__dirname, 'data.sqlite')), 'creator-uploads');

  /* Make sure a directory exists AND is writable. A deployment sometimes ships
     CREATOR_UPLOAD_DIR pointing at a path the panel user cannot write (root
     owned, or a typo), which used to fail silently: the request was stored but
     the file was never written, so the Admin saw "Screenshot Not Available". */
  function ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  let UPLOAD_DIR = path.resolve(String(process.env.CREATOR_UPLOAD_DIR || DEFAULT_UPLOAD_DIR));
  if (!ensureDir(UPLOAD_DIR)) {
    console.warn('[creator] upload dir not usable (' + UPLOAD_DIR + ') — falling back to ' + DEFAULT_UPLOAD_DIR);
    UPLOAD_DIR = path.resolve(DEFAULT_UPLOAD_DIR);
    if (!ensureDir(UPLOAD_DIR)) {
      console.error('[creator] cannot create ANY upload dir — screenshots will fail until fixed: ' + UPLOAD_DIR);
    }
  }
  console.log('• Creator screenshots:', UPLOAD_DIR);

  /* ------------------------------------------------------------------ *
   * Schema (idempotent) — called once at startup from this module.
   * ------------------------------------------------------------------ */
  function ensureSchema() {
    /* Must run AFTER db.init() — server.js calls it from start(). */
    try { db.run('SELECT 1'); } catch (e) { return; }
    db.run(`CREATE TABLE IF NOT EXISTS creator_requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name          TEXT NOT NULL,
      username           TEXT NOT NULL,
      email              TEXT NOT NULL,
      country            TEXT NOT NULL,
      phone_code         TEXT DEFAULT '',
      phone              TEXT NOT NULL,
      requested_role     TEXT NOT NULL,          -- agent | manager
      password_hash      TEXT NOT NULL,          -- bcrypt, never plain
      cli                TEXT NOT NULL,
      note               TEXT DEFAULT '',
      screenshot_path    TEXT NOT NULL,          -- stored filename only
      screenshot_orig    TEXT DEFAULT '',        -- original upload name
      screenshot_mime    TEXT DEFAULT '',
      screenshot_size    INTEGER DEFAULT 0,
      screenshot_width   INTEGER DEFAULT 0,
      screenshot_height  INTEGER DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'Pending', -- Pending | Approved | Rejected
      review_note        TEXT DEFAULT '',
      reviewed_by        INTEGER,
      reviewed_at        TEXT,
      created_user_id    INTEGER,
      reg_ip             TEXT DEFAULT '',
      reg_user_agent     TEXT DEFAULT '',
      created_at         TEXT DEFAULT (datetime('now'))
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_creator_req_status ON creator_requests(status)');
    db.run('CREATE INDEX IF NOT EXISTS idx_creator_req_ip ON creator_requests(reg_ip, created_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_creator_req_created ON creator_requests(created_at)');
  }

  /* ------------------------------------------------------------------ *
   * Helpers
   * ------------------------------------------------------------------ */
  /* Where is this stored screenshot actually on disk?
     Checks (in order) the configured dir, the built-in dir and the data dir, so
     a request submitted before the folder was moved still resolves. */
  function resolveStored(name) {
    const bare = path.basename(String(name || ''));
    if (!bare) return null;
    const dirs = [
      UPLOAD_DIR,
      path.resolve(DEFAULT_UPLOAD_DIR),
      path.resolve(LEGACY_UPLOAD_DIR),
      path.resolve(path.join(process.env.DATA_DIR || __dirname, 'creator-uploads')),
    ];
    for (const d of dirs) {
      const full = path.join(d, bare);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (e) {}
    }
    return null;
  }

  const str = (v, max) => String(v == null ? '' : v).replace(/\u0000/g, '').trim().slice(0, max);
  const clientIp = req => String(
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || (req.connection && req.connection.remoteAddress) || 'unknown'
  ).slice(0, 64);

  function publicRow(r) {
    return {
      id: r.id,
      full_name: r.full_name,
      username: r.username,
      email: r.email,
      country: r.country,
      phone_code: r.phone_code || '',
      phone: r.phone,
      requested_role: r.requested_role,
      cli: r.cli,
      note: r.note || '',
      status: r.status,
      review_note: r.review_note || '',
      created_at: r.created_at,
      reviewed_at: r.reviewed_at || '',
      reg_ip: r.reg_ip || '',
      /* the image is fetched through an authenticated route, never a public URL */
      screenshot: {
        available: !!r.screenshot_path,
        url: '/api/creator/screenshot/' + r.id,
        original_name: r.screenshot_orig || '',
        mime: r.screenshot_mime || '',
        size: r.screenshot_size || 0,
        width: r.screenshot_width || 0,
        height: r.screenshot_height || 0,
      },
    };
  }

  /* ------------------------------------------------------------------ *
   * POST /api/creator/register  (public — no token required)
   * ------------------------------------------------------------------ */
  const registerLimiter = ctx.rateLimit
    ? ctx.rateLimit({ windowMs: 10 * 60000, max: 12, keyFn: req => 'creator:' + clientIp(req) })
    : (req, res, next) => next();

  app.post('/api/creator/register', registerLimiter, ctx.rawUpload({
    maxBytes: MAX_BYTES,
    field: 'screenshot',
  }), (req, res) => {
    const b = req.body || {};
    const ip = clientIp(req);

    /* ---- 1. every mandatory field, checked server-side ---- */
    const fullName = str(b.full_name, 120);
    const username = str(b.username, 32);
    const email = str(b.email, 160);
    const country = str(b.country, 80);
    const phoneCode = str(b.phone_code, 8);
    const phoneRaw = str(b.phone, 32);
    const role = str(b.requested_role, 16).toLowerCase();
    const chatCode=String(b.chat_security_code||'');
    if(role!=='agent')return res.status(400).json({error:'Public registration is for Agent accounts only.'});
    if(!/^\d{6}$/.test(chatCode))return res.status(400).json({error:'Chat Security Code must contain exactly six numeric digits.',field:'chat_security_code'});
    const cli = str(b.cli, 190);
    const note = str(b.note, 2000);
    const password = String(b.password == null ? '' : b.password);
    const confirm = String(b.confirm_password == null ? '' : b.confirm_password);

    const missing = [];
    if (!fullName) missing.push('Full Name');
    if (!username) missing.push('Username');
    if (!email) missing.push('Email Address');
    if (!country) missing.push('Country');
    if (!phoneRaw) missing.push('Phone Number');
    if (!password) missing.push('Password');
    if (!confirm) missing.push('Confirm Password');
    if (!role) missing.push('Requested Account Type');
    if (!cli) missing.push('CLI');
    if (!req.file) missing.push('Application Testing Screenshot');

    if (missing.length) {
      return res.status(400).json({
        error: 'Please complete every required field: ' + missing.join(', ') + '.',
        fields: missing,
      });
    }

    /* ---- 2. field validation ---- */
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3–32 characters (letters, numbers, dot, dash or underscore).', field: 'username' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.', field: 'email' });
    }
    if (phoneRaw.replace(/\D/g, '').length < 6) {
      return res.status(400).json({ error: 'Please enter a valid phone number.', field: 'phone' });
    }
    if (!PHONE_RE.test((phoneCode + phoneRaw).replace(/\s+/g, ' ').trim())) {
      return res.status(400).json({ error: 'Please enter a valid phone number.', field: 'phone' });
    }
    if (role !== 'agent' && role !== 'manager') {
      return res.status(400).json({ error: 'Requested Account Type must be Agent or Manager.', field: 'requested_role' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.', field: 'password' });
    }
    if (password !== confirm) {
      return res.status(400).json({ error: 'Password and Confirm Password do not match.', field: 'confirm_password' });
    }
    if (cli.length < 2) {
      return res.status(400).json({ error: 'Please enter the CLI of the application you tested.', field: 'cli' });
    }

    /* ---- 3. screenshot: real image, allowed type, size ---- */
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) {
      return res.status(400).json({ error: 'Application Testing Screenshot is required.', field: 'screenshot' });
    }
    if (file.buffer.length > MAX_BYTES) {
      return res.status(413).json({ error: `Screenshot is too large (max ${Math.round(MAX_BYTES / 1048576)} MB).`, field: 'screenshot' });
    }
    const realType = sniff(file.buffer);
    if (!realType || !ALLOWED[realType]) {
      return res.status(400).json({ error: 'Screenshot must be a PNG, JPG, JPEG or WEBP image.', field: 'screenshot' });
    }

    /* ---- 4. duplicates + the two-requests-per-IP rule ---- */
    const clash = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [username])
      || db.get("SELECT id FROM creator_requests WHERE username=? COLLATE NOCASE AND status='Pending'", [username]);
    if (clash) {
      return res.status(409).json({ error: 'This username is already taken or already has a pending request.', field: 'username' });
    }
    const recent = db.get(
      `SELECT COUNT(*) c FROM creator_requests WHERE reg_ip=? AND datetime(created_at) > datetime('now', ?)`,
      [ip, '-' + IP_WINDOW_HOURS + ' hours']
    );
    if (recent && recent.c >= IP_LIMIT) {
      return res.status(429).json({
        error: `Only ${IP_LIMIT} registration requests are allowed from one IP address per ${IP_WINDOW_HOURS} hours.`,
      });
    }

    /* ---- 5. store the image under a random name, never a user path ---- */
    const stored = crypto.randomBytes(18).toString('hex') + ALLOWED[realType];
    const fullPath = path.join(UPLOAD_DIR, stored);
    try {
      fs.writeFileSync(fullPath, file.buffer, { mode: 0o600 });
      /* prove it is really on disk before telling the applicant it worked */
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size !== file.buffer.length) {
        throw new Error('write verification failed');
      }
    } catch (e) {
      console.error('[creator] screenshot write failed:', e.message, fullPath);
      return res.status(500).json({ error: 'Could not store the screenshot on the server. Please try again or contact the administrator.' });
    }

    /* ---- 6. one row = the whole request ---- */
    try {
      const bcrypt = require('bcryptjs');
      const hash = bcrypt.hashSync(password, 10);
      const info = db.run(
        `INSERT INTO creator_requests
           (full_name, username, email, country, phone_code, phone, requested_role,
            password_hash, cli, note, screenshot_path, screenshot_orig, screenshot_mime,
            screenshot_size, screenshot_width, screenshot_height, status, reg_ip, reg_user_agent, chat_code_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Pending', ?, ?, ?)`,
        [fullName, username, email, country, phoneCode, phoneRaw, role,
         hash, cli, note, stored,
         str(file.originalname, 200), realType,
         file.buffer.length, 0, 0, ip, str(req.headers['user-agent'], 300), bcrypt.hashSync(chatCode,12)]
      );
      res.status(201).json({
        ok: true,
        id: info.lastInsertRowid,
        message: 'Your registration request has been submitted. An administrator will review your testing proof and respond.',
      });
    } catch (e) {
      try { fs.unlinkSync(fullPath); } catch (_) {}
      res.status(500).json({ error: 'Could not save the request. Please try again.' });
    }
  });

  /* ------------------------------------------------------------------ *
   * GET /api/creator/screenshot/:id   (admin only, private bytes)
   * ------------------------------------------------------------------ */
  app.get('/api/creator/screenshot/:id', admin, (req, res) => {
    const r = db.get('SELECT screenshot_path, screenshot_mime, screenshot_orig FROM creator_requests WHERE id=?', [req.params.id]);
    if (!r || !r.screenshot_path) return res.status(404).json({ error: 'No screenshot for this request' });

    /* the stored name is generated by us (hex + known extension), but still
       refuse anything that is not a bare filename */
    const name = path.basename(String(r.screenshot_path));
    if (!name || name !== String(r.screenshot_path)) {
      return res.status(400).json({ error: 'Invalid screenshot reference.' });
    }
    const full = resolveStored(name);
    if (!full) {
      console.warn('[creator] screenshot missing on disk:', name, '(looked in ' + UPLOAD_DIR + ')');
      return res.status(404).json({
        error: 'The screenshot file for this request is missing from the server. '
             + 'It may have been uploaded before the upload folder was configured — check CREATOR_UPLOAD_DIR.',
      });
    }

    // Old rows can lack MIME metadata. Determine the type from actual bytes,
    // without rewriting historical records or trusting filenames.
    let type;
    try {
      const fd = fs.openSync(full, 'r');
      try { const head = Buffer.alloc(16); const n = fs.readSync(fd, head, 0, 16, 0); type = sniff(head.subarray(0, n)); }
      finally { fs.closeSync(fd); }
    } catch (e) { return res.status(500).json({ error: 'Screenshot cannot be read from storage.' }); }
    if (!type) return res.status(415).json({ error: 'Stored screenshot is not a supported image.' });
    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline' + (r.screenshot_orig ? `; filename="${String(r.screenshot_orig).replace(/[^a-zA-Z0-9._ -]/g, '_')}"` : ''));
    res.setHeader('Cache-Control', 'private, no-store');
    fs.createReadStream(full).on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); }).pipe(res);
  });

  /* ------------------------------------------------------------------ *
   * GET /api/creator/requests  — list, filter, search
   * ------------------------------------------------------------------ */
  app.get('/api/creator/requests', admin, (req, res) => {
    const status = str(req.query.status, 20);
    const q = str(req.query.q, 80);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10) || 100));

    const where = [];
    const args = [];
    if (status && status !== 'All') { where.push('status = ?'); args.push(status); }
    if (q) {
      where.push('(full_name LIKE ? OR username LIKE ? OR email LIKE ? OR cli LIKE ? OR phone LIKE ?)');
      const like = '%' + q + '%';
      args.push(like, like, like, like, like);
    }
    const sql = 'SELECT * FROM creator_requests'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY datetime(created_at) DESC, id DESC LIMIT ?';
    args.push(limit);

    const rows = db.all(sql, args) || [];
    const counts = db.all("SELECT status, COUNT(*) c FROM creator_requests GROUP BY status") || [];
    const tally = { Pending: 0, Approved: 0, Rejected: 0 };
    counts.forEach(c => { if (tally[c.status] != null) tally[c.status] = c.c; });

    res.json({ rows: rows.map(publicRow), counts: tally, total: rows.length });
  });

  /* ------------------------------------------------------------------ *
   * GET /api/creator/requests/:id  — full detail for the review panel
   * ------------------------------------------------------------------ */
  app.get('/api/creator/requests/:id', admin, (req, res) => {
    const r = db.get('SELECT * FROM creator_requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    const out = publicRow(r);
    out.reviewed_by_name = '';
    if (r.reviewed_by) {
      const u = db.get('SELECT username, name FROM users WHERE id=?', [r.reviewed_by]);
      if (u) out.reviewed_by_name = u.name || u.username;
    }
    out.created_user_id = r.created_user_id || null;
    res.json(out);
  });

  /* ------------------------------------------------------------------ *
   * POST /api/creator/requests/:id/approve
   * ------------------------------------------------------------------ */
  app.post('/api/creator/requests/:id/approve', admin, (req, res) => {
    const r = db.get('SELECT * FROM creator_requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'Pending') return res.status(409).json({ error: 'This request has already been ' + r.status.toLowerCase() + '.' });

    /* a request without testing proof can never be approved */
    if (!r.screenshot_path || !r.cli) {
      return res.status(400).json({ error: 'This request has no application testing proof and cannot be approved.' });
    }
    const taken = db.get('SELECT id FROM users WHERE username=? COLLATE NOCASE', [r.username]);
    if (taken) return res.status(409).json({ error: 'A user with this username already exists. Reject the request or use a different username.' });

    const review = str((req.body || {}).review_note, 500);
    try {
      db.exec('BEGIN IMMEDIATE');
      /* Account, code activation and approval are one atomic change. */
      /* the EXISTING users table + role model is used unchanged */
      const info = db.run(
        'INSERT INTO users (username,password,role,name,email,contact,parent_id,active) VALUES (?,?,?,?,?,?,?,1)',
        [r.username, r.password_hash, r.requested_role, r.full_name, r.email, (r.phone_code || '') + r.phone, null]
      );
      const newId = info.lastInsertRowid;
      if(r.requested_role==='agent'&&r.chat_code_hash)db.run('INSERT INTO chat_app_codes(user_id,hash,active) VALUES(?,?,1)',[newId,r.chat_code_hash]);
      db.run(
        "UPDATE creator_requests SET status='Approved', reviewed_by=?, reviewed_at=datetime('now'), review_note=?, created_user_id=? WHERE id=?",
        [req.user.id, review, newId, r.id]
      );
      db.exec('COMMIT');
      try { logAction(req, 'creator_request_approve', 'creator_requests', { id: r.id, username: r.username, role: r.requested_role }); } catch (_) {}
      res.json({ ok: true, user_id: newId, message: `${r.requested_role === 'manager' ? 'Manager' : 'Agent'} account “${r.username}” created and activated.` });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      res.status(500).json({ error: 'Could not create the account: ' + e.message });
    }
  });

  /* ------------------------------------------------------------------ *
   * POST /api/creator/requests/:id/reject
   * ------------------------------------------------------------------ */
  app.post('/api/creator/requests/:id/reject', admin, (req, res) => {
    const r = db.get('SELECT * FROM creator_requests WHERE id=?', [req.params.id]);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'Pending') return res.status(409).json({ error: 'This request has already been ' + r.status.toLowerCase() + '.' });

    const review = str((req.body || {}).review_note, 500);
    db.run(
      "UPDATE creator_requests SET status='Rejected', reviewed_by=?, reviewed_at=datetime('now'), review_note=? WHERE id=?",
      [req.user.id, review, r.id]
    );
    try { logAction(req, 'creator_request_reject', 'creator_requests', { id: r.id, username: r.username }); } catch (_) {}
    /* the record, the screenshot, the CLI and the note stay for later review */
    res.json({ ok: true, message: 'Request rejected. The record and its testing proof have been kept for review.' });
  });

  /* ------------------------------------------------------------------ *
   * GET /api/creator/diagnostics  (admin)
   * One click answer to "why can I not see the screenshot?" — read only.
   * ------------------------------------------------------------------ */
  app.get('/api/creator/diagnostics', admin, (req, res) => {
    const rows = db.all(
      "SELECT id, username, screenshot_path, screenshot_size, created_at FROM creator_requests ORDER BY id DESC LIMIT 500"
    ) || [];
    let ok = 0;
    const missing = [];
    for (const r of rows) {
      if (resolveStored(r.screenshot_path)) ok++;
      else missing.push({ id: r.id, username: r.username, stored: r.screenshot_path, created_at: r.created_at });
    }
    res.json({
      ok: true,
      upload_dir: UPLOAD_DIR,
      upload_dir_writable: ensureDir(UPLOAD_DIR),
      default_dir_exists: (() => { try { return fs.existsSync(DEFAULT_UPLOAD_DIR); } catch (e) { return false; } })(),
      total_requests: rows.length,
      screenshots_found: ok,
      screenshots_missing: missing.length,
      missing: missing.slice(0, 50),
    });
  });

  return {
    ensureSchema,
    UPLOAD_DIR,
    /* used by the admin health check */
    info: () => ({ dir: UPLOAD_DIR, writable: ensureDir(UPLOAD_DIR), resolve: resolveStored }),
  };
};
