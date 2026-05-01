/**
 * Cookie / storage consent banner controller.
 *
 * The banner markup itself is statically injected by the server
 * (serveHtmlWithNonce in server.js) so non-JS scanners can detect it.
 * This script only handles the dismiss interaction and the
 * "already-acknowledged" hide-on-load behavior.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'consent_acknowledged_v1';
  var BANNER_ID = 'cookie-consent';
  var ACCEPT_BTN_ID = 'cookie-consent-accept';

  function isAcknowledged() {
    try { return !!localStorage.getItem(STORAGE_KEY); }
    catch (e) { return false; }
  }

  function acknowledge() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
  }

  function removeBanner(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function init() {
    var banner = document.getElementById(BANNER_ID);
    if (!banner) return;
    if (isAcknowledged()) {
      removeBanner(banner);
      return;
    }
    var btn = document.getElementById(ACCEPT_BTN_ID);
    if (btn) {
      btn.addEventListener('click', function () {
        acknowledge();
        removeBanner(banner);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
