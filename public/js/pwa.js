/**
 * PWA bootstrap — registers the service worker, listens for the
 * "Add to Home Screen" prompt, and shows a small install banner
 * when the browser says the app is installable.
 *
 * Loaded on every page so the SW is registered once per origin
 * regardless of which page the user lands on first.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // ---- 1. Register service worker ----
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { scope: '/' })
      .then((reg) => {
        // When a new SW takes control, prompt to refresh so the user
        // gets the latest code right away.
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              // A new version is ready. Tell it to take over now and
              // reload after it does so the user sees fresh assets.
              installing.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch((err) => console.warn('SW registration failed:', err));

    // When the controller changes (after skipWaiting), reload once so
    // the new code is in charge. Guard against infinite reload loops.
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });

  // ---- 2. Custom install prompt (Chromium browsers) ----
  // Chrome/Edge/Samsung fire `beforeinstallprompt` when the PWA is
  // installable. We capture it, show a small banner, and let the user
  // trigger the prompt at a moment of their choosing.
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner();
  });

  // Hide the banner if the app gets installed via another path
  // (e.g. Chrome's three-dot menu)
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    hideInstallBanner();
    try { localStorage.setItem('repro_installed_at', new Date().toISOString()); } catch {}
  });

  function showInstallBanner() {
    if (document.getElementById('repro-install-banner')) return;
    // Don't pester the user if they dismissed recently
    try {
      const dismissed = localStorage.getItem('repro_install_dismissed_at');
      if (dismissed) {
        const ageDays = (Date.now() - new Date(dismissed).getTime()) / (1000 * 60 * 60 * 24);
        if (ageDays < 14) return; // Wait 2 weeks before re-asking
      }
    } catch {}

    const el = document.createElement('div');
    el.id = 'repro-install-banner';
    el.style.cssText = [
      'position: fixed', 'bottom: 16px', 'left: 16px', 'right: 16px',
      'max-width: 480px', 'margin: 0 auto',
      'background: linear-gradient(135deg, #5e5ce6, #8b5cf6)',
      'color: white', 'border-radius: 16px',
      'box-shadow: 0 12px 32px rgba(94,92,230,0.4), 0 2px 8px rgba(0,0,0,0.12)',
      'padding: 14px 18px',
      'z-index: 9998', 'font-family: Rubik, sans-serif', 'font-size: 14px',
      'display: flex', 'align-items: center', 'gap: 12px',
      'animation: repro-install-slidein 0.35s cubic-bezier(0.18,0.89,0.32,1.15)'
    ].join(';');
    el.innerHTML = `
      <style>
        @keyframes repro-install-slidein {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      </style>
      <div style="font-size:28px;line-height:1">📱</div>
      <div style="flex:1;line-height:1.45">
        <div style="font-weight:700;margin-bottom:2px">התקיני את RePro</div>
        <div style="font-size:12px;opacity:0.9">פתיחה מהירה מהמסך הבית, ללא דפדפן</div>
      </div>
      <button id="repro-install-yes" style="background:white;color:#5e5ce6;border:none;padding:9px 16px;border-radius:99px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer">התקיני</button>
      <button id="repro-install-no" style="background:transparent;color:white;border:none;padding:6px;font-size:18px;cursor:pointer;opacity:0.7" title="סגרי">✕</button>
    `;
    document.body.appendChild(el);

    el.querySelector('#repro-install-yes').addEventListener('click', async () => {
      hideInstallBanner();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch {}
      deferredPrompt = null;
    });
    el.querySelector('#repro-install-no').addEventListener('click', () => {
      hideInstallBanner();
      try { localStorage.setItem('repro_install_dismissed_at', new Date().toISOString()); } catch {}
    });
  }

  function hideInstallBanner() {
    const el = document.getElementById('repro-install-banner');
    if (el) el.remove();
  }

  // ---- 3. iOS install hint (Safari doesn't fire beforeinstallprompt) ----
  // Show a one-time hint on iOS Safari pointing at the Share button,
  // since iOS users have to install via "Add to Home Screen" manually.
  function isIosSafari() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIOS && isSafari;
  }
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  window.addEventListener('load', () => {
    if (!isIosSafari() || isStandalone()) return;
    let dismissedAt = null;
    try { dismissedAt = localStorage.getItem('repro_ios_hint_dismissed_at'); } catch {}
    if (dismissedAt) {
      const ageDays = (Date.now() - new Date(dismissedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 30) return;
    }
    setTimeout(() => {
      if (document.getElementById('repro-install-banner')) return;
      const el = document.createElement('div');
      el.id = 'repro-install-banner';
      el.style.cssText = [
        'position: fixed', 'bottom: 16px', 'left: 16px', 'right: 16px',
        'max-width: 480px', 'margin: 0 auto',
        'background: white', 'color: #1a1f3a',
        'border-radius: 16px', 'border: 1px solid #e8e6f7',
        'box-shadow: 0 12px 32px rgba(0,0,0,0.15)',
        'padding: 14px 18px', 'z-index: 9998',
        'font-family: Rubik, sans-serif', 'font-size: 13.5px',
        'display: flex', 'align-items: center', 'gap: 12px'
      ].join(';');
      el.innerHTML = `
        <div style="font-size:24px;line-height:1">📱</div>
        <div style="flex:1;line-height:1.5">
          <div style="font-weight:700;margin-bottom:2px;color:#5e5ce6">התקיני את RePro על המסך הבית</div>
          <div style="font-size:12px;color:#6b6e8a">לחצי על <span style="font-weight:700">⬆️ Share</span> ואז <span style="font-weight:700">"Add to Home Screen"</span></div>
        </div>
        <button id="repro-ios-no" style="background:transparent;color:#a0a3b8;border:none;padding:6px;font-size:18px;cursor:pointer" title="סגרי">✕</button>
      `;
      document.body.appendChild(el);
      el.querySelector('#repro-ios-no').addEventListener('click', () => {
        el.remove();
        try { localStorage.setItem('repro_ios_hint_dismissed_at', new Date().toISOString()); } catch {}
      });
    }, 3000); // Show 3s after page load so it doesn't compete with login
  });
})();
