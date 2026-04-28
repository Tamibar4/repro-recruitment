/**
 * Learn page — recruiter-facing course-catalogue UI.
 *
 * Renders training modules as course cards with status badges
 * (✓ סיימתי / 📍 במהלך / ▶️ התחל), a progress strip at the top, and a
 * full-screen reader for the actual content. Status is tracked
 * client-side in localStorage so each recruiter sees her own progress.
 *
 * Image-only Canva PDFs (no extractable text) get a friendly fallback
 * UI inside the reader that points the recruiter at the AI tutor button
 * instead of showing a blank page.
 */
(function () {
  'use strict'

  let userEmail = ''
  let userName = ''
  let modulesCache = []

  // v2 introduces the full multi-section legal agreement (Israeli law,
  // RePro-specific IP/non-compete clauses). Anyone who accepted v1 will
  // be re-prompted to acknowledge v2.
  const DISCLAIMER_VERSION = 'v2'
  function disclaimerKey() { return `repro_learn_disclaimer_${DISCLAIMER_VERSION}_${userEmail || 'anon'}` }
  function progressKey() { return `repro_learn_progress_${userEmail || 'anon'}` }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // ----- Progress (localStorage) ---------------------------------------
  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(progressKey()) || '{}') }
    catch { return {} }
  }
  function saveProgress(progress) {
    try { localStorage.setItem(progressKey(), JSON.stringify(progress)) } catch {}
  }
  function setStatus(moduleId, status) {
    const p = loadProgress()
    if (status === 'none') delete p[moduleId]
    else p[moduleId] = { status, at: new Date().toISOString() }
    saveProgress(p)
    renderModules() // re-render to reflect changed status
  }

  // ----- Safe fetch (no auto-logout) -----------------------------------
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

  // ----- Init ---------------------------------------------------------
  async function init() {
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
      console.warn('learn: /auth/me failed', e)
    }

    if (!hasAcceptedDisclaimer()) { showDisclaimer(); return }
    await loadModulesFromServer()
    setupReaderProtection()
  }

  function hasAcceptedDisclaimer() {
    try { return !!localStorage.getItem(disclaimerKey()) } catch { return false }
  }

  function recordDisclaimerAccept() {
    try { localStorage.setItem(disclaimerKey(), JSON.stringify({ at: new Date().toISOString(), email: userEmail })) } catch {}
    safeFetch('/training/disclaimer-accept', { method: 'POST', body: JSON.stringify({ version: DISCLAIMER_VERSION }) }).catch(() => {})
  }

  function showDisclaimer() {
    const overlay = document.getElementById('disclaimer-overlay')
    const checkbox = document.getElementById('disclaimer-checkbox')
    const acceptBtn = document.getElementById('disclaimer-accept')
    const cancelBtn = document.getElementById('disclaimer-cancel')
    overlay.style.display = 'flex'

    checkbox.addEventListener('change', () => { acceptBtn.disabled = !checkbox.checked })
    acceptBtn.addEventListener('click', async () => {
      if (!checkbox.checked) return
      recordDisclaimerAccept()
      overlay.style.display = 'none'
      await loadModulesFromServer()
      setupReaderProtection()
    })
    cancelBtn.addEventListener('click', () => { window.location.href = 'index.html' })
  }

  // ----- Modules ------------------------------------------------------
  async function loadModulesFromServer() {
    try {
      modulesCache = await safeFetch('/training/modules')
      renderModules()
    } catch (err) {
      document.getElementById('modules-container').innerHTML = `
        <div class="learn-empty">
          <div class="learn-empty-icon">⚠️</div>
          <h3>לא הצלחנו לטעון את הקורסים</h3>
          <p>נסי לרענן את העמוד</p>
        </div>
      `
    }
  }

  function renderModules() {
    const container = document.getElementById('modules-container')
    if (!modulesCache || modulesCache.length === 0) {
      container.innerHTML = `
        <div class="learn-empty">
          <div class="learn-empty-icon">📚</div>
          <h3>הקורסים בדרך</h3>
          <p>טרם הועלו חומרי הכשרה. תכף נוסיף אותם — תחזרי לבדוק בקרוב.</p>
        </div>
      `
      return
    }

    const progress = loadProgress()
    const doneCount = modulesCache.filter(m => progress[m.id]?.status === 'done').length
    const total = modulesCache.length

    // Update progress strip
    const strip = document.getElementById('progress-strip')
    if (strip) {
      strip.style.display = total > 0 ? 'flex' : 'none'
      const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100)
      document.getElementById('progress-fill').style.width = pct + '%'
      document.getElementById('progress-count').textContent = `${doneCount} / ${total}`
    }

    container.innerHTML = `
      <div class="modules-grid">
        ${modulesCache.map((m) => renderCard(m, progress[m.id]?.status)).join('')}
      </div>
    `

    // Wire up handlers
    container.querySelectorAll('.module-card').forEach((card) => {
      const id = parseInt(card.dataset.id)

      card.querySelector('.module-btn-primary')?.addEventListener('click', (e) => {
        e.stopPropagation()
        // Mark as in-progress on first click, unless already done
        const p = loadProgress()
        if (!p[id]) setStatus(id, 'in_progress')
        openReader(id)
      })

      card.querySelector('.module-btn-done')?.addEventListener('click', (e) => {
        e.stopPropagation()
        const cur = loadProgress()[id]?.status
        setStatus(id, cur === 'done' ? 'in_progress' : 'done')
      })
    })
  }

  function renderCard(m, status) {
    const intro = m.intro?.length > 10 ? m.intro : 'תכנים מקצועיים בנושא זה — לחצי להתחלה'
    const introClipped = intro.length > 280
    const isDone = status === 'done'
    const isInProgress = status === 'in_progress'
    // Vary the icon by module index
    const icons = ['📞', '🎯', '✨', '💼', '🚀', '💡', '🤝', '📊', '🌟', '⚡']
    const icon = icons[(m.order - 1) % icons.length]

    return `
      <article class="module-card" data-id="${m.id}">
        ${isDone ? `<div class="module-status-ribbon done"><span>✓</span> סיימתי</div>` :
          isInProgress ? `<div class="module-status-ribbon in-progress"><span>📍</span> במהלך</div>` : ''}
        <div class="module-banner">
          <div class="module-banner-icon">${icon}</div>
        </div>
        <div class="module-body">
          <span class="module-number-badge">קורס ${m.order}</span>
          <h3 class="module-title">${escapeHtml(m.title)}</h3>
          <p class="module-intro">${escapeHtml(intro)}${introClipped ? '…' : ''}</p>
          <div class="module-meta">
            <span class="module-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              ${m.reading_minutes} דק׳
            </span>
            ${m.has_text ? `
              <span class="module-meta-item">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                </svg>
                ${m.word_count.toLocaleString()} מילים
              </span>` : ''}
          </div>
          <div class="module-actions">
            <button class="module-btn module-btn-primary">
              ${isDone ? 'חזור על הקורס' : isInProgress ? 'המשך →' : 'התחל →'}
            </button>
            <button class="module-btn module-btn-done ${isDone ? 'active' : ''}" title="${isDone ? 'בטל סימון סיימתי' : 'סמני כסיימתי'}">
              ${isDone ? '✓ סיימתי' : '✓'}
            </button>
          </div>
        </div>
      </article>
    `
  }

  // ----- Reader -------------------------------------------------------
  async function openReader(id) {
    const overlay = document.getElementById('reader-overlay')
    const titleEl = document.getElementById('reader-title')
    const numEl = document.getElementById('reader-num')
    const contentEl = document.getElementById('reader-content')
    const watermarkEl = document.getElementById('reader-watermark')

    overlay.style.display = 'flex'
    titleEl.textContent = '...'
    contentEl.innerHTML = '<div class="reader-fallback"><div class="reader-fallback-icon">⏳</div><h3>טוען...</h3></div>'

    // Watermark — repeats user email diagonally
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
      numEl.textContent = mod.order || '•'

      const content = (mod.content || '').trim()
      if (!content || content.length < 50) {
        // PDF was image-only (e.g. Canva slides) — show a friendly fallback
        // pointing the recruiter at the AI tutor button instead of a blank page.
        contentEl.innerHTML = `
          <div class="reader-fallback">
            <div class="reader-fallback-icon">📚</div>
            <h3>הקורס מוצג כתמונות</h3>
            <p>
              הקורס הזה מורכב משקפים גרפיים שלא ניתן להציג כטקסט.<br>
              <strong>אבל!</strong> את יכולה לשאול את המאמן AI כל שאלה על הנושא — הוא יודע את כל החומר 🤖
            </p>
            <button class="ask-btn" id="ask-ai-from-fallback">
              <span>💬</span> שאלי את המאמן AI
            </button>
          </div>
        `
        document.getElementById('ask-ai-from-fallback')?.addEventListener('click', () => {
          // Close reader and open the floating AI widget
          closeReader()
          const aiBtn = document.querySelector('.aiw-btn')
          if (aiBtn) aiBtn.click()
        })
      } else {
        // Light formatting: collapse 3+ blank lines to 2
        const cleaned = content.replace(/\n{3,}/g, '\n\n')
        contentEl.textContent = cleaned
      }
    } catch (err) {
      contentEl.innerHTML = `<div class="reader-fallback"><div class="reader-fallback-icon">⚠️</div><h3>שגיאה</h3><p>לא הצלחנו לטעון את הקורס.</p></div>`
    }
  }

  function closeReader() { document.getElementById('reader-overlay').style.display = 'none' }

  function setupReaderProtection() {
    const reader = document.getElementById('reader')
    const closeBtn = document.getElementById('reader-close')
    const overlay = document.getElementById('reader-overlay')

    closeBtn?.addEventListener('click', closeReader)
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeReader() })
    reader?.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('keydown', (e) => {
      if (overlay.style.display === 'none') return
      if ((e.ctrlKey || e.metaKey) && ['p', 's', 'a', 'P', 'S', 'A'].includes(e.key)) e.preventDefault()
      if (e.key === 'Escape') closeReader()
    })
    reader?.addEventListener('dragstart', (e) => e.preventDefault())
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
