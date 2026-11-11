/* nexora-dashboard.js — paints the NEXORA hero (KPI cards, OTP graph, weekly + monthly report)
 * into #nexoraDash. PRESENTATION ONLY: it makes no request, writes nothing and never changes a
 * value — it only formats what admin.html's nexoraRenderDashboard() hands it in cfg.
 * Entry point: window.NexoraDashboard.render(cfg)
 *   cfg = { root, role, name, dashboard, earnings, dailyRows, monthly }
 */
(function () {
  'use strict';
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var state = { mode: 'daily' }, LAST = null;

  function esc(v){ return String(v == null ? '' : v).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function num(v){ var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v){ return v != null && v !== '' && isFinite(Number(v)); }
  function cnt(v){ return has(v) ? Number(v).toLocaleString() : '\u2014'; }
  function money(v){
    if (!has(v)) return '\u2014';
    return '$' + (typeof window.pay3 === 'function' ? window.pay3(v) : Number(v).toFixed(4));
  }
  function pick(r, keys){ for (var i = 0; i < keys.length; i++) if (r && r[keys[i]] != null && r[keys[i]] !== '') return r[keys[i]]; return null; }
  function pd(s){ var p = String(s).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function dm(s){ var t = pd(s); return t.getUTCDate() + ' ' + MON[t.getUTCMonth()]; }
  function dwdm(s){ var t = pd(s); return DOW[t.getUTCDay()] + ' ' + dm(s); }
  function monthKey(s){ return String(s).slice(0, 7); }
  function prevMonthKey(k){ var y = +k.slice(0,4), m = +k.slice(5,7) - 1; if (m < 1) { y--; m = 12; } return y + '-' + (m < 10 ? '0' : '') + m; }
  function monthLabel(k){ return MON[+k.slice(5,7) - 1] + ' ' + k.slice(0,4); }

  function delta(cur, prev, vs){
    cur = num(cur); prev = num(prev);
    if (prev > 0) {
      var p = Math.round((cur - prev) / prev * 100);
      if (p > 0) return { c: '', t: '\u25B2 ' + p + '% vs ' + vs };
      if (p < 0) return { c: 'dn', t: '\u25BC ' + Math.abs(p) + '% vs ' + vs };
      return { c: 'eq', t: '\u2013 No change vs ' + vs };
    }
    if (cur > 0) return { c: '', t: '\u25B2 100% vs ' + vs };
    return { c: 'eq', t: '\u2013 No change vs ' + vs };
  }

  var ICON = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8.5 10h.01M12 10h.01M15.5 10h.01"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01"/>',
    coin: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    bars: '<path d="M4 20h16M7 20v-7M12 20V6M17 20v-10"/><path d="M5 9l5-4 4 3 5-5"/>'
  };
  function ico(k){ return '<span class="nx-ico"><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg></span>'; }

  function series(cfg){
    var map = {}, d = cfg.dashboard || {}, es = cfg.earnings || {};
    function add(r, key, field){ if (r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) { var o = map[r.date] = map[r.date] || { date: r.date, sms: 0, amt: 0 }; o[key] = num(r[field]); } }
    if (Array.isArray(cfg.dailyRows) && cfg.dailyRows.length) {
      cfg.dailyRows.forEach(function(r){ add(r, 'sms', 'count'); if (r && r.amount != null) add(r, 'amt', 'amount'); });
    } else {
      (d.daily7 || []).forEach(function(r){ add(r, 'sms', 'count'); });
      (es.daily7 || []).forEach(function(r){ add(r, 'amt', 'amount'); });
    }
    return Object.keys(map).sort().map(function(k){ return map[k]; });
  }

  function niceStep(maxV){
    if (maxV <= 5) return 1;
    var raw = maxV / 5, p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  function chart(pts){
    if (!pts.length) return '<div class="nx-empty">No data available yet.</div>';
    var W = 720, H = 300, L = 42, R = 16, T = 14, B = 34, maxV = 0;
    pts.forEach(function(p){ if (p.v > maxV) maxV = p.v; });
    var step = niceStep(maxV), max = step * 5, n = pts.length;
    var x = function(i){ return n === 1 ? (L + W - R) / 2 : L + 8 + i * (W - L - R - 16) / (n - 1); };
    var y = function(v){ return H - B - v * (H - T - B) / max; };
    var g = '';
    for (var i = 0; i <= 5; i++) { var yy = y(step * i); g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="#e3edff"/><text x="' + (L - 10) + '" y="' + (yy + 4) + '" text-anchor="end">' + Math.round(step * i * 100) / 100 + '</text>'; }
    var every = Math.ceil(n / 6), xs = '';
    pts.forEach(function(p, i){
      if (i % every === 0 || i === n - 1) xs += '<line x1="' + x(i) + '" x2="' + x(i) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#edf3ff"/><text x="' + x(i) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(p.l) + '</text>';
    });
    var line = pts.map(function(p, i){ return x(i) + ',' + y(p.v); }).join(' ');
    var dots = pts.map(function(p, i){ var last = i === n - 1; return '<circle class="pt" cx="' + x(i) + '" cy="' + y(p.v) + '" r="' + (last ? 5 : 3.5) + '"><title>' + esc(p.t) + '</title></circle>'; }).join('');
    return '<svg class="nx-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="SMS graph">' +
      '<defs><linearGradient id="nxArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f8bff" stop-opacity=".38"/><stop offset="1" stop-color="#2f8bff" stop-opacity=".03"/></linearGradient></defs>' +
      g + xs + '<polygon points="' + x(0) + ',' + (H - B) + ' ' + line + ' ' + x(n - 1) + ',' + (H - B) + '" fill="url(#nxArea)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#0a63f0" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>' + dots + '</svg>';
  }

  function weekStart(s){ var t = pd(s), off = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - off); return t.toISOString().slice(0, 10); }

  function graphPoints(rows, monthly){
    if (state.mode === 'weekly') {
      var m = {}, order = [];
      rows.forEach(function(r){ var k = weekStart(r.date); if (!(k in m)) { m[k] = 0; order.push(k); } m[k] += r.sms; });
      return { word: 'week', pts: order.map(function(k){ return { l: dm(k), v: m[k], t: 'Week of ' + dm(k) + ': ' + m[k] + ' SMS' }; }) };
    }
    if (state.mode === 'monthly') {
      var ms = (monthly || []).map(function(r){ return { k: monthKey((r.dims && r.dims.month) || ''), v: num(pick(r, ['sms', 'count', 'total'])) }; })
        .filter(function(r){ return /^\d{4}-\d{2}$/.test(r.k); }).sort(function(a, b){ return a.k < b.k ? -1 : 1; });
      return { word: 'month', pts: ms.map(function(r){ return { l: MON[+r.k.slice(5)-1] + " '" + r.k.slice(2, 4), v: r.v, t: monthLabel(r.k) + ': ' + r.v + ' SMS' }; }) };
    }
    return { word: 'day', pts: rows.map(function(r){ return { l: dm(r.date), v: r.sms, t: dm(r.date) + ': ' + r.sms + ' SMS' }; }) };
  }

  function render(cfg){
    cfg = cfg || {}; LAST = cfg;
    var root = document.getElementById(cfg.root || 'nexoraDash'); if (!root) return;
    var d = cfg.dashboard || {}, es = cfg.earnings || {}, rows = series(cfg), monthly = Array.isArray(cfg.monthly) ? cfg.monthly : null;
    var today = rows.length ? rows[rows.length - 1].date : new Date().toISOString().slice(0, 10);
    var mk = monthKey(today), pk = prevMonthKey(mk);
    var mrow = {}; (monthly || []).forEach(function(r){ var k = monthKey((r.dims && r.dims.month) || ''); mrow[k] = r; });
    function mSms(k){ if (mrow[k]) return num(pick(mrow[k], ['sms', 'count', 'total'])); if (monthly) return 0;
      if (k === mk && rows.length) return rows.filter(function(r){ return monthKey(r.date) === k; }).reduce(function(a, r){ return a + r.sms; }, 0); return null; }
    function mPay(k){ if (mrow[k]) { var v = pick(mrow[k], ['payout', 'payout_amount', 'earning', 'earnings', 'amount']); return v == null ? null : v; } if (monthly) return 0; return null; }

    var smsToday = has(d.sms_today) ? num(d.sms_today) : (rows.length ? rows[rows.length - 1].sms : 0);
    var smsYest = has(d.sms_yesterday) ? num(d.sms_yesterday) : (rows.length > 1 ? rows[rows.length - 2].sms : 0);
    var last7 = rows.slice(-7), prev7 = rows.length >= 14 ? rows.slice(-14, -7) : null;
    var sum7 = last7.reduce(function(a, r){ return a + r.sms; }, 0), sumPrev7 = prev7 ? prev7.reduce(function(a, r){ return a + r.sms; }, 0) : null;
    var thisM = mSms(mk), lastM = mSms(pk);
    var pay7 = has(es.earning_7d) ? es.earning_7d : (has(d.payout_7d) ? d.payout_7d : last7.reduce(function(a, r){ return a + r.amt; }, 0));
    var payMonth = has(es.earning_month) ? es.earning_month : (has(d.payout_month) ? d.payout_month : mPay(mk));
    var payToday = has(es.earning_daily) ? es.earning_daily : d.payout_today;

    var first = String(cfg.name || 'there').trim().split(/\s+/)[0] || 'there';
    var dTod = delta(smsToday, smsYest, 'yesterday');
    var dMon = delta(thisM, lastM, 'last month');
    var dWk = sumPrev7 == null ? null : delta(sum7, sumPrev7, 'week before');
    var k7 = has(d.sms_7d) ? num(d.sms_7d) : sum7;

    var kpis = [
      { i: 'chat', l: 'Today\u2019s SMS', v: cnt(smsToday), s: dTod },
      { i: 'cal',  l: 'This Month', v: cnt(thisM), s: thisM == null ? { c: 'eq', t: 'Month to date' } : dMon },
      { i: 'coin', l: 'Earnings Today', v: money(payToday), s: { c: 'eq', t: 'This month ' + money(payMonth) } },
      { i: 'bars', l: 'Last 7 Days', v: cnt(k7), s: dWk || { c: 'eq', t: 'Rolling 7 days' } }
    ].map(function(k){
      return '<div class="nx-kpi">' + ico(k.i) + '<div class="nx-kpi-txt"><small>' + esc(k.l) + '</small><b>' + esc(k.v) + '</b><span class="nx-delta ' + k.s.c + '">' + esc(k.s.t) + '</span></div></div>';
    }).join('');

    var gp = graphPoints(rows, monthly), tot = 0, bestV = 0, best = '\u2014';
    gp.pts.forEach(function(p){ tot += p.v; if (p.v > bestV) { bestV = p.v; best = p.l; } });
    var tabs = ['daily', 'weekly', 'monthly'].map(function(m){ return '<button type="button" class="nx-tab' + (state.mode === m ? ' on' : '') + '" data-nx-mode="' + m + '">' + m.charAt(0).toUpperCase() + m.slice(1) + '</button>'; }).join('');
    var graph = '<section class="nx-card nx-graph"><div class="nx-head"><h3 class="nx-title"><svg viewBox="0 0 24 24"><path d="M4 20V11M10 20V5M16 20v-6M22 20H2"/></svg>OTP Graph</h3><div class="nx-tabs">' + tabs + '</div></div>' +
      '<div class="nx-stats"><div><small>Today</small><b>' + cnt(smsToday) + '</b></div><div><small>Total</small><b>' + cnt(tot) + '</b></div><div><small>Best ' + gp.word + '</small><b>' + esc(best) + '</b></div></div>' +
      (state.mode === 'monthly' && !monthly ? '<div class="nx-empty">Monthly data is loading\u2026</div>' : chart(gp.pts)) + '</section>';

    var maxW = Math.max.apply(null, [1].concat(last7.map(function(r){ return r.sms; })));
    var days = last7.slice().reverse().map(function(r, i){
      return '<li><span>' + (i === 0 ? 'Today' : esc(dwdm(r.date))) + '</span><div class="nx-bar"><i style="width:' + Math.round(r.sms / maxW * 100) + '%"></i></div><em>' + cnt(r.sms) + '</em></li>';
    }).join('');
    var avg = last7.length ? (sum7 / last7.length).toFixed(1).replace(/\.0$/, '') : '0';
    var week = '<section class="nx-card nx-week"><div class="nx-head"><h3 class="nx-title"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>Weekly Report</h3><span class="nx-pill">Last 7 days</span></div>' +
      '<div class="nx-stats"><div><small>OTPs</small><b>' + cnt(sum7) + '</b></div><div><small>Payout</small><b>' + esc(money(pay7)) + '</b></div><div><small>Daily average</small><b>' + avg + '</b></div></div>' +
      (dWk ? '<span class="nx-chip ' + dWk.c + '">' + esc(dWk.t) + '</span>' : '') + '<ul class="nx-days">' + days + '</ul></section>';

    var keys = [], k = mk; for (var i = 0; i < 6; i++) { keys.push(k); k = prevMonthKey(k); }
    var trs = keys.map(function(key, i){
      var s = mSms(key), p = mPay(key);
      return '<tr class="' + (i === 0 ? 'cur' : '') + '"><td>' + monthLabel(key) + '</td><td>' + esc(money(p)) + '</td><td>' + cnt(s) + '</td></tr>';
    }).join('');
    var mon = '<section class="nx-card nx-month"><div><div class="nx-head"><h3 class="nx-title"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>Monthly Report</h3></div>' +
      '<div class="nx-stats"><div><small>This Month</small><b>' + cnt(thisM) + '</b></div><div><small>Payout</small><b>' + esc(money(payMonth)) + '</b></div><div><small>Last Month</small><b>' + cnt(lastM) + '</b></div></div>' +
      '<span class="nx-chip ' + dMon.c + '">' + esc(dMon.t) + '</span></div>' +
      '<div><div class="nx-head" style="justify-content:flex-end;margin-bottom:6px"><span class="nx-pill">Last 6 months</span></div><table class="nx-mt"><thead><tr><th>Month</th><th>Payout</th><th>OTPs</th></tr></thead><tbody>' + trs + '</tbody></table></div></section>';

    root.innerHTML = '<div class="nx-hero"><div class="nx-greet"><h1>Welcome back, ' + esc(first) + '! \uD83D\uDC4B</h1><p>Here\u2019s your SMS panel overview</p></div><div class="nx-kpis">' + kpis + '</div><div class="nx-grid">' + graph + week + '</div>' + mon + '</div>';

    if (!root._nxBound) {
      root._nxBound = true;
      root.addEventListener('click', function(e){
        var b = e.target.closest && e.target.closest('[data-nx-mode]'); if (!b) return;
        state.mode = b.getAttribute('data-nx-mode'); if (LAST) render(LAST);
      });
    }
  }
  window.NexoraDashboard = { render: render };
})();
