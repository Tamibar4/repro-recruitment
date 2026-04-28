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
  let userIsAdmin = false
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
      userEmail = me?.email || ''
      userName = me?.display_name || me?.username || ''
      userIsAdmin = me?.role === 'admin'
      if (typeof renderUserBadge === 'function') renderUserBadge(me)
      if (userIsAdmin) {
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
          <h3>לא הצלחנו לטעון את המדריכים</h3>
          <p>נסי לרענן את העמוד</p>
        </div>
      `
    }
  }

  function renderModules() {
    const stack = document.getElementById('journey-stack')
    if (!modulesCache || modulesCache.length === 0) {
      stack.innerHTML = `
        <div class="learn-empty">
          <div class="learn-empty-icon">📚</div>
          <h3>המדריכים בדרך</h3>
          <p>טרם הועלו חומרי הכשרה. תכף נוסיף אותם — תחזרי לבדוק בקרוב.</p>
        </div>
      `
      return
    }

    const progress = loadProgress()
    const doneCount = modulesCache.filter(m => progress[m.id]?.status === 'done').length
    const total = modulesCache.length

    // Top progress bar
    const pctEl = document.getElementById('journey-pct')
    const fillEl = document.getElementById('journey-fill')
    if (pctEl) pctEl.textContent = `${doneCount}/${total}`
    if (fillEl) fillEl.style.width = (total ? Math.round((doneCount / total) * 100) : 0) + '%'

    // Render cards alternating left / center / right along the path
    const sides = ['right', 'left', 'center']
    stack.innerHTML = modulesCache
      .map((m, i) => renderCard(m, progress[m.id]?.status, sides[i % sides.length]))
      .join('')

    // Wire up handlers
    stack.querySelectorAll('.course-card').forEach((card) => {
      const id = parseInt(card.dataset.id)

      card.querySelector('.course-btn-primary')?.addEventListener('click', (e) => {
        e.stopPropagation()
        const p = loadProgress()
        if (!p[id]) setStatus(id, 'in_progress')
        openReader(id)
      })

      card.querySelector('.course-btn-done')?.addEventListener('click', (e) => {
        e.stopPropagation()
        const cur = loadProgress()[id]?.status
        setStatus(id, cur === 'done' ? 'in_progress' : 'done')
      })

      card.querySelector('.course-btn-skip')?.addEventListener('click', (e) => {
        e.stopPropagation()
        // "Skip" just scrolls to the next card
        const next = card.nextElementSibling
        if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    })

    // Draw the curving path connecting the cards (deferred to next frame
    // so the cards have measurable positions).
    requestAnimationFrame(() => drawJourneyPath())
  }

  function renderCard(m, status, side) {
    const isDone = status === 'done'
    const isInProgress = status === 'in_progress'
    const icons = ['📞', '🎯', '✨', '💼', '🚀', '💡', '🤝', '📊', '🌟', '⚡']
    const icon = icons[(m.order - 1) % icons.length]

    return `
      <article class="course-card ${side}" data-id="${m.id}">
        ${isDone ? `<div class="course-status-ribbon done"><span>✓</span> הושלם</div>` :
          isInProgress ? `<div class="course-status-ribbon in-progress"><span>▶</span> בתהליך</div>` : ''}
        <div class="course-banner">
          <div class="course-banner-icon">${icon}</div>
        </div>
        <div class="course-body">
          <div class="course-title-row">
            <div class="course-num-badge">${m.order}</div>
            <h3 class="course-title">${escapeHtml(m.title)}</h3>
          </div>
          <div class="course-meta">
            <span class="course-meta-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              מדריך · ${m.reading_minutes} דקות
            </span>
          </div>
          <div class="course-actions">
            <button class="course-btn course-btn-skip" title="המשך למדריך הבא">דלג</button>
            <button class="course-btn course-btn-done ${isDone ? 'active' : ''}" title="${isDone ? 'בטל סימון' : 'סמני כסיימתי'}">
              ${isDone ? '✓ סיימתי' : '✓ סיימתי'}
            </button>
            <button class="course-btn course-btn-primary">
              ${isDone ? 'חזור →' : isInProgress ? 'המשך →' : 'התחל →'}
            </button>
          </div>
        </div>
      </article>
    `
  }

  // Draw a curving SVG path connecting the cards from top to bottom.
  // Recomputes on resize so the path stays aligned.
  function drawJourneyPath() {
    const wrap = document.getElementById('journey-wrap')
    const svg = document.getElementById('journey-svg')
    if (!wrap || !svg) return

    const cards = wrap.querySelectorAll('.course-card')
    if (cards.length < 2) { svg.innerHTML = ''; return }

    const wrapRect = wrap.getBoundingClientRect()
    svg.setAttribute('viewBox', `0 0 ${wrapRect.width} ${wrapRect.height}`)
    svg.setAttribute('width', wrapRect.width)
    svg.setAttribute('height', wrapRect.height)

    // Build a smooth wavy path through each card's center
    let pathData = ''
    const points = Array.from(cards).map((card) => {
      const r = card.getBoundingClientRect()
      const cx = r.left + r.width / 2 - wrapRect.left
      const cy = r.top + r.height / 2 - wrapRect.top
      return { cx, cy }
    })

    points.forEach((p, i) => {
      if (i === 0) {
        pathData += `M ${p.cx} ${p.cy}`
      } else {
        const prev = points[i - 1]
        const midY = (prev.cy + p.cy) / 2
        // S-curve via 2 control points for natural waves
        pathData += ` C ${prev.cx} ${midY}, ${p.cx} ${midY}, ${p.cx} ${p.cy}`
      }
    })

    svg.innerHTML = `
      <defs>
        <linearGradient id="jp-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#a78bfa" stop-opacity="0.5"/>
          <stop offset="50%" stop-color="#60a5fa" stop-opacity="0.6"/>
          <stop offset="100%" stop-color="#f472b6" stop-opacity="0.5"/>
        </linearGradient>
      </defs>
      <path d="${pathData}" stroke="url(#jp-grad)" stroke-width="14"
            stroke-linecap="round" fill="none"
            stroke-dasharray="0" />
      <path d="${pathData}" stroke="white" stroke-width="3"
            stroke-linecap="round" fill="none"
            stroke-dasharray="6 8" opacity="0.7"/>
    `
  }
  // Redraw the path when the window resizes
  window.addEventListener('resize', () => {
    if (modulesCache.length > 0) requestAnimationFrame(() => drawJourneyPath())
  })

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

    // Watermark — repeats user identifier diagonally over the reader.
    // Skip entirely for admin (you don't need to watermark your OWN content)
    // and use email > display_name > username for everyone else.
    if (userIsAdmin) {
      watermarkEl.innerHTML = ''
    } else {
      const wmText = userEmail || userName || 'RePro'
      const wmTiles = []
      for (let r = 0; r < 14; r++) {
        for (let c = 0; c < 6; c++) {
          wmTiles.push(`<span style="top:${r * 80}px;right:${c * 280 - 100}px">${escapeHtml(wmText)}</span>`)
        }
      }
      watermarkEl.innerHTML = wmTiles.join('')
    }

    try {
      const mod = await safeFetch('/training/modules/' + id)
      titleEl.textContent = mod.title
      numEl.textContent = mod.order || '•'

      // Always render the PDF visually (PDF.js → canvas). Canva slides
      // don't have extractable text, so showing the actual rendered page
      // is the only way to display them.
      contentEl.innerHTML = '<div class="pdf-pages" id="pdf-pages"></div>'
      await renderPdfVisual(id, document.getElementById('pdf-pages'))
    } catch (err) {
      console.error(err)
      contentEl.innerHTML = `<div class="reader-fallback"><div class="reader-fallback-icon">⚠️</div><h3>שגיאה</h3><p>לא הצלחנו לטעון את המדריך.</p></div>`
    }
  }

  // ----- PDF renderer (iframe) ----------------------------------------
  // Use the browser's native PDF viewer via <iframe>. This is the only
  // approach that handles Hebrew text correctly — PDF.js mangles RTL
  // shaping with Canva-exported PDFs (letters appear individually
  // separated). The native viewer uses the OS font stack and gets
  // shaping right.
  //
  // URL fragment '#toolbar=0&navpanes=0&scrollbar=0' hides the Chrome
  // toolbar (download/print buttons). Combined with the watermark
  // overlay + sandbox attribute, this stays as protected as we can
  // make a browser-rendered PDF.
  //
  // Loading UX: spinner overlay sits ON TOP of the (initially invisible)
  // iframe and fades out once the iframe fires its 'load' event. The
  // server sends Cache-Control: private + ETag so a second view of the
  // same guide is instant.
  function renderPdfVisual(moduleId, container) {
    const token = localStorage.getItem('auth_token')
    const url = '/api/training/modules/' + moduleId
      + '/view?token=' + encodeURIComponent(token)
      + '#toolbar=0&navpanes=0&scrollbar=0&view=FitH'

    container.innerHTML = `
      <div class="pdf-stage">
        <div class="pdf-loading" id="pdf-loading">
          <div class="pdf-loading-spinner"></div>
          <div class="pdf-loading-text">טוען את המדריך...</div>
          <div class="pdf-loading-hint">בטעינה ראשונה זה לוקח מספר שניות. בכניסות הבאות זה יהיה מיידי ⚡</div>
        </div>
        <iframe id="pdf-frame" class="pdf-iframe" title="מצגת המדריך" src="${url}"></iframe>
      </div>
    `

    const iframe = container.querySelector('#pdf-frame')
    const loading = container.querySelector('#pdf-loading')
    let done = false
    const finish = () => {
      if (done) return
      done = true
      iframe.classList.add('ready')
      if (loading) {
        loading.classList.add('fade-out')
        // Remove from DOM after the fade transition so it doesn't block clicks
        setTimeout(() => loading.remove(), 400)
      }
    }
    iframe.addEventListener('load', finish)
    iframe.addEventListener('error', () => {
      container.innerHTML = `
        <div class="reader-fallback">
          <div class="reader-fallback-icon">⚠️</div>
          <h3>לא הצלחנו לטעון את המדריך</h3>
          <p>נסי לרענן את העמוד.</p>
        </div>
      `
    })
    // Safety net — some browsers don't fire 'load' for plugins.
    // After 8s, force-show the iframe regardless.
    setTimeout(finish, 8000)
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
