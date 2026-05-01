/**
 * First-visit storage / privacy notice.
 *
 * Renders a small dismissible banner explaining that the app stores the
 * authentication token in browser localStorage. After the user clicks
 * accept, a flag is persisted so the banner does not reappear.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'consent_acknowledged_v1';

  function isAcknowledged() {
    try { return !!localStorage.getItem(STORAGE_KEY); }
    catch (e) { return false; }
  }

  function acknowledge() {
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch (e) {}
  }

  function render() {
    if (isAcknowledged()) return;
    if (document.getElementById('consent-banner-root')) return;

    var root = document.createElement('div');
    root.id = 'consent-banner-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-live', 'polite');
    root.style.cssText = [
      'position:fixed', 'left:16px', 'right:16px', 'bottom:16px',
      'z-index:9999', 'max-width:760px', 'margin:0 auto',
      'background:#1a1d2e', 'color:#fff',
      'border:1px solid rgba(255,255,255,0.18)',
      'border-radius:12px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.35)',
      'padding:16px 20px',
      'font-family:inherit', 'font-size:14px', 'line-height:1.6',
      'display:flex', 'flex-wrap:wrap', 'gap:12px',
      'align-items:center', 'justify-content:space-between',
      'direction:rtl'
    ].join(';');

    var msg = document.createElement('div');
    msg.style.cssText = 'flex:1 1 320px;min-width:0';
    var p = document.createElement('p');
    p.style.cssText = 'margin:0';
    p.appendChild(document.createTextNode(
      'אנו משתמשים באחסון מקומי בדפדפן (localStorage) לשמירת הפעלת המשתמש. ' +
      'בהמשך השימוש את/ה מסכים/ה ל'
    ));
    var privacy = document.createElement('a');
    privacy.href = '/privacy';
    privacy.textContent = 'מדיניות הפרטיות';
    privacy.style.cssText = 'color:#5ad7ff;text-decoration:underline';
    p.appendChild(privacy);
    p.appendChild(document.createTextNode(' ו-'));
    var terms = document.createElement('a');
    terms.href = '/terms';
    terms.textContent = 'תנאי השימוש';
    terms.style.cssText = 'color:#5ad7ff;text-decoration:underline';
    p.appendChild(terms);
    p.appendChild(document.createTextNode('.'));
    msg.appendChild(p);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'אישור';
    btn.style.cssText = [
      'background:#5ad7ff', 'color:#0b1020',
      'border:none', 'border-radius:8px',
      'padding:10px 22px', 'font-weight:700',
      'font-size:14px', 'cursor:pointer',
      'flex:0 0 auto'
    ].join(';');
    btn.addEventListener('click', function () {
      acknowledge();
      if (root.parentNode) root.parentNode.removeChild(root);
    });

    root.appendChild(msg);
    root.appendChild(btn);
    document.body.appendChild(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
