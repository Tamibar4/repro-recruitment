/**
 * Learn page — recruiter-facing training modules.
 *
 * Loads /api/training/modules (list) and /api/training/modules/:id (body)
 * and renders them as soft, brand-styled cards. Clicking a card opens a
 * full-screen reader with light-touch DRM:
 *   - user-select: none + right-click disabled
 *   - Ctrl+P / Ctrl+S keyboard shortcuts blocked
 *   - print stylesheet blanks the page
 *   - diagonal email watermark on the reader background
 *
 * None of these stop a phone camera, but they make casual sharing
 * frictional and give us a forensic trail (the watermark) if a leak
 * surfaces in a screenshot.
 */
(function () {
  'use strict'

  let userEmail = ''
  let userName = ''

  // Bumped when the disclaimer text changes — forces existing users to
  // re-accept after a material change (e.g. new clauses added).
  const DISCLAIMER_VERSION = 'v1'
  function disclaimerStorageKey() {
    return `repro_learn_disclaimer_${DISCLAIMER_VERSION}_${userEmail || 'anon'}`
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // Raw fetch helper that does NOT auto-logout on 401 (unlike API.request).
  // Keeps recruiters from being kicked out of the site if a single call
  // hiccups — they should always see at least the basic page.
  async function safeFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
    const token = localStorage.getItem('auth_token')
    if (token) headers['Authorization'] = 'Bearer ' + token
    const res = await fetch('/api' + path, { ...options, headers })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const e = new Error(err.error || err.message || `HTTP ${res.status}`)
      e.status = res.status
      throw e
    }
    if (res.status === 204) return null
    return res.json()
  }

  // ----- Init -----------------------------------------------------------
  async function init() {
    // Best-effort auth check — if there's no token at all, redirect.
    // But never auto-redirect on a failed /auth/me call: that's what was
    // throwing recruiters off the site.
    if (!localStorage.getItem('auth_token')) {
      window.location.href = 'login.html'
      return
    }
    try {
      const me = await safeFetch('/auth/me')
      userEmail = me?.email || me?.username || ''
      userName = me?.display_name || me?.username || ''
      if (typeof renderUserBadge === 'function') renderUserBadge(me)
      if (me?.role === 'admin') {
        document.querySelectorAll('.admin-only-nav').forEach(el => { el.style.display = '' })
      }
    } catch (e) {
      // Silent — keep loading the page even if /auth/me failed for
      // some transient reason. The watermark just won't have an email.
      console.warn('learn: /auth/me failed', e)
    }

    // Show the disclaimer modal until the user accepts it. Once accepted,
    // the localStorage flag persists (per-user, per-version) so subsequent
    // visits skip straight to the modules.
    if (!hasAcceptedDisclaimer()) {
      showDisclaimer()
      return // don't load modules yet — they'll be loaded on accept
    }

    await loadModules()
    setupReaderProtection()
  }

  // ----- Disclaimer ---------------------------------------------------
  function hasAcceptedDisclaimer() {
    try { return !!localStorage.getItem(disclaimerStorageKey()) } catch { return false }
  }

  function recordDisclaimerAccept() {
    try {
      localStorage.setItem(
        disclaimerStorageKey(),
        JSON.stringify({ at: new Date().toISOString(), email: userEmail }),
      )
    } catch {}
    // Best-effort server-side log so admins have an audit trail. The
    // endpoint is optional — failing here doesn't block the user.
    safeFetch('/training/disclaimer-accept', {
      method: 'POST',
      body: JSON.stringify({ version: DISCLAIMER_VERSION }),
    }).catch(() => {})
  }

  function showDisclaimer() {
    const overlay = document.getElementById('disclaimer-overlay')
    const checkbox = document.getElementById('disclaimer-checkbox')
    const acceptBtn = document.getElementById('disclaimer-accept')
    const cancelBtn = document.getElementById('disclaimer-cancel')
    if (!overlay) return

    overlay.style.display = 'flex'

    checkbox.addEventListener('change', () => {
      acceptBtn.disabled = !checkbox.checked
    })

    acceptBtn.addEventListener('click', async () => {
      if (!checkbox.checked) return
      recordDisclaimerAccept()
      overlay.style.display = 'none'
      await loadModules()
      setupReaderProtection()
    })

    cancelBtn.addEventListener('click', () => {
      // Cancel = back to the dashboard. The user can come back any time.
      window.location.href = 'index.html'
    })
  }

  // ----- Load module list ----------------------------------------------
  async function loadModules() {
    const container = document.getElementById('modules-container')
    try {
      const modules = await safeFetch('/training/modules')
      if (!modules || modules.length === 0) {
        container.innerHTML = `
          <div class="learn-empty">
            <div class="learn-empty-icon">📚</div>
            <h3>החומרים בדרך</h3>
            <p>טרם הועלו חומרי הכשרה. תכף נוסיף אותם — תחזרי לבדוק בקרוב.</p>
          </div>
        `
        return
      }

      container.innerHTML = `
        <div class="modules-grid">
          ${modules.map((m) => renderCard(m)).join('')}
        </div>
      `
      container.querySelectorAll('.module-card').forEach((card) => {
        card.addEventListener('click', () => openReader(parseInt(card.dataset.id)))
      })
    } catch (err) {
      container.innerHTML = `
        <div class="learn-empty">
          <div class="learn-empty-icon">⚠️</div>
          <h3>לא הצלחנו לטעון את החומרים</h3>
          <p>נסי לרענן את העמוד</p>
        </div>
      `
    }
  }

  function renderCard(m) {
    const intro = m.intro || 'תכנים מקצועיים בנושא זה'
    return `
      <article class="module-card" data-id="${m.id}" tabindex="0" role="button">
        <span class="module-number">${m.order}</span>
        <h3 class="module-title">${escapeHtml(m.title)}</h3>
        <p class="module-intro">${escapeHtml(intro)}${intro.length >= 280 ? '…' : ''}</p>
        <div class="module-meta">
          <span class="module-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            ${m.reading_minutes} דק׳ קריאה
          </span>
          <span class="module-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            ${m.word_count.toLocaleString()} מילים
          </span>
        </div>
      </article>
    `
  }

  // ----- Reader --------------------------------------------------------
  async function openReader(id) {
    const overlay = document.getElementById('reader-overlay')
    const titleEl = document.getElementById('reader-title')
    const numEl = document.getElementById('reader-num')
    const contentEl = document.getElementById('reader-content')
    const watermarkEl = document.getElementById('reader-watermark')

    overlay.style.display = 'flex'
    titleEl.textContent = '...'
    contentEl.innerHTML = '<div class="reader-loading">טוען...</div>'

    // Build the diagonal watermark — repeats user's email across the page
    const wmText = userEmail || userName || 'RePro'
    const wmTiles = []
    for (let r = 0; r < 14; r++) {
      for (let c = 0; c < 6; c++) {
        wmTiles.push(`<span style="top:${r * 80}px;right:${c * 280 - 100}px">${escapeHtml(wmText)}</span>`)
      }
    }
    watermarkEl.innerHTML = wmTiles.join('')

    try {
      const mod = await safeFetch('/training/modules/' + id)
      titleEl.textContent = mod.title
      // Find the order number from the existing card (so the badge matches)
      const card = document.querySelector(`.module-card[data-id="${id}"]`)
      numEl.textContent = card ? (card.querySelector('.module-number')?.textContent || '•') : '•'

      // Light formatting: collapse 3+ blank lines to 2, trim leading/trailing
      let content = (mod.content || '').replace(/\n{3,}/g, '\n\n').trim()
      contentEl.textContent = content
    } catch (err) {
      contentEl.innerHTML = '<div class="reader-loading">שגיאה בטעינת החומר</div>'
    }
  }

  function closeReader() {
    document.getElementById('reader-overlay').style.display = 'none'
  }

  // ----- Anti-piracy basics --------------------------------------------
  function setupReaderProtection() {
    const reader = document.getElementById('reader')
    const closeBtn = document.getElementById('reader-close')
    const overlay = document.getElementById('reader-overlay')

    closeBtn?.addEventListener('click', closeReader)
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) closeReader()
    })

    // Block right-click inside reader
    reader?.addEventListener('contextmenu', (e) => e.preventDefault())

    // Block Ctrl+P (print), Ctrl+S (save), Ctrl+A (select all) inside reader
    document.addEventListener('keydown', (e) => {
      if (overlay.style.display === 'none') return
      if ((e.ctrlKey || e.metaKey) && ['p', 's', 'a', 'P', 'S', 'A'].includes(e.key)) {
        e.preventDefault()
      }
      if (e.key === 'Escape') closeReader()
    })

    // Block drag-to-save on text
    reader?.addEventListener('dragstart', (e) => e.preventDefault())
  }

  // ----- Boot -----------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
