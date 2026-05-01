/**
 * Universal CSP-safe UI handlers.
 *
 * Replaces inline on* attributes (onclick, onsubmit, onerror, etc.) with
 * delegated event listeners triggered by data-* attributes. Required because
 * the Content-Security-Policy no longer allows 'unsafe-inline' in script-src,
 * which blocks ALL inline event-handler attributes.
 *
 * Supported attributes (place on the element in your HTML / template):
 *   data-close="modal-id"      → calls window.closeModal(modal-id) on click
 *   data-no-submit             → preventDefault on form submit
 *   data-stop                  → stops the click from triggering parent
 *                                data-close / data-action handlers
 *   data-action="name"         → calls window.__uiActions[name](el, event)
 *   data-fallback="text"       → on img error, replace img with a div
 *                                containing the text. Optional companion:
 *                                data-fallback-style="css-text".
 *
 * Per-page action handlers register themselves like:
 *   window.__uiActions['approve-user'] = (el) => approveUser(el.dataset.username);
 */
(function () {
  'use strict';

  window.__uiActions = window.__uiActions || {};

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-close], [data-stop], [data-action]');
    if (!el) return;
    // data-stop claims the click — short-circuit so parent action / close
    // handlers don't also fire (replaces inline event.stopPropagation()).
    if (el.hasAttribute('data-stop')) return;
    if (el.hasAttribute('data-close')) {
      if (typeof window.closeModal === 'function') {
        window.closeModal(el.getAttribute('data-close'));
      }
      return;
    }
    var name = el.getAttribute('data-action');
    var handler = window.__uiActions[name];
    if (typeof handler === 'function') {
      handler(el, e);
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.matches && f.matches('form[data-no-submit]')) {
      e.preventDefault();
    }
  });

  // Image error fallback (capture phase — error events don't bubble).
  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.dataset || !el.dataset.fallback) return;
    var div = document.createElement('div');
    div.style.cssText = el.dataset.fallbackStyle || 'padding:24px;color:#e2445c;text-align:center';
    div.textContent = el.dataset.fallback;
    if (el.parentNode) el.parentNode.replaceChild(div, el);
  }, true);
})();
