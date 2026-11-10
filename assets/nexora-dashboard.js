/* ============================================================================
   NEXORA SMS PANEL — Dashboard presentation layer
   ============================================================================
   Rebuilds the dashboard in the NEXORA reference layout using ONLY the data the
   panels already fetch. This file is presentation and nothing else:

     · no fetch() of its own
     · no arithmetic on money — every amount is printed exactly as the API
       returned it (same rule the existing dashboard helpers follow)
     · no auth, storage, routing or business logic
     · never removes an existing widget: it renders the new hero block into a
       container the panel provides and leaves every legacy section intact

   Public surface (window.NexoraDashboard):
     render({ root, role, dashboard, earnings, dailyRows, monthly, topCli,
              name, fallback })       -> paints the whole reference layout
     renderFallback({ root, role, dashboard, earnings, dailyRows, name })
                                       -> hero + graph only (a failed optional
                                          call never blanks the dashboard)
     money(v) / count(v)               -> the shared formatters

   Range selector behaviour: switching Daily / Weekly / Monthly only re-slices
   the series that is ALREADY in memory (the /dashboard/daily rows). No extra
   request is made, no value is recomputed by the client.
   ========================================================================== */
(function () {
  'use strict';

  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var nf = function (v) {
    if (v == null || v === '') return '—';
    var n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : String(v);
  };

  /* Money: reuse the panel formatter when the page exposes one, so the
     dashboard can never disagree with a report. No rounding is introduced. */
  function money(v) {
    if (v == null || v === '') return '—';
    if (typeof window.pay3 === 'function') return '$' + window.pay3(v);
    var n = Number(v);
    if (!Number.isFinite(n)) return '$' + String(v);
    return '$' + (Math.round(n * 1e6) / 1e6).toFixed(3);
  }

  var ICONS = {
    sms: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9 9 0 0 1-3.7-.8L4 21l1.4-4.1a8.3 8.3 0 0 1-1.4-4.6A8.4 8.4 0 0 1 12.5 4 8.4 8.4 0 0 1 21 11.5z"/><path d="M8.5 11.5h7M8.5 14.5h4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h3M8 17.5h6"/>',
    wallet: '<ellipse cx="12" cy="6.5" rx="8" ry="3.2"/><path d="M4 6.5v5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-5"/><path d="M4 11.5v5c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2v-5"/>',
    report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    graph: '<path d="M3 20V6M3 20h18"/><path d="M7 16l4-6 3 4 5-8"/>',
    week: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/><path d="M7.5 14h2M11 14h2M14.5 14h2M7.5 17.5h2M11 17.5h2"/>',
    bell: '<path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>',
    caret: '<path d="M6 9l6 6 6-6"/>',
    up: '<path d="M5 15l7-7 7 7"/>',
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 9 9 0 0 1-3.7-.8L4 21l1.4-4.1a8.3 8.3 0 0 1-1.4-4.6A8.4 8.4 0 0 1 12.5 4 8.4 8.4 0 0 1 21 11.5z"/>'
  };
  function svg(key, cls) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      (ICONS[key] || ICONS.sms) + '</svg>';
  }

  var ROLE_LABEL = {
    admin: 'Administrator', manager: 'Manager', agent: 'Agent', client: 'Client', test: 'Test Panel'
  };
  var WHAT = { admin: 'SMS panel', manager: 'SMS panel', agent: 'SMS panel', client: 'SMS panel', test: 'test panel' };

  /* ---------------------------------------------------------------- dates */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  function shortDate(s) {
    var d = parseDate(s);
    return d ? (d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]) : String(s || '');
  }
  function dayLabel(s) {
    var d = parseDate(s);
    return d ? (DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]) : String(s || '');
  }
  function todayISO() {
    var now = new Date();
    var uk = new Date(now.getTime() + (now.getTimezoneOffset() * -1) * 60000 + 3600000);
    return uk.toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------ chart */
  /* Light area/line chart matching the reference "OTP Graph".	*/
  function chart(rows, series, opts) {
    var o = opts || {};
    var pts = (rows || []).filter(function (r) { return r && r.date; })
      .map(function (r) { return { date: r.date, label: r.label || '', v: Number(series(r)) || 0 }; });
    if (!pts.length) {
      return '<div class="nx-chart-empty">No data available for this period.</div>';
    }
    var W = 720, H = 262, L = 46, R = 12, T = 16, B = 34;
    var pw = W - L - R, ph = H - T - B;
    var max = Math.max.apply(null, pts.map(function (p) { return p.v; }).concat([1]));
    var step = max <= 4 ? 1 : Math.ceil(max / 4);
    var top = step * 4;
    var X = function (i) { return L + (pts.length === 1 ? pw / 2 : (pw * i) / (pts.length - 1)); };
    var Y = function (v) { return T + ph - (ph * v) / top; };

    var grid = '', i;
    for (i = 0; i <= 4; i++) {
      var val = (top / 4) * i, y = Y(val);
      grid += '<line class="nx-gridline" x1="' + L + '" x2="' + (W - R) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>' +
        '<text x="' + (L - 10) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(nf(Math.round(val))) + '</text>';
    }
    /* x labels: thin them out so a 31-day range stays readable */
    var every = pts.length > 16 ? Math.ceil(pts.length / 7) : (pts.length > 9 ? 2 : 1);
    var xlab = pts.map(function (p, idx) {
      if (idx % every !== 0 && idx !== pts.length - 1) return '';
      return '<text x="' + X(idx).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' +
        esc(p.label || shortDate(p.date)) + '</text>';
    }).join('');

    var line = pts.map(function (p, idx) { return (idx ? 'L' : 'M') + X(idx).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + X(pts.length - 1).toFixed(1) + ' ' + (T + ph) + ' L' + X(0).toFixed(1) + ' ' + (T + ph) + ' Z';
    var last = pts.length - 1;
    var dots = pts.map(function (p, idx) {
      if (pts.length > 20 && idx !== last && idx % 3 !== 0) return '';
      return '<circle class="nx-dot" cx="' + X(idx).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3.4"><title>' +
        esc((p.label ? p.label + ' ' + String(p.date).slice(0, 4) : dayLabel(p.date)) + ' · ' + nf(p.v)) + '</title></circle>';
    }).join('');
    var hi = '<circle class="nx-dot-live" cx="' + X(last).toFixed(1) + '" cy="' + Y(pts[last].v).toFixed(1) + '" r="4.6"/>';

    return '<div class="nx-chart"><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' +
      esc(o.ariaLabel || 'Reporting volume over time') + '">' +
      '<defs><linearGradient id="nxAreaFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#1160e8" stop-opacity=".18"/><stop offset="100%" stop-color="#1160e8" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<g class="nx-axis">' + grid + xlab + '</g>' +
      '<path class="nx-area" d="' + area + '"/><path class="nx-line" d="' + line + '"/>' + dots + hi +
      '</svg></div>';
  }

  /* --------------------------------------------------- range re-slicing */
  var RANGES = { daily: 15, weekly: 7, monthly: 30 };
  function sliceTail(rows, n) {
    var arr = Array.isArray(rows) ? rows.slice() : [];
    return n && arr.length > n ? arr.slice(arr.length - n) : arr;
  }
  function sliceBuckets(rows, size, label) {
    /* Group the SAME daily rows into 7- or 30-day buckets for the wider
       views. This is a slice/sum of the already-returned daily values, used
       for the graph shape only; the headline numbers always come from the API
       totals (today / week / month ...), never from this helper. */
    var arr = Array.isArray(rows) ? rows : [];
    if (!arr.length) return [];
    var out = [];
    for (var i = arr.length; i > 0; i -= size) {
      var chunk = arr.slice(Math.max(0, i - size), i);
      var sum = chunk.reduce(function (a, r) { return a + (Number(r.count) || 0); }, 0);
      out.unshift({ date: chunk[chunk.length - 1].date, count: sum, from: chunk[0].date });
    }
    return out;
  }

  /* =============================== render =============================== */
  function render(cfg) {
    var root = typeof cfg.root === 'string' ? document.getElementById(cfg.root) : cfg.root;
    if (!root) return;
    var d = cfg.dashboard || {};
    var es = cfg.earnings || {};
    var role = cfg.role || 'admin';
    var rows = Array.isArray(cfg.dailyRows) ? cfg.dailyRows : (Array.isArray(d.daily7) ? d.daily7 : []);
    var name = String(cfg.name || '').trim();
    var state = { range: 'daily' };

    /* ---- KPI values, straight from the API -------------------------- */
    var todaySms = d.sms_today;
    var periodKey = role === 'admin' ? d.sms_month : d.sms_month;   /* dashboard month window */
    var balance = es.earning_month != null ? es.earning_month : (es.earning_all != null ? es.earning_all : null);
    var reports = d.total_sms;
    var balanceNote = es.earning_daily != null ? '+' + money(es.earning_daily) + ' today' : 'Earned this month';
    var balanceLabel = cfg.balanceLabel || 'Balance';
    var periodLabel = cfg.periodLabel || 'This Month';
    var totalLabel = cfg.totalLabel || 'Total Reports';

    var prevToday = d.sms_yesterday;
    var prevMonth = null;   /* no fabricated comparison: show a neutral note */

    var kpi = function (cls, icon, label, value, sub) {
      return '<div class="nx-kpi ' + cls + '">' +
        '<div class="nx-kpi-ico">' + svg(icon) + '</div>' +
        '<div class="nx-kpi-body">' +
        '<p class="nx-kpi-label">' + esc(label) + '</p>' +
        '<p class="nx-kpi-value">' + esc(value) + '</p>' +
        '<p class="nx-kpi-sub">' + sub + '</p>' +
        '</div></div>';
    };
    var upChip = function (text) {
      return '<span class="up">' + svg('up') + '</span>' + esc(text);
    };

    var kpis = '<div class="nx-kpis">' +
      kpi('nx-kpi-1', 'chat', "Today's SMS", nf(todaySms),
        prevToday != null && todaySms != null && Number(prevToday) > 0 && Number(todaySms) >= Number(prevToday)
          ? upChip('vs ' + nf(prevToday) + ' yesterday')
          : '<span class="flat">Received today</span>') +
      kpi('nx-kpi-2', 'calendar', periodLabel, nf(periodKey),
        '<span class="flat">' + esc('SMS in ' + todayISO().slice(0, 7)) + '</span>') +
      kpi('nx-kpi-3', 'wallet', balanceLabel, money(balance),
        '<span class="flat">' + esc(balanceNote) + '</span>') +
      kpi('nx-kpi-4', 'report', totalLabel, nf(reports),
        '<span class="flat">' + esc('All SMS on record') + '</span>') +
      '</div>';

    /* ---- hero ------------------------------------------------------- */
    var initials = (name || 'N').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || 'N';
    var greet = 'Welcome back, ' + (name ? name.split(/\s+/)[0] : ROLE_LABEL[role] || 'there') + '!';
    var hero = '<div class="nx-welcome">' +
      '<div class="nx-welcome-txt"><h2>' + esc(greet) + ' <span aria-hidden="true">👋</span></h2>' +
      '<p>' + esc("Here's your " + (WHAT[role] || 'SMS panel') + ' overview') + '</p></div>' +
      '<div class="nx-welcome-tools">' +
      '<span class="nx-bell" role="img" aria-label="Notifications">' + svg('bell') +
      ((d.over_limit_today || 0) > 0 ? '<span class="nx-bell-dot"></span>' : '') + '</span>' +
      '<span class="nx-user"><span class="av">' + esc(initials) + '</span>' +
      '<span><span class="nm">' + esc(name || ROLE_LABEL[role] || 'User') + '</span>' +
      '<span class="rl">' + esc(ROLE_LABEL[role] || role) + '</span></span>' +
      svg('caret', 'caret') + '</span>' +
      '</div></div>';

    /* ---- graph card -------------------------------------------------- */
    function seriesFor(range) {
      /* weekly -> the daily rows bucketed in sevens; monthly -> the monthly
         report rows the API already returned for this role. */
      if (range === 'weekly') return sliceBuckets(sliceTail(rows, 28), 7, 'week');
      if (range === 'monthly') {
        var list = Array.isArray(cfg.monthly) ? cfg.monthly : [];
        if (list.length) {
          return list.slice(-12).map(function (r) {
            var key = r.dims && r.dims.month ? r.dims.month : '';
            var dt = /^\d{4}-\d{2}$/.test(key) ? new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1)) : null;
            return { date: dt ? dt.toISOString().slice(0, 10) : key, count: Number(r.sms) || 0,
                     label: dt ? MONTHS[dt.getUTCMonth()] : key };
          });
        }
        return sliceBuckets(sliceTail(rows, 90), 30, 'month');
      }
      return sliceTail(rows, RANGES.daily);
    }
    function bestDay() {
      var src = (rows || []).filter(function (r) { return r && r.date; });
      if (!src.length) return '—';
      var best = src.reduce(function (a, b) { return (Number(b.count) || 0) > (Number(a.count) || 0) ? b : a; });
      return Number(best.count) > 0 ? shortDate(best.date) : '—';
    }
    function graphHead() {
      return '<div class="nx-strip">' +
        '<div><dt>Today</dt><dd>' + esc(nf(d.sms_today)) + '</dd></div>' +
        '<div><dt>Total</dt><dd>' + esc(nf(d.sms_week)) + '</dd></div>' +
        '<div><dt>Best day</dt><dd>' + esc(bestDay()) + '</dd></div>' +
        '</div>';
    }
    function graphCard() {
      var s = seriesFor(state.range);
      var title = state.range === 'daily' ? 'OTP Graph' : (state.range === 'weekly' ? 'OTP Graph — Weekly' : 'OTP Graph — Monthly');
      return '<section class="nx-card nx-graph">' +
        '<div class="nx-card-head"><h3 class="nx-card-title">' + svg('graph') + '<span>' + esc(title) + '</span></h3>' +
        '<div class="nx-seg" role="group" aria-label="Chart range">' +
        '<button type="button" data-nx-range="daily" aria-pressed="' + (state.range === 'daily') + '">Daily</button>' +
        '<button type="button" data-nx-range="weekly" aria-pressed="' + (state.range === 'weekly') + '">Weekly</button>' +
        '<button type="button" data-nx-range="monthly" aria-pressed="' + (state.range === 'monthly') + '">Monthly</button>' +
        '</div></div>' +
        '<div class="nx-card-body">' + graphHead() + chart(s, function (r) { return r.count; }, { ariaLabel: 'SMS volume' }) + '</div>' +
        '</section>';
    }

    /* ---- weekly report card ----------------------------------------- */
    function weekRows() {
      var src = sliceTail(rows, 7).slice().reverse();
      var max = Math.max.apply(null, src.map(function (r) { return Number(r.count) || 0; }).concat([0]));
      if (!src.length) return '<div class="nx-chart-empty" style="min-height:120px">No SMS in this period.</div>';
      return '<div class="nx-week-rows">' + src.map(function (r, i) {
        var v = Number(r.count) || 0;
        var pct = max > 0 ? Math.max(4, (v / max) * 100) : 0;
        var lbl = i === 0 ? 'Today' : dayLabel(r.date);
        return '<div class="nx-week-row' + (i === 0 ? ' is-today' : '') + '">' +
          '<span class="d">' + esc(lbl) + '</span>' +
          '<span class="bar"><i class="' + (v ? '' : 'zero') + '" style="width:' + (v ? pct : 0) + '%"></i></span>' +
          '<span class="v">' + esc(nf(v)) + '</span></div>';
      }).join('') + '</div>';
    }
    function avg() {
      var src = sliceTail(rows, 7);
      if (!src.length) return null;
      var total = src.reduce(function (a, r) { return a + (Number(r.count) || 0); }, 0);
      return Math.round(total / src.length);
    }
    function weekCard() {
      var w = sliceTail(rows, 7);
      var wTotal = w.reduce(function (a, r) { return a + (Number(r.count) || 0); }, 0);
      /* the API's own 7-day payout total when present, else the sum of the
         already-returned daily payout values (display only) */
      var payout = (es.earning_7d != null) ? es.earning_7d : (d.payout_7d != null ? d.payout_7d : null);
      var diff = (d.sms_yesterday != null && Number(d.sms_yesterday) > 0)
        ? Math.round(((Number(d.sms_today) - Number(d.sms_yesterday)) / Number(d.sms_yesterday)) * 100)
        : null;
      return '<section class="nx-card nx-week">' +
        '<div class="nx-card-head"><h3 class="nx-card-title">' + svg('week') + '<span>Weekly Report</span></h3>' +
        '<select class="nx-select" data-nx-week disabled aria-label="Reporting window">' +
        '<option>Last 7 days</option></select></div>' +
        '<div class="nx-card-body">' +
        '<div class="nx-week-top">' +
        '<div><dt>OTPs</dt><dd>' + esc(nf(wTotal)) + '</dd></div>' +
        '<div><dt>Payout</dt><dd>' + esc(money(payout)) + '</dd></div>' +
        '<div><dt>Daily average</dt><dd>' + esc(nf(avg())) + '</dd></div>' +
        '</div>' +
        (diff != null
          ? '<div class="nx-badge-up' + (diff < 0 ? ' is-down' : '') + '">' + svg('up') +
            esc((diff >= 0 ? '+' : '') + diff + '% vs yesterday') + '</div>'
          : '<div class="nx-badge-up is-flat">Last 7 reporting days</div>') +
        weekRows() +
        '</div></section>';
    }

    /* ---- monthly report card ---------------------------------------- */
    function monthCard() {
      var list = Array.isArray(cfg.monthly) ? cfg.monthly : [];
      var thisMonth = d.sms_month;
      var payoutMonth = es.earning_month;
      var prevMonthRow = list.length > 1 ? list[list.length - 2] : null;
      var currentKey = todayISO().slice(0, 7);
      var body;
      if (list.length) {
        body = '<div class="nx-table-wrap"><table class="nx-table">' +
          '<thead><tr><th>Month</th><th>Payout</th><th>OTPs</th></tr></thead><tbody>' +
          list.slice(-6).map(function (r) {
            var key = r.dims && r.dims.month ? r.dims.month : '';
            var dt = /^\d{4}-\d{2}$/.test(key) ? new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1)) : null;
            var lbl = dt ? (MONTHS[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear()) : (key || '—');
            return '<tr class="' + (key === currentKey ? 'is-current' : '') + '">' +
              '<td>' + esc(lbl) + '</td>' +
              '<td>' + esc(money(r.my_payout)) + '</td>' +
              '<td>' + esc(nf(r.sms)) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      } else {
        body = '<div class="nx-chart-empty" style="min-height:150px">No monthly data yet.</div>';
      }
      return '<section class="nx-card nx-month-card">' +
        '<div class="nx-card-head"><h3 class="nx-card-title">' + svg('week') + '<span>Monthly Report</span></h3>' +
        '<select class="nx-select" data-nx-month disabled aria-label="Month window"><option>Last 6 Months</option></select></div>' +
        '<div class="nx-card-body"><div class="nx-month">' +
        '<div class="nx-month-side"><div class="m-strip">' +
        '<div><dt>This Month</dt><dd>' + esc(nf(thisMonth)) + '</dd></div>' +
        '<div><dt>Payout</dt><dd>' + esc(money(payoutMonth)) + '</dd></div>' +
        '</div>' +
        '<div class="m-strip" style="margin-top:12px">' +
        '<div><dt>Last Month</dt><dd>' + esc(nf(prevMonthRow ? prevMonthRow.sms : (d.sms_month_prev != null ? d.sms_month_prev : null))) + '</dd></div>' +
        '</div></div>' + body + '</div></div></section>';
    }

    root.innerHTML = hero + kpis + '<div class="nx-grid">' +
      '<div class="nx-col">' + graphCard() + '</div>' +
      '<div class="nx-col">' + weekCard() + '</div>' +
      '</div>' + monthCard();

    /* range switch: re-paints the graph card from the rows already in memory */
    root.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('[data-nx-range]') : null;
      if (!btn) return;
      var next = btn.getAttribute('data-nx-range');
      if (!next || next === state.range) return;
      state.range = next;
      var card = root.querySelector('.nx-graph');
      if (card) card.outerHTML = graphCard();
    });
  }

  function renderFallback(cfg) {
    /* When an OPTIONAL call (monthly report) failed we still paint the hero,
       the KPI row and the graph so the dashboard is never blank. */
    render({
      root: cfg.root, role: cfg.role, dashboard: cfg.dashboard, earnings: cfg.earnings,
      dailyRows: cfg.dailyRows, monthly: [], name: cfg.name
    });
  }

  window.NexoraDashboard = Object.freeze({
    render: render,
    renderFallback: renderFallback,
    money: money,
    count: nf,
    chart: chart
  });
})();
