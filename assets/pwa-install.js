/* ============================================================================
   NEXORA — install experience
   ----------------------------------------------------------------------------
   • Registers the service worker (safe caching: see /sw.js — /api/* is never
     cached).
   • Shows an "Install NEXORA App" card only when the browser actually fires
     beforeinstallprompt. Nothing is claimed unless the browser confirms.
   • Android/Chrome: the button calls the real native prompt, and the card is
     only dismissed after the user's choice is known.
   • iOS Safari: no native prompt exists, so clear Share → Add to Home Screen
     steps are shown instead.
   • Never nags: a dismissal or a successful install is remembered.
   ========================================================================== */
(function () {
  'use strict';

  var DISMISS_KEY = 'nx_pwa_dismissed_at';
  var SNOOZE_DAYS = 14;
  var deferred = null;
  var installed = false;

  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true
        || document.referrer.indexOf('android-app://') === 0;
    } catch (e) { return false; }
  }

  function snoozed() {
    try {
      var t = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
      return t && (Date.now() - t) < SNOOZE_DAYS * 864e5;
    } catch (e) { return false; }
  }

  function snooze() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
  }

  function isIOS() {
    var ua = navigator.userAgent || '';
    var iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    return iOS && safari;
  }

  function isMobile() {
    try { return window.matchMedia('(max-width: 900px)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent); }
    catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ *
   * service worker
   * ------------------------------------------------------------------ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (reg) {
        /* A new worker takes over on the next launch; if one is already
           waiting, activate it now so a deploy is picked up immediately. */
        if (reg.waiting && reg.active) {
          reg.waiting.postMessage('skip-waiting');
        }
        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              sw.postMessage('skip-waiting');
            }
          });
        });
      }).catch(function () { /* registration is optional; the panel still works */ });
    });
  }

  /* ------------------------------------------------------------------ *
   * install card
   * ------------------------------------------------------------------ */
  function card() {
    var el = document.getElementById('nxInstall');
    if (el) return el;

    el = document.createElement('div');
    el.id = 'nxInstall';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Install NEXORA App');
    el.innerHTML =
      '<div class="nxi-row">' +
        '<img class="nxi-logo" src="/assets/pwa/icon-192.png" alt="" width="44" height="44" />' +
        '<div class="nxi-txt">' +
          '<strong>Install NEXORA App</strong>' +
          '<span id="nxInstallSub">Add NEXORA to your home screen for a faster, app-like experience.</span>' +
        '</div>' +
        '<button type="button" class="nxi-x" aria-label="Not now">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="nxi-acts">' +
        '<button type="button" class="nxi-btn" id="nxInstallGo">Install App</button>' +
      '</div>';

    var css = document.createElement('style');
    css.textContent = [
      '#nxInstall{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));',
      'z-index:9998;width:min(440px,calc(100vw - 24px));background:#fff;border:1px solid #dbe6f6;border-radius:16px;',
      'box-shadow:0 18px 48px rgba(8,32,80,.22);padding:14px;display:none;font-family:Inter,system-ui,sans-serif;',
      'animation:nxiIn .22s ease-out}',
      '#nxInstall.show{display:block}',
      '#nxInstall .nxi-row{display:flex;align-items:center;gap:12px}',
      '#nxInstall .nxi-logo{border-radius:11px;flex:none}',
      '#nxInstall .nxi-txt{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '#nxInstall .nxi-txt strong{font-size:14px;font-weight:800;color:#0b2a6b}',
      '#nxInstall .nxi-txt span{font-size:12.5px;color:#5b7196;line-height:1.45}',
      '#nxInstall .nxi-x{border:0;background:#f1f5fb;color:#5b7196;width:30px;height:30px;border-radius:50%;',
      'display:grid;place-items:center;cursor:pointer;flex:none}',
      '#nxInstall .nxi-x svg{width:14px;height:14px}',
      '#nxInstall .nxi-acts{display:flex;gap:8px;margin-top:12px}',
      '#nxInstall .nxi-btn{flex:1;border:0;border-radius:10px;padding:11px 14px;font:inherit;font-size:13.5px;',
      'font-weight:800;color:#fff;background:linear-gradient(135deg,#1160e8,#0f5ae0);cursor:pointer;',
      'box-shadow:0 8px 20px rgba(17,96,232,.28)}',
      '#nxInstall .nxi-btn.ghost{background:#f1f5fb;color:#3b5578;box-shadow:none}',
      '#nxInstall .nxi-btn:disabled{opacity:.6;cursor:default}',
      '#nxInstall ol{margin:10px 0 0;padding-left:20px;font-size:12.5px;color:#3b5578;line-height:1.7}',
      '@keyframes nxiIn{from{opacity:0;transform:translate(-50%,10px)}to{opacity:1;transform:translate(-50%,0)}}',
      '@media (prefers-color-scheme:dark){',
      'body.ams-dark #nxInstall{background:#101b2d;border-color:#1e2d45}',
      'body.ams-dark #nxInstall .nxi-txt strong{color:#e6eefb}',
      'body.ams-dark #nxInstall .nxi-txt span,#nxInstall ol{color:#9db3cd}}'
    ].join('');
    document.head.appendChild(css);
    document.body.appendChild(el);

    el.querySelector('.nxi-x').addEventListener('click', function () {
      hide();
      snooze();
    });
    return el;
  }

  function hide() {
    var el = document.getElementById('nxInstall');
    if (el) el.classList.remove('show');
  }

  function show() {
    if (installed || isStandalone() || snoozed()) return;
    var el = card();
    el.classList.add('show');
  }

  function showIOS() {
    if (installed || isStandalone() || snoozed() || !isIOS() || !isMobile()) return;
    var el = card();
    el.querySelector('#nxInstallSub').textContent =
      'Tap the Share button, then “Add to Home Screen” to install NEXORA.';
    el.querySelector('#nxInstallGo').textContent = 'Show me how';
    el.querySelector('#nxInstallGo').addEventListener('click', function () {
      var ol = document.createElement('ol');
      ol.innerHTML = '<li>Open the Share menu in Safari (the square with an arrow).</li>'
                   + '<li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>'
                   + '<li>Tap <strong>Add</strong> — the NEXORA icon appears on your home screen.</li>';
      el.appendChild(ol);
      this.style.display = 'none';
    });
    el.classList.add('show');
  }

  /* ------------------------------------------------------------------ *
   * wiring
   * ------------------------------------------------------------------ */
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();          /* keep the mini-infobar for our own card */
    deferred = e;
    show();
  });

  window.addEventListener('appinstalled', function () {
    installed = true;
    deferred = null;
    hide();
    try { localStorage.removeItem(DISMISS_KEY); } catch (e) {}
  });

  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#nxInstallGo') : null;
    if (!btn || !deferred) return;
    btn.disabled = true;
    btn.textContent = 'Opening installer…';
    deferred.prompt();
    deferred.userChoice.then(function (choice) {
      /* Only claim success when the browser says so. */
      if (choice && choice.outcome === 'accepted') {
        btn.textContent = 'Installing…';
        hide();
      } else {
        btn.disabled = false;
        btn.textContent = 'Install App';
        snooze();
        hide();
      }
      deferred = null;
    }).catch(function () {
      btn.disabled = false;
      btn.textContent = 'Install App';
      deferred = null;
    });
  });

  /* Manual re-entry point (used by the login page link). */
  window.NexoraPWA = {
    prompt: function () { if (deferred) { document.dispatchEvent(new Event('noop')); } show(); },
    canInstall: function () { return !!deferred; },
    isStandalone: isStandalone,
    showIOS: showIOS
  };

  registerSW();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { showIOS(); });
  } else {
    showIOS();
  }
})();
