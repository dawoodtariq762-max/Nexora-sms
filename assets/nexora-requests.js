/* ============================================================================
   nexora-requests.js — Admin ▸ Request Panel (Creator Account registrations)
   ----------------------------------------------------------------------------
   Presentation + review actions only. Every value comes from
   /api/creator/requests*, and the approve/reject buttons call the existing
   endpoints. The screenshot is fetched with the panel bearer token and shown
   from a blob URL, so the image itself is never publicly reachable.
   ========================================================================== */
(function () {
  'use strict';

  var API_BASE = '';
  var state = { rows: [], counts: { Pending: 0, Approved: 0, Rejected: 0 }, filter: 'All', q: '', busy: false };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function token() {
    try { return sessionStorage.getItem('ams_token') || localStorage.getItem('ams_token') || ''; } catch (e) { return ''; }
  }
  function auth() { return { Authorization: 'Bearer ' + token() }; }
  function when(s) {
    if (!s) return '—';
    var d = new Date(String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(s);
    var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getUTCDate()) + ' ' + mon[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' · ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  }
  function badge(status) {
    var cls = status === 'Approved' ? 'ap' : status === 'Rejected' ? 'rj' : 'pd';
    return '<span class="nxr-badge ' + cls + '">' + esc(status) + '</span>';
  }

  /* ------------------------------------------------------------------ *
   * Styles (scoped to #page-requests / #nxrModal)
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if ($('nxrStyles')) return;
    var css = document.createElement('style');
    css.id = 'nxrStyles';
    css.textContent = [
      '#page-requests .nxr-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}',
      '#page-requests .nxr-tabs{display:flex;gap:6px;background:#f2f6fc;border:1px solid #e4ebf6;border-radius:999px;padding:4px}',
      '#page-requests .nxr-tab{border:0;background:transparent;border-radius:999px;padding:7px 14px;font:inherit;font-size:12.5px;font-weight:700;color:#5a6f92;cursor:pointer;white-space:nowrap}',
      '#page-requests .nxr-tab.on{background:#1160e8;color:#fff;box-shadow:0 4px 12px rgba(17,96,232,.28)}',
      '#page-requests .nxr-tab b{font-weight:800}',
      '#page-requests .nxr-search{margin-left:auto;display:flex;align-items:center;gap:8px}',
      '#page-requests .nxr-search input{min-height:38px;border:1px solid #d5e0f0;border-radius:10px;padding:0 12px;font:inherit;font-size:13px;background:#f7fafe;min-width:240px}',
      '#page-requests .nxr-search input:focus{outline:0;border-color:#1160e8;background:#fff;box-shadow:0 0 0 3px rgba(17,96,232,.14)}',
      '.nxr-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.02em}',
      '.nxr-badge.pd{background:#fff6e6;color:#a86a08}',
      '.nxr-badge.ap{background:#e8f8f0;color:#0a7c56}',
      '.nxr-badge.rj{background:#ffeef1;color:#a02234}',
      '#page-requests .nxr-cli{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;background:#eaf1fe;color:#0f4ba8;border-radius:6px;padding:2px 7px;display:inline-block;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}',
      '#page-requests .nxr-empty{text-align:center;padding:34px 16px;color:#6d80a0;font-size:13px}',
      '#page-requests .nxr-shot{width:26px;height:26px;border-radius:7px;background:#eaf1fe;color:#1160e8;display:inline-grid;place-items:center;border:0;cursor:pointer}',
      '#page-requests .nxr-shot svg{width:14px;height:14px}',
      '.nxr-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid #d5e0f0;background:#fff;border-radius:9px;padding:7px 12px;font:inherit;font-size:12.5px;font-weight:700;color:#3f5474;cursor:pointer}',
      '.nxr-btn:hover{background:#f7fafe}',
      '.nxr-btn.pri{background:linear-gradient(135deg,#1160e8,#0f5ae0);border-color:transparent;color:#fff;box-shadow:0 6px 16px rgba(17,96,232,.28)}',
      '.nxr-btn.ok{background:#e8f8f0;border-color:#bfe8d5;color:#0a7c56}',
      '.nxr-btn.bad{background:#ffeef1;border-color:#f3ccd4;color:#a02234}',
      '.nxr-btn:disabled{opacity:.55;cursor:not-allowed}',
      '.nxr-btn svg{width:15px;height:15px}',

      /* detail modal */
      '#nxrModal .nxr-modal{width:min(920px,96vw);max-height:92vh;display:flex;flex-direction:column}',
      '#nxrModal .nxr-body{overflow:auto;padding:0}',
      '#nxrModal .nxr-top{display:flex;gap:16px;padding:18px 22px;border-bottom:1px solid #e4ebf6;align-items:flex-start;flex-wrap:wrap}',
      '#nxrModal .nxr-av{width:46px;height:46px;border-radius:12px;background:linear-gradient(135deg,#1160e8,#0f5ae0);color:#fff;display:grid;place-items:center;font-weight:800;font-size:17px;flex:0 0 46px}',
      '#nxrModal .nxr-who h4{font-size:16px;font-weight:800;margin:0 0 3px}',
      '#nxrModal .nxr-who p{margin:0;font-size:12.5px;color:#6d80a0}',
      '#nxrModal .nxr-top .sp{flex:1 1 auto}',
      '#nxrModal .nxr-grid{display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid #e4ebf6}',
      '#nxrModal .nxr-kv{padding:12px 22px;border-bottom:1px solid #f0f4fa}',
      '#nxrModal .nxr-kv dt{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#6d80a0;margin-bottom:3px}',
      '#nxrModal .nxr-kv dd{margin:0;font-size:13.5px;font-weight:600;color:#0f172a;word-break:break-word}',
      '#nxrModal .nxr-proof{padding:18px 22px;border-bottom:1px solid #e4ebf6}',
      '#nxrModal .nxr-proof h5{margin:0 0 4px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#3f5474}',
      '#nxrModal .nxr-proof .sub{font-size:12px;color:#6d80a0;margin-bottom:12px}',
      '#nxrModal .nxr-figure{border:1px solid #d5e0f0;border-radius:12px;overflow:hidden;background:#f7fafe;position:relative;display:grid;place-items:center;min-height:180px}',
      '#nxrModal .nxr-figure img{display:block;width:100%;height:auto;max-height:460px;object-fit:contain;cursor:zoom-in;background:#f2f6fc}',
      '#nxrModal .nxr-figure .ph{padding:38px 16px;color:#6d80a0;font-size:13px;text-align:center}',
      '#nxrModal .nxr-figure .load{padding:38px 16px;color:#6d80a0;font-size:13px}',
      '#nxrModal .nxr-figbar{display:flex;align-items:center;gap:10px;padding:9px 12px;border-top:1px solid #e4ebf6;background:#fff;font-size:12px;color:#6d80a0;flex-wrap:wrap}',
      '#nxrModal .nxr-figbar .sp{flex:1 1 auto}',
      '#nxrModal .nxr-cli-box{display:flex;align-items:center;gap:10px;border:1px solid #d5e0f0;border-radius:10px;overflow:hidden;background:#fff;margin-top:14px}',
      '#nxrModal .nxr-cli-box .tag{background:#eaf1fe;color:#1160e8;font-weight:800;font-size:11.5px;padding:11px 12px;letter-spacing:.04em}',
      '#nxrModal .nxr-cli-box code{flex:1 1 auto;padding:11px 12px;font-size:13.5px;font-weight:700;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
      '#nxrModal .nxr-note{margin-top:14px;border:1px solid #d5e0f0;border-radius:10px;background:#f7fafe;padding:12px 14px;font-size:13px;color:#22314d;white-space:pre-wrap;line-height:1.55}',
      '#nxrModal .nxr-note.empty{color:#6d80a0;font-style:italic}',
      '#nxrModal .nxr-foot{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid #e4ebf6;flex-wrap:wrap;background:#fff}',
      '#nxrModal .nxr-foot .sp{flex:1 1 auto}',
      '#nxrModal .nxr-foot input{min-height:38px;border:1px solid #d5e0f0;border-radius:9px;padding:0 12px;font:inherit;font-size:12.5px;min-width:200px;flex:1 1 200px;background:#f7fafe}',
      '#nxrModal .nxr-reviewbox{padding:14px 22px;border-top:1px solid #f0f4fa;background:#fff}',
      '#nxrModal .nxr-reviewbox label{display:block;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#6d80a0;margin-bottom:6px}',
      '#nxrModal .nxr-reviewbox input{width:100%;min-height:40px;border:1px solid #d5e0f0;border-radius:9px;padding:0 12px;font:inherit;font-size:13px;background:#f7fafe}',

      /* lightbox */
      '#nxrLight{position:fixed;inset:0;z-index:100000;background:rgba(6,16,38,.92);display:none;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}',
      '#nxrLight.show{display:flex}',
      '#nxrLight img{max-width:96vw;max-height:92vh;width:auto;height:auto;object-fit:contain;border-radius:8px;box-shadow:0 30px 80px rgba(0,0,0,.5);background:#fff}',
      '#nxrLight .close{position:fixed;top:18px;right:20px;width:38px;height:38px;border-radius:50%;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:20px;cursor:pointer;display:grid;place-items:center}',

      'body.ams-dark #page-requests .nxr-tabs{background:#0d1729;border-color:#1e2d45}',
      'body.ams-dark #page-requests .nxr-tab{color:#9fb3cd}',
      'body.ams-dark #page-requests .nxr-search input{background:#0d1729;border-color:#1e2d45;color:#e6eefb}',
      'body.ams-dark #nxrModal .nxr-modal{background:#101b2d;border-color:#1e2d45}',
      'body.ams-dark #nxrModal .nxr-kv dd{color:#e6eefb}',
      'body.ams-dark #nxrModal .nxr-note{background:#0d1729;border-color:#1e2d45;color:#dbe7f7}',
      'body.ams-dark #nxrModal .nxr-foot,body.ams-dark #nxrModal .nxr-reviewbox{background:#101b2d}',
      'body.ams-dark #nxrModal .nxr-foot input,body.ams-dark #nxrModal .nxr-reviewbox input{background:#0d1729;border-color:#1e2d45;color:#e6eefb}',
      'body.ams-dark .nxr-btn{background:#16233a;border-color:#243550;color:#c7d7ee}',
      'body.ams-dark #nxrModal .nxr-figure img{background:#0d1729}',
      '@media(max-width:720px){#nxrModal .nxr-grid{grid-template-columns:1fr}#page-requests .nxr-search{margin-left:0;width:100%}#page-requests .nxr-search input{min-width:0;width:100%}}'
    ].join('\n');
    document.head.appendChild(css);
  }

  /* ------------------------------------------------------------------ *
   * Shell
   * ------------------------------------------------------------------ */
  function shell() {
    var host = $('page-requests');
    if (!host || host.getAttribute('data-nxr') === '1') return host;
    host.setAttribute('data-nxr', '1');
    host.innerHTML =
      '<div class="page-head">' +
        '<div><h2>Request Panel</h2><div class="breadcrumb"><b>Users Master</b> › Creator Accounts</div></div>' +
        '<div class="head-actions">' +
          '<button type="button" class="nxr-btn" id="nxrRefresh">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh</button>' +
        '</div>' +
      '</div>' +
      '<div class="nxr-head">' +
        '<div class="nxr-tabs" id="nxrTabs" role="tablist">' +
          '<button type="button" class="nxr-tab on" data-f="All" role="tab">All <b id="nxrCAll">0</b></button>' +
          '<button type="button" class="nxr-tab" data-f="Pending" role="tab">Pending <b id="nxrCPending">0</b></button>' +
          '<button type="button" class="nxr-tab" data-f="Approved" role="tab">Approved <b id="nxrCApproved">0</b></button>' +
          '<button type="button" class="nxr-tab" data-f="Rejected" role="tab">Rejected <b id="nxrCRejected">0</b></button>' +
        '</div>' +
        '<div class="nxr-search">' +
          '<input type="search" id="nxrQ" placeholder="Search name, username, email, CLI…" />' +
        '</div>' +
      '</div>' +
      '<div class="table-wrap"><div class="tscroll"><table>' +
        '<thead><tr>' +
          '<th>Applicant</th><th>Username</th><th>Type</th><th>Country</th><th>Phone</th>' +
          '<th>CLI</th><th>Submitted</th><th>Status</th><th style="text-align:right">Actions</th>' +
        '</tr></thead>' +
        '<tbody id="nxrBody"><tr><td colspan="9" class="nxr-empty">Loading requests…</td></tr></tbody>' +
      '</table></div></div>' +
      '<div class="table-foot"><div class="muted" id="nxrInfo"></div></div>' +
      '<div class="modal-overlay" id="nxrModal"><div class="modal nxr-modal">' +
        '<div class="modal-head"><h3>Registration Request</h3><button class="modal-close" type="button" id="nxrClose">×</button></div>' +
        '<div class="nxr-body" id="nxrDetail"></div>' +
      '</div></div>' +
      '<div id="nxrLight"><button class="close" type="button" id="nxrLightClose" aria-label="Close preview">×</button><img id="nxrLightImg" alt="Application testing screenshot" /></div>';

    host.querySelectorAll('.nxr-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        host.querySelectorAll('.nxr-tab').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        state.filter = b.getAttribute('data-f');
        load();
      });
    });
    var q = $('nxrQ'), t = null;
    q.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { state.q = q.value.trim(); load(); }, 280);
    });
    $('nxrRefresh').addEventListener('click', load);
    $('nxrClose').addEventListener('click', closeDetail);
    $('nxrModal').addEventListener('click', function (e) { if (e.target === this) closeDetail(); });
    $('nxrLight').addEventListener('click', function (e) { if (e.target.id !== 'nxrLightImg') closeLight(); });
    $('nxrLightClose').addEventListener('click', closeLight);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if ($('nxrLight').classList.contains('show')) return closeLight();
      if ($('nxrModal').classList.contains('show')) return closeDetail();
    });
    return host;
  }

  function closeLight() {
    var l = $('nxrLight'); if (!l) return;
    l.classList.remove('show');
    var img = $('nxrLightImg');
    img.removeAttribute('src');
  }
  var openId = null;
  function closeDetail() {
    var m = $('nxrModal'); if (m) m.classList.remove('show');
    openId = null;
  }

  /* ------------------------------------------------------------------ *
   * List
   * ------------------------------------------------------------------ */
  function load() {
    shell();
    var url = API_BASE + '/api/creator/requests?limit=300' +
      (state.filter && state.filter !== 'All' ? '&status=' + encodeURIComponent(state.filter) : '') +
      (state.q ? '&q=' + encodeURIComponent(state.q) : '');
    fetch(url, { headers: auth() })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Could not load requests');
        state.rows = res.d.rows || [];
        state.counts = res.d.counts || state.counts;
        render();
      })
      .catch(function (e) {
        var tb = $('nxrBody');
        if (tb) tb.innerHTML = '<tr><td colspan="9" class="nxr-empty">' + esc(e.message) + '</td></tr>';
      });
  }

  function render() {
    var c = state.counts || {};
    var setTxt = function (id, v) { var el = $(id); if (el) el.textContent = v || 0; };
    setTxt('nxrCPending', c.Pending); setTxt('nxrCApproved', c.Approved); setTxt('nxrCRejected', c.Rejected);
    setTxt('nxrCAll', (c.Pending || 0) + (c.Approved || 0) + (c.Rejected || 0));

    /* pending counter on the sidebar item */
    var navBadge = document.getElementById('nxrNavBadge');
    if (navBadge) {
      navBadge.textContent = c.Pending || '';
      navBadge.style.display = c.Pending ? 'inline-flex' : 'none';
    }

    var tb = $('nxrBody');
    if (!tb) return;
    if (!state.rows.length) {
      tb.innerHTML = '<tr><td colspan="9" class="nxr-empty">' +
        (state.q || state.filter !== 'All' ? 'No requests match this filter.' : 'No registration requests yet.') +
        '</td></tr>';
    } else {
      tb.innerHTML = state.rows.map(function (r) {
        return '<tr data-id="' + r.id + '">' +
          '<td><b>' + esc(r.full_name) + '</b></td>' +
          '<td>' + esc(r.username) + '</td>' +
          '<td>' + esc(r.requested_role === 'manager' ? 'Manager' : 'Agent') + '</td>' +
          '<td>' + esc(r.country) + '</td>' +
          '<td class="muted">' + esc((r.phone_code || '') + ' ' + r.phone) + '</td>' +
          '<td><span class="nxr-cli" title="' + esc(r.cli) + '">' + esc(r.cli) + '</span></td>' +
          '<td class="muted" style="white-space:nowrap">' + esc(when(r.created_at)) + '</td>' +
          '<td>' + badge(r.status) + '</td>' +
          '<td style="text-align:right;white-space:nowrap">' +
            '<button type="button" class="nxr-shot" data-shot="' + r.id + '" title="View testing screenshot" aria-label="View testing screenshot">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>' +
            '</button> ' +
            '<button type="button" class="nxr-btn" data-view="' + r.id + '" style="margin-left:6px">Review</button>' +
          '</td>' +
        '</tr>';
      }).join('');
      tb.querySelectorAll('[data-view]').forEach(function (b) {
        b.addEventListener('click', function () { openDetail(b.getAttribute('data-view')); });
      });
      tb.querySelectorAll('[data-shot]').forEach(function (b) {
        b.addEventListener('click', function () { openDetail(b.getAttribute('data-shot'), true); });
      });
    }
    var info = $('nxrInfo');
    if (info) info.textContent = 'Showing ' + state.rows.length + ' request(s)' + (state.filter !== 'All' ? ' · ' + state.filter : '');
  }

  /* ------------------------------------------------------------------ *
   * Detail + screenshot
   * ------------------------------------------------------------------ */
  var blobCache = {};

  /* Fetches the private image with the panel token and turns it into a blob
     URL. The HTTP status and the server's own message are carried through, so
     the modal can say WHY an image is unavailable instead of a generic line. */
  function fetchShot(id, bust) {
    var url = API_BASE + '/api/creator/screenshot/' + encodeURIComponent(id) + (bust ? '?t=' + Date.now() : '');
    return fetch(url, { headers: auth(), cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            throw new Error((d && d.error) || ('Screenshot could not be loaded (HTTP ' + r.status + ')'));
          });
        }
        var ct = String(r.headers.get('Content-Type') || '');
        if (ct.indexOf('image/') !== 0) {
          throw new Error('The server returned “' + ct + '” instead of an image.');
        }
        return r.blob();
      });
  }

  function shotUrl(id) {
    if (blobCache[id]) return Promise.resolve(blobCache[id]);
    return fetchShot(id, false)
      .catch(function (first) {
        /* one retry with cache disabled — a stale/aborted first attempt or a
           proxy that answered from cache must not look like a missing file */
        return fetchShot(id, true).catch(function () { throw first; });
      })
      .then(function (b) {
        if (!b || !b.size) throw new Error('The screenshot file is empty on the server.');
        blobCache[id] = URL.createObjectURL(b);
        return blobCache[id];
      });
  }

  function openLight(url) {
    var l = $('nxrLight'); if (!l) return;
    $('nxrLightImg').src = url;
    l.classList.add('show');
  }

  function openDetail(id, focusShot) {
    shell();
    var m = $('nxrModal'), box = $('nxrDetail');
    box.innerHTML = '<div class="nxr-proof"><div class="nxr-figure"><div class="load">Loading request…</div></div></div>';
    m.classList.add('show');

    fetch(API_BASE + '/api/creator/requests/' + encodeURIComponent(id), { headers: auth() })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Could not load the request');
        paint(res.d, focusShot);
      })
      .catch(function (e) {
        box.innerHTML = '<div class="nxr-proof"><div class="nxr-figure"><div class="ph">' + esc(e.message) + '</div></div></div>';
      });
  }

  function paint(r, focusShot) {
    var box = $('nxrDetail');
    var initials = (r.full_name || r.username || '?').trim().charAt(0).toUpperCase();
    var pending = r.status === 'Pending';
    var hasShot = r.screenshot && r.screenshot.available;

    box.innerHTML =
      '<div class="nxr-top">' +
        '<div class="nxr-av">' + esc(initials) + '</div>' +
        '<div class="nxr-who"><h4>' + esc(r.full_name) + '</h4>' +
          '<p>@' + esc(r.username) + ' · requested ' + esc(r.requested_role === 'manager' ? 'Manager' : 'Agent') + ' account</p></div>' +
        '<div class="sp"></div>' + badge(r.status) +
      '</div>' +

      '<div class="nxr-grid">' +
        kv('Full Name', r.full_name) +
        kv('Username', '@' + r.username) +
        kv('Email Address', r.email) +
        kv('Country', r.country) +
        kv('Phone Number', (r.phone_code || '') + ' ' + r.phone) +
        kv('Requested Account Type', r.requested_role === 'manager' ? 'Manager' : 'Agent') +
        kv('Registration Date', when(r.created_at)) +
        kv('Registration IP', r.reg_ip || '—') +
        kv('Request Status', r.status) +
        kv('Reviewed', r.reviewed_at ? when(r.reviewed_at) + (r.reviewed_by_name ? ' · ' + r.reviewed_by_name : '') : '—') +
      '</div>' +

      '<div class="nxr-proof">' +
        '<h5>Application Testing Screenshot</h5>' +
        '<div class="sub">The image the applicant uploaded as proof of testing. Click it to open a larger preview.</div>' +
        '<div class="nxr-figure" id="nxrFigure">' +
          (hasShot ? '<div class="load">Loading screenshot…</div>' : '<div class="ph">No screenshot was attached to this request.</div>') +
        '</div>' +
        (hasShot ? '<div class="nxr-figbar">' +
          '<span>' + esc(r.screenshot.original_name || 'screenshot') + '</span>' +
          '<span>· ' + esc(fmtSize(r.screenshot.size)) + (r.screenshot.mime ? ' · ' + esc(r.screenshot.mime.replace('image/', '').toUpperCase()) : '') + '</span>' +
          '<span class="sp"></span>' +
          '<button type="button" class="nxr-btn" id="nxrZoom">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg> Larger preview</button>' +
          '<a class="nxr-btn" id="nxrDl" download="' + esc(r.screenshot.original_name || ('request-' + r.id)) + '">Download</a>' +
        '</div>' : '') +

        '<div class="nxr-cli-box"><span class="tag">CLI =</span><code>' + esc(r.cli) + '</code></div>' +
        '<h5 style="margin:16px 0 4px">Applicant Note</h5>' +
        (r.note ? '<div class="nxr-note">' + esc(r.note) + '</div>' : '<div class="nxr-note empty">The applicant did not add a note.</div>') +
      '</div>' +

      (r.review_note ? '<div class="nxr-reviewbox"><label>Admin review note</label><div class="nxr-note">' + esc(r.review_note) + '</div></div>' : '') +

      (pending ? '<div class="nxr-reviewbox"><label for="nxrReviewNote">Review note (optional)</label>' +
        '<input type="text" id="nxrReviewNote" maxlength="500" placeholder="Reason or remark saved with this decision" /></div>' : '') +

      '<div class="nxr-foot">' +
        '<span class="muted" style="font-size:12px">' + (pending
          ? 'Review the screenshot and CLI before deciding.'
          : 'This request is already ' + esc(r.status.toLowerCase()) + '.') + '</span>' +
        '<span class="sp"></span>' +
        (pending
          ? '<button type="button" class="nxr-btn bad" id="nxrReject">Reject</button>' +
            '<button type="button" class="nxr-btn ok" id="nxrApprove">Approve &amp; Create Account</button>'
          : '') +
        '<button type="button" class="nxr-btn" id="nxrDone">Close</button>' +
      '</div>';

    function kv(k, v) {
      return '<div class="nxr-kv"><dl style="margin:0"><dt>' + esc(k) + '</dt><dd>' + esc(v || '—') + '</dd></dl></div>';
    }

    $('nxrDone').addEventListener('click', closeDetail);

    if (hasShot) {
      var fig = $('nxrFigure');
      shotUrl(r.id).then(function (url) {
        fig.innerHTML = '<img id="nxrImg" alt="Application testing screenshot for @' + esc(r.username) + '" />';
        var img = $('nxrImg');
        img.src = url;
        if (img.complete) { /* ready */ }
        var zoom = function () { openLight(url); };
        img.addEventListener('click', zoom);
        var z = $('nxrZoom'); if (z) z.addEventListener('click', zoom);
        var dl = $('nxrDl'); if (dl) dl.href = url;
        if (focusShot) setTimeout(zoom, 220);
      }).catch(function (e) {
        fig.innerHTML = '<div class="ph">' + esc(e.message)
          + '<div style="margin-top:10px"><button type="button" class="nxr-btn" id="nxrShotRetry">Try again</button></div></div>';
        var rb = $('nxrShotRetry');
        if (rb) rb.addEventListener('click', function () { delete blobCache[r.id]; paint(r, false); });
      });
    }

    if (pending) {
      $('nxrApprove').addEventListener('click', function () { decide(r, 'approve'); });
      $('nxrReject').addEventListener('click', function () { decide(r, 'reject'); });
    }
  }

  function fmtSize(n) {
    n = Number(n) || 0;
    if (!n) return '—';
    return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function decide(r, action) {
    if (state.busy) return;
    var noteEl = $('nxrReviewNote');
    var note = noteEl ? noteEl.value.trim() : '';
    var verb = action === 'approve' ? 'Approve' : 'Reject';
    var extra = action === 'approve'
      ? '\n\nThis creates and activates the ' + (r.requested_role === 'manager' ? 'Manager' : 'Agent') + ' account “' + r.username + '”.'
      : '\n\nThe request record, screenshot and CLI stay available for review.';
    if (!confirm(verb + ' this request from ' + r.full_name + ' (@' + r.username + ')?' + extra)) return;

    state.busy = true;
    var btns = document.querySelectorAll('#nxrDetail .nxr-foot .nxr-btn');
    btns.forEach(function (b) { if (b.id !== 'nxrDone') b.disabled = true; });

    fetch(API_BASE + '/api/creator/requests/' + encodeURIComponent(r.id) + '/' + action, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
      body: JSON.stringify({ review_note: note })
    })
      .then(function (x) { return x.json().then(function (d) { return { ok: x.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.d.error || 'Action failed');
        closeDetail();
        load();
        toast(res.d.message || (verb + 'd successfully.'));
      })
      .catch(function (e) { alert('❌ ' + e.message); })
      .then(function () {
        state.busy = false;
        btns.forEach(function (b) { b.disabled = false; });
      });
  }

  function toast(msg) {
    var el = document.getElementById('nxrToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nxrToast';
      el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:100001;background:#0f172a;color:#fff;' +
        'padding:12px 16px;border-radius:10px;font:600 13px Inter,system-ui,sans-serif;box-shadow:0 16px 40px rgba(0,0,0,.3);' +
        'opacity:0;transform:translateY(8px);transition:.2s;max-width:min(420px,90vw)';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 3600);
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */
  function mount() {
    injectStyles();
    shell();
    load();
  }
  function pendingCount() {
    return fetch(API_BASE + '/api/creator/requests?limit=1&status=Pending', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (d) { return (d.counts && d.counts.Pending) || 0; })
      .catch(function () { return 0; });
  }

  window.NexoraRequests = { mount: mount, pendingCount: pendingCount, open: function (id) { injectStyles(); shell(); openDetail(id); } };
})();
