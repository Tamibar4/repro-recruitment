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

    // Brand watermark — repeats 'RePro' diagonally over the reader.
    // Always shown (including for admin) so any screenshot carries the
    // brand mark as a clear 'this is RePro confidential material' signal.
    const wmText = 'RePro'
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

  // ----- Slide-deck renderer (iframe-based) ---------------------------
  // We use the BROWSER'S NATIVE PDF viewer inside iframes — it's the
  // only renderer that handles Hebrew RTL shaping correctly for Canva
  // exports. PDF.js's canvas renderer mangles Hebrew letters into
  // disconnected glyphs ("בח פ ם הבא ם" instead of "ברוכים הבאים").
  //
  // To get a slide-deck feel out of an iframe-per-page setup, we keep
  // TWO iframes layered on top of each other. The 'incoming' iframe
  // pre-loads the next page off-screen, then we animate the swap.
  // PDF.js is loaded only to get the page count (lightweight metadata
  // call) — never to render visuals.
  async function loadPdfJsLib() {
    if (window.pdfjsLib) return window.pdfjsLib
    await new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
      s.onload = resolve
      s.onerror = () => reject(new Error('PDF.js failed to load'))
      document.head.appendChild(s)
    })
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    return window.pdfjsLib
  }

  async function renderPdfVisual(moduleId, container) {
    const token = localStorage.getItem('auth_token')
    const url = '/api/training/modules/' + moduleId
      + '/view?token=' + encodeURIComponent(token)

    // PDF.js canvas rendering — gives us full control over layout (no
    // browser PDF chrome, no scrollbars, exact aspect ratio). cMap and
    // standardFontDataUrl are CRITICAL for Hebrew: without them PDF.js
    // can't map Canva's CID-keyed Hebrew fonts to the right glyphs and
    // the text comes out mangled.
    container.innerHTML = `
      <div class="pdf-stage">
        <div class="pdf-loading" id="pdf-loading">
          <div class="pdf-loading-spinner"></div>
          <div class="pdf-loading-text">טוען את המדריך...</div>
          <div class="pdf-loading-hint">בטעינה ראשונה זה לוקח מספר שניות. בכניסות הבאות זה יהיה מיידי ⚡</div>
        </div>
        <div class="pdf-page-counter" id="pdf-counter">— / —</div>
        <div class="pdf-slide-area" id="pdf-slide-area">
          <div class="pdf-slide-wrap" id="pdf-slide-wrap">
            <canvas class="pdf-slide is-active" id="pdf-slide-a" aria-label="דף נוכחי"></canvas>
            <canvas class="pdf-slide" id="pdf-slide-b" aria-label="דף הבא"></canvas>
          </div>
        </div>
        <div class="pdf-nav">
          <button class="pdf-nav-btn" id="pdf-prev" title="הקודם" disabled>›</button>
          <div class="pdf-nav-dots" id="pdf-dots"></div>
          <button class="pdf-nav-btn" id="pdf-next" title="הבא" disabled>‹</button>
        </div>
      </div>
    `

    const slideArea = container.querySelector('#pdf-slide-area')
    const slideWrap = container.querySelector('#pdf-slide-wrap')
    const counterEl = container.querySelector('#pdf-counter')
    const dotsEl = container.querySelector('#pdf-dots')
    const prevBtn = container.querySelector('#pdf-prev')
    const nextBtn = container.querySelector('#pdf-next')
    const loading = container.querySelector('#pdf-loading')
    let frontCanvas = container.querySelector('#pdf-slide-a')
    let backCanvas = container.querySelector('#pdf-slide-b')

    try {
      const pdfjsLib = await loadPdfJsLib()
      const PDFJS_VER = '3.11.174'
      const CDN_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VER
      const pdf = await pdfjsLib.getDocument({
        url,
        cMapUrl: CDN_BASE + '/cmaps/',
        cMapPacked: true,
        // standardFontDataUrl tells PDF.js where to fetch the 14 standard
        // PDF fonts when a document references them but doesn't embed
        // them. Most Canva exports DO embed fonts, but having this set
        // prevents fallbacks to Times New Roman that mangle Hebrew.
        standardFontDataUrl: CDN_BASE + '/standard_fonts/',
      }).promise
      const totalPages = pdf.numPages

      // Read page 1 to compute aspect ratio for the slide frame
      const page1 = await pdf.getPage(1)
      const baseVp = page1.getViewport({ scale: 1 })
      const pageRatio = baseVp.width / baseVp.height || (16 / 9)

      // Cache pages so re-rendering on resize / re-visiting is cheap
      const pageCache = new Map([[1, page1]])
      async function getPage(n) {
        if (!pageCache.has(n)) pageCache.set(n, await pdf.getPage(n))
        return pageCache.get(n)
      }

      // Size slideWrap to fit page aspect ratio inside slideArea
      const fitWrap = () => {
        const aw = slideArea.clientWidth
        const ah = slideArea.clientHeight
        if (aw === 0 || ah === 0) return
        let w = aw, h = aw / pageRatio
        if (h > ah) { h = ah; w = ah * pageRatio }
        slideWrap.style.width  = Math.floor(w * 0.97) + 'px'
        slideWrap.style.height = Math.floor(h * 0.97) + 'px'
      }
      fitWrap()

      // Render a specific PDF page into the given canvas at high-DPI
      async function renderToCanvas(pageNum, canvas) {
        const page = await getPage(pageNum)
        const baseViewport = page.getViewport({ scale: 1 })
        const cssW = slideWrap.clientWidth
        if (cssW === 0) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        // Scale so the rendered canvas matches CSS width (in CSS px)
        // multiplied by DPR for crisp rendering on retina displays.
        const renderScale = (cssW / baseViewport.width) * dpr
        const viewport = page.getViewport({ scale: renderScale })
        canvas.width  = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        const ctx = canvas.getContext('2d', { alpha: false })
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        // Cancel any in-flight render on this canvas before starting new
        if (canvas._renderTask) {
          try { canvas._renderTask.cancel() } catch {}
        }
        const task = page.render({ canvasContext: ctx, viewport })
        canvas._renderTask = task
        try {
          await task.promise
        } catch (e) {
          if (e?.name !== 'RenderingCancelledException') throw e
        }
        canvas._renderTask = null
      }

      // Render initial page
      await renderToCanvas(1, frontCanvas)
      if (loading) {
        loading.classList.add('fade-out')
        setTimeout(() => loading.remove(), 400)
      }

      let currentPage = 1
      let animating = false

      // Re-render current page when the window resizes (debounced)
      let resizeTimer = null
      const onResize = () => {
        clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          fitWrap()
          renderToCanvas(currentPage, frontCanvas)
        }, 200)
      }
      window.addEventListener('resize', onResize)

      const renderDots = () => {
        dotsEl.innerHTML = ''
        for (let i = 1; i <= totalPages; i++) {
          const dot = document.createElement('button')
          dot.className = 'pdf-nav-dot' + (i === currentPage ? ' active' : '')
          dot.dataset.page = i
          dot.title = 'דף ' + i
          dot.addEventListener('click', () => goTo(i))
          dotsEl.appendChild(dot)
        }
      }

      const updateUi = () => {
        counterEl.textContent = `${currentPage} / ${totalPages}`
        prevBtn.disabled = currentPage === 1 || animating
        nextBtn.disabled = currentPage === totalPages || animating
        dotsEl.querySelectorAll('.pdf-nav-dot').forEach((d) => {
          d.classList.toggle('active', parseInt(d.dataset.page) === currentPage)
        })
      }

      // Navigate to a page with slide animation. Renders the new page
      // into the back canvas, then crossfades/slides between the two.
      // RTL convention: 'next' enters from the left (because reading
      // direction is right-to-left, the next page lives on the left).
      async function goTo(newPage) {
        if (animating) return
        if (newPage < 1 || newPage > totalPages) return
        if (newPage === currentPage) return
        const direction = newPage > currentPage ? 'next' : 'prev'
        animating = true
        updateUi()

        // Render the new page into the back canvas BEFORE animating
        try {
          await renderToCanvas(newPage, backCanvas)
        } catch (e) {
          console.error('Page render failed:', e)
          animating = false
          updateUi()
          return
        }

        // Reset all classes
        frontCanvas.classList.remove('is-active', 'enter-left', 'enter-right', 'exit-left', 'exit-right')
        backCanvas .classList.remove('is-active', 'enter-left', 'enter-right', 'exit-left', 'exit-right')

        // Park back canvas off-screen on the entry side
        backCanvas.classList.add(direction === 'next' ? 'enter-left' : 'enter-right')
        // Force reflow so the initial position is registered
        // eslint-disable-next-line no-unused-expressions
        void backCanvas.offsetWidth

        // Trigger transitions
        requestAnimationFrame(() => {
          frontCanvas.classList.add(direction === 'next' ? 'exit-right' : 'exit-left')
          backCanvas.classList.remove('enter-left', 'enter-right')
          backCanvas.classList.add('is-active')
        })

        setTimeout(() => {
          // Swap roles
          const oldFront = frontCanvas
          frontCanvas = backCanvas
          backCanvas = oldFront
          backCanvas.classList.remove('is-active', 'exit-right', 'exit-left')
          currentPage = newPage
          animating = false
          updateUi()
        }, 600)
      }

      renderDots()
      updateUi()

      // Wire up navigation
      prevBtn.addEventListener('click', () => goTo(currentPage - 1))
      nextBtn.addEventListener('click', () => goTo(currentPage + 1))

      // Keyboard: arrows. In RTL, left arrow = next, right arrow = prev
      const keyHandler = (e) => {
        if (document.getElementById('reader-overlay').style.display === 'none') return
        if (e.key === 'ArrowLeft')  { e.preventDefault(); goTo(currentPage + 1) }
        if (e.key === 'ArrowRight') { e.preventDefault(); goTo(currentPage - 1) }
      }
      document.addEventListener('keydown', keyHandler)

      // Swipe (touch devices). RTL: swipe right -> previous, left -> next
      let touchStartX = 0
      slideArea.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX })
      slideArea.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].screenX - touchStartX
        if (Math.abs(dx) < 50) return
        if (dx > 0) goTo(currentPage - 1)
        else        goTo(currentPage + 1)
      })

      // Pre-render adjacent pages in the background so navigation feels
      // instant. We don't wait for these — they hydrate the page cache.
      // Done in two stages: first the immediate neighbors, then the rest.
      ;(async () => {
        try {
          if (totalPages > 1) await getPage(2)
          for (let i = 3; i <= totalPages; i++) await getPage(i)
        } catch {}
      })()
    } catch (err) {
      console.error('PDF render error:', err)
      container.innerHTML = `
        <div class="reader-fallback">
          <div class="reader-fallback-icon">⚠️</div>
          <h3>לא הצלחנו לטעון את המדריך</h3>
          <p>נסי לרענן את העמוד.</p>
        </div>
      `
    }
  }

  function closeReader() { document.getElementById('reader-overlay').style.display = 'none' }

  // Pre-built cover element — kept hidden in the DOM and toggled via a
  // single CSS class change. Avoids the createElement() round-trip when
  // a screenshot signal fires, which is critical for catching Win+Shift+S
  // before the snipping tool grabs the frame.
  let screenshotCoverEl = null
  function getScreenshotCover() {
    if (screenshotCoverEl) return screenshotCoverEl
    const el = document.createElement('div')
    el.id = 'screenshot-cover'
    el.style.cssText = [
      'position: fixed', 'inset: 0', 'z-index: 999999',
      'background: linear-gradient(135deg, #1a1f3a, #5e5ce6, #ec4899)',
      'display: none',
      'align-items: center', 'justify-content: center',
      'flex-direction: column',
      'color: white', 'font-family: Rubik, sans-serif',
      'text-align: center', 'padding: 40px',
      'cursor: pointer',
      'will-change: opacity',
    ].join(';')
    el.innerHTML = `
      <div style="font-size:96px;margin-bottom:24px;line-height:1">🚫📷</div>
      <div style="font-size:28px;font-weight:800;margin-bottom:12px">צילום מסך חסום</div>
      <div style="font-size:15px;font-weight:500;opacity:0.92;max-width:520px;line-height:1.7;margin-bottom:24px">
        חומר זה מוגן בזכויות יוצרים של RePro. צילום, שיתוף או הפצה — אסורים על פי חוק.<br>
        חתימת המים על המסך מאפשרת איתור מקור הדליפה.
      </div>
      <div style="font-size:13px;font-weight:600;opacity:0.7;background:rgba(255,255,255,0.15);padding:10px 22px;border-radius:99px;backdrop-filter:blur(8px)">
        לחצי כדי להמשיך
      </div>
    `
    document.body.appendChild(el)
    // Click to dismiss — user has to acknowledge before continuing
    el.addEventListener('click', () => {
      el.style.display = 'none'
    })
    screenshotCoverEl = el
    return el
  }

  function setupReaderProtection() {
    const reader = document.getElementById('reader')
    const closeBtn = document.getElementById('reader-close')
    const overlay = document.getElementById('reader-overlay')

    closeBtn?.addEventListener('click', closeReader)
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeReader() })
    reader?.addEventListener('contextmenu', (e) => e.preventDefault())

    // Show the cover SYNCHRONOUSLY (no createElement, no setTimeout). The
    // cover stays visible until the user clicks it — that way even if the
    // screenshot tool grabbed the frame BEFORE the cover painted, the user
    // is forced to acknowledge it. They get reminded that screenshots are
    // a violation, on every attempt.
    const showCover = () => {
      if (overlay.style.display === 'none') return
      const c = getScreenshotCover()
      c.style.display = 'flex'
    }

    // ONLY trigger on direct screenshot keypresses (PrintScreen, Ctrl+P,
    // etc.). The previous version triggered on window blur / mouse leave /
    // visibilitychange — which broke normal reading because every tab
    // switch or cursor wander made the cover pop up. Watermark + legal
    // disclaimer carry most of the deterrent weight; the cover is just a
    // 'caught you' for the obvious shortcut presses.
    document.addEventListener('keydown', (e) => {
      if (overlay.style.display === 'none') return
      if ((e.ctrlKey || e.metaKey) && ['p', 's', 'a', 'P', 'S', 'A'].includes(e.key)) {
        e.preventDefault()
        showCover()
        return
      }
      if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
        e.preventDefault()
        showCover()
        try { navigator.clipboard?.writeText('') } catch {}
        return
      }
      if (e.key === 'Escape') closeReader()
    })

    reader?.addEventListener('dragstart', (e) => e.preventDefault())
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
