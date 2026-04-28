/**
 * RePro AI Tutor — floating chat widget
 *
 * Self-contained: a single <script src="js/ai-widget.js"> on any page injects
 * a floating button (bottom-left) and a chat panel that talks to the
 * /api/training/chat endpoint. Auth uses the existing auth_token in
 * localStorage; the widget hides itself if the user isn't logged in.
 *
 * Modes (Q&A / Consultation / Scenario / Quiz) reuse the same backend
 * `mode` parameter as the full training page.
 */
(function () {
  'use strict'

  // Don't render on auth pages.
  const HIDE_ON_PATHS = ['/login.html', '/signup.html', '/forgot-password.html', '/reset-password.html']
  if (HIDE_ON_PATHS.some((p) => window.location.pathname.endsWith(p))) return

  // Don't render if no auth token.
  if (!localStorage.getItem('auth_token')) return

  // ----- Modes ------------------------------------------------------------
  const MODES = {
    qa: {
      icon: '💬',
      title: 'שאלות ותשובות',
      desc: 'שאלי על חומרי ההכשרה',
      placeholder: 'שאלי משהו על חומרי ההכשרה...',
      suggestions: [
        'איך פותחים שיחה עם מועמד חדש?',
        'מה חשוב לזכור בשלב הראשון?',
        'איך מסננים מועמדים נכון?',
      ],
    },
    consult: {
      icon: '🧭',
      title: 'התייעצות',
      desc: 'יעוץ למצבים שאת נתקלת בהם',
      placeholder: 'תארי את המצב שתרצי להתייעץ עליו...',
      suggestions: [
        'מועמד דורש שכר גבוה — איך להגיב?',
        'איך מטפלים במועמד שמתלבט בין משרות?',
      ],
    },
    scenario: {
      icon: '🎭',
      title: 'תרגול תרחישים',
      desc: 'משחק תפקידים — אני המועמד',
      placeholder: 'בקשי תרחיש לתרגול...',
      suggestions: [
        'תרגלי שיחה ראשונה עם מועמד לצימיני',
        'שחקי מעסיק שדוחה מועמד',
      ],
    },
    quiz: {
      icon: '📝',
      title: 'בוחן',
      desc: 'בדיקת הבנה של החומר',
      placeholder: 'תאמרי "התחילי" כשאת מוכנה...',
      suggestions: [
        'התחילי בוחן',
        'בוחן על שלב הסינון',
        'בוחן על פתיחת שיחה',
      ],
    },
  }

  // ----- State ------------------------------------------------------------
  let isOpen = false
  let isSending = false
  let currentMode = 'qa'
  let conversationId = null
  let aiEnabled = false
  const messages = [] // {role, content}

  // ----- Styles (one-time injection) --------------------------------------
  const STYLE_ID = 'ai-widget-styles'
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return
    const css = `
      .aiw-btn {
        position: fixed; bottom: 22px; left: 22px; z-index: 9998;
        width: 60px; height: 60px; border-radius: 50%;
        background: linear-gradient(135deg, #9b59b6 0%, #5559df 50%, #0073ea 100%);
        border: none; cursor: pointer; color: white;
        box-shadow: 0 8px 24px rgba(85, 89, 223, 0.45), 0 0 0 4px rgba(255,255,255,0.4);
        display: flex; align-items: center; justify-content: center;
        transition: transform 0.2s, box-shadow 0.2s;
        font-size: 28px; font-family: inherit;
      }
      .aiw-btn:hover { transform: translateY(-2px) scale(1.05); box-shadow: 0 12px 32px rgba(85, 89, 223, 0.6); }
      .aiw-btn-pulse::after {
        content: ''; position: absolute; inset: -4px;
        border-radius: 50%; border: 3px solid #9b59b6;
        animation: aiw-pulse 2s infinite;
      }
      @keyframes aiw-pulse {
        0% { transform: scale(1); opacity: 1; }
        100% { transform: scale(1.4); opacity: 0; }
      }
      @media (max-width: 640px) { .aiw-btn { bottom: 84px; left: 14px; width: 54px; height: 54px; font-size: 24px; } }

      .aiw-panel {
        position: fixed; bottom: 22px; left: 22px; z-index: 9999;
        width: 380px; height: min(620px, calc(100vh - 44px));
        background: white; border-radius: 22px;
        box-shadow: 0 25px 60px -10px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.05);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: aiw-slide-up 0.25s cubic-bezier(0.18, 0.89, 0.32, 1.28);
      }
      @keyframes aiw-slide-up {
        from { opacity: 0; transform: translateY(20px) scale(0.95); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (max-width: 640px) {
        .aiw-panel {
          width: calc(100vw - 16px); left: 8px; right: 8px;
          bottom: 8px; height: calc(100vh - 16px);
          border-radius: 18px;
        }
      }

      .aiw-header {
        background: linear-gradient(135deg, #9b59b6 0%, #5559df 50%, #0073ea 100%);
        color: white; padding: 18px 20px;
        display: flex; align-items: center; gap: 12px;
        position: relative;
      }
      .aiw-avatar {
        width: 38px; height: 38px; border-radius: 50%;
        background: rgba(255,255,255,0.25); backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        font-size: 22px; flex-shrink: 0;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      }
      .aiw-title-block { flex: 1; min-width: 0; }
      .aiw-title { font-size: 16px; font-weight: 700; line-height: 1.2; }
      .aiw-subtitle { font-size: 12px; opacity: 0.85; margin-top: 2px; }
      .aiw-close {
        background: rgba(255,255,255,0.2); border: none; color: white;
        width: 32px; height: 32px; border-radius: 50%;
        cursor: pointer; font-size: 16px; font-family: inherit;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s;
      }
      .aiw-close:hover { background: rgba(255,255,255,0.35); }

      .aiw-modes {
        display: flex; gap: 6px; padding: 10px 14px;
        background: #f5f6f8; border-bottom: 1px solid #e6e9ef;
        overflow-x: auto;
      }
      .aiw-mode {
        flex: 1; min-width: max-content;
        padding: 7px 10px; border-radius: 12px;
        background: white; border: 1px solid #e6e9ef;
        font-size: 12px; font-weight: 600; color: #676879;
        cursor: pointer; font-family: inherit;
        transition: all 0.15s; white-space: nowrap;
        display: flex; align-items: center; justify-content: center; gap: 4px;
      }
      .aiw-mode:hover { border-color: #9b59b6; color: #9b59b6; }
      .aiw-mode.active {
        background: linear-gradient(135deg, #9b59b6, #5559df);
        color: white; border-color: transparent;
        box-shadow: 0 2px 8px rgba(155, 89, 182, 0.35);
      }

      .aiw-body {
        flex: 1; overflow-y: auto; padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
        background: #fafbfc;
      }
      .aiw-empty {
        text-align: center; padding: 20px 16px;
        color: #676879;
      }
      .aiw-empty-icon { font-size: 42px; margin-bottom: 10px; }
      .aiw-empty-title { font-size: 15px; font-weight: 700; color: #1a1d2e; margin-bottom: 4px; }
      .aiw-empty-desc { font-size: 12px; line-height: 1.5; }
      .aiw-suggestions {
        display: flex; flex-direction: column; gap: 7px; margin-top: 16px;
      }
      .aiw-sugg {
        padding: 9px 13px; background: white;
        border: 1px solid #e6e9ef; border-radius: 12px;
        font-size: 12px; font-weight: 500; color: #1a1d2e;
        cursor: pointer; font-family: inherit; text-align: right;
        transition: all 0.15s;
      }
      .aiw-sugg:hover { border-color: #9b59b6; color: #9b59b6; transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }

      .aiw-msg { display: flex; gap: 8px; max-width: 85%; }
      .aiw-msg.user { align-self: flex-end; flex-direction: row; }
      .aiw-msg.assistant { align-self: flex-start; flex-direction: row-reverse; }
      [dir="rtl"] .aiw-msg.user { align-self: flex-start; flex-direction: row-reverse; }
      [dir="rtl"] .aiw-msg.assistant { align-self: flex-end; flex-direction: row; }
      .aiw-msg-avatar {
        width: 28px; height: 28px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px; flex-shrink: 0; font-weight: 700;
      }
      .aiw-msg-avatar.user { background: linear-gradient(135deg, #0073ea, #5559df); color: white; }
      .aiw-msg-avatar.assistant { background: linear-gradient(135deg, #9b59b6, #a358df); color: white; }
      .aiw-bubble {
        padding: 10px 13px; border-radius: 14px;
        font-size: 13.5px; line-height: 1.55;
        white-space: pre-wrap; word-break: break-word;
      }
      .aiw-bubble.user {
        background: linear-gradient(135deg, #0073ea, #5559df);
        color: white;
      }
      .aiw-bubble.assistant {
        background: white; color: #1a1d2e;
        border: 1px solid #e6e9ef;
      }
      .aiw-thinking {
        display: flex; gap: 4px; padding: 12px 14px;
        background: white; border: 1px solid #e6e9ef; border-radius: 14px;
        align-items: center;
      }
      .aiw-thinking span {
        width: 6px; height: 6px; border-radius: 50%; background: #9699a6;
        animation: aiw-dot 1.4s ease-in-out infinite;
      }
      .aiw-thinking span:nth-child(2) { animation-delay: 0.2s; }
      .aiw-thinking span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes aiw-dot { 0%,60%,100% { opacity: 0.3; transform: scale(0.8); } 30% { opacity: 1; transform: scale(1); } }

      .aiw-input-row {
        padding: 12px; background: white;
        border-top: 1px solid #e6e9ef;
        display: flex; gap: 8px; align-items: flex-end;
      }
      .aiw-input {
        flex: 1; padding: 10px 13px;
        border: 1.5px solid #e6e9ef; border-radius: 12px;
        font-family: inherit; font-size: 13.5px;
        resize: none; min-height: 40px; max-height: 120px;
        transition: border-color 0.15s;
      }
      .aiw-input:focus {
        outline: none; border-color: #9b59b6;
        box-shadow: 0 0 0 3px rgba(155, 89, 182, 0.12);
      }
      .aiw-send {
        width: 40px; height: 40px; border-radius: 50%;
        background: linear-gradient(135deg, #9b59b6, #5559df);
        border: none; color: white; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; transition: transform 0.15s;
      }
      .aiw-send:hover:not(:disabled) { transform: scale(1.1); }
      .aiw-send:disabled { opacity: 0.5; cursor: not-allowed; }
      .aiw-send svg { width: 18px; height: 18px; }

      .aiw-disabled-banner {
        background: #fff8e6; border: 1px solid #ffd789;
        color: #b87414; padding: 10px 14px;
        font-size: 12px; font-weight: 600; text-align: center;
      }
    `
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = css
    document.head.appendChild(el)
  }

  // ----- DOM helpers ------------------------------------------------------
  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // ----- API --------------------------------------------------------------
  async function api(path, options = {}) {
    const token = localStorage.getItem('auth_token')
    const opts = { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options }
    if (token) opts.headers.Authorization = 'Bearer ' + token
    const res = await fetch('/api' + path, opts)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || err.error || 'Request failed')
    }
    return res.json()
  }

  async function checkStatus() {
    try {
      const s = await api('/training/status')
      aiEnabled = !!s.ai_enabled
    } catch { aiEnabled = false }
  }

  async function sendMessage(text) {
    isSending = true
    renderBody()
    try {
      const res = await api('/training/chat', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: conversationId, message: text, mode: currentMode }),
      })
      conversationId = res.conversation_id
      messages.push({ role: 'assistant', content: res.message })
    } catch (err) {
      messages.push({ role: 'assistant', content: '⚠️ ' + (err.message || 'שגיאה בקבלת תשובה') })
    } finally {
      isSending = false
      renderBody()
    }
  }

  // ----- Render -----------------------------------------------------------
  let panelEl = null
  let buttonEl = null

  function renderButton() {
    if (buttonEl) return
    buttonEl = document.createElement('button')
    buttonEl.className = 'aiw-btn aiw-btn-pulse'
    buttonEl.title = 'מאמן AI'
    buttonEl.innerHTML = '🤖'
    buttonEl.addEventListener('click', () => {
      isOpen = !isOpen
      if (isOpen) renderPanel()
      else if (panelEl) { panelEl.remove(); panelEl = null }
      buttonEl.style.display = isOpen ? 'none' : 'flex'
    })
    document.body.appendChild(buttonEl)
  }

  function renderPanel() {
    if (panelEl) panelEl.remove()
    panelEl = document.createElement('div')
    panelEl.className = 'aiw-panel'
    const m = MODES[currentMode]
    panelEl.innerHTML = `
      <header class="aiw-header">
        <div class="aiw-avatar">${m.icon}</div>
        <div class="aiw-title-block">
          <div class="aiw-title">${escapeHtml(m.title)}</div>
          <div class="aiw-subtitle">${escapeHtml(m.desc)}</div>
        </div>
        <button class="aiw-close" aria-label="סגור" data-action="close">✕</button>
      </header>
      ${aiEnabled ? '' : '<div class="aiw-disabled-banner">⚠️ סוכן AI עדיין לא פעיל. פנה למנהל המערכת.</div>'}
      <div class="aiw-modes">
        ${Object.entries(MODES).map(([key, mode]) => `
          <button class="aiw-mode ${key === currentMode ? 'active' : ''}" data-mode="${key}">
            <span>${mode.icon}</span><span>${escapeHtml(mode.title)}</span>
          </button>
        `).join('')}
      </div>
      <div class="aiw-body" id="aiw-body"></div>
      <div class="aiw-input-row">
        <textarea class="aiw-input" id="aiw-input" rows="1" placeholder="${escapeHtml(m.placeholder)}" ${aiEnabled ? '' : 'disabled'}></textarea>
        <button class="aiw-send" id="aiw-send" aria-label="שלח" ${aiEnabled ? '' : 'disabled'}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </div>
    `
    document.body.appendChild(panelEl)

    // Wire up handlers
    panelEl.querySelector('[data-action="close"]').addEventListener('click', () => {
      isOpen = false
      panelEl.remove(); panelEl = null
      buttonEl.style.display = 'flex'
    })

    panelEl.querySelectorAll('.aiw-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode
        if (mode === currentMode) return
        currentMode = mode
        // Reset conversation when switching modes
        conversationId = null
        messages.length = 0
        renderPanel() // re-render to update title/header/placeholder
      })
    })

    const input = panelEl.querySelector('#aiw-input')
    const sendBtn = panelEl.querySelector('#aiw-send')
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    })
    sendBtn.addEventListener('click', handleSend)

    function handleSend() {
      if (isSending || !aiEnabled) return
      const text = input.value.trim()
      if (!text) return
      messages.push({ role: 'user', content: text })
      input.value = ''
      input.style.height = 'auto'
      sendMessage(text)
    }

    renderBody()
    setTimeout(() => input.focus(), 50)
  }

  function renderBody() {
    if (!panelEl) return
    const body = panelEl.querySelector('#aiw-body')
    const m = MODES[currentMode]
    if (messages.length === 0 && !isSending) {
      body.innerHTML = `
        <div class="aiw-empty">
          <div class="aiw-empty-icon">${m.icon}</div>
          <div class="aiw-empty-title">${escapeHtml(m.title)}</div>
          <div class="aiw-empty-desc">${escapeHtml(m.desc)}</div>
          <div class="aiw-suggestions">
            ${m.suggestions.map((s) => `<button class="aiw-sugg" data-text="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
          </div>
        </div>
      `
      body.querySelectorAll('.aiw-sugg').forEach((b) => {
        b.addEventListener('click', () => {
          if (!aiEnabled) return
          const text = b.dataset.text
          messages.push({ role: 'user', content: text })
          sendMessage(text)
        })
      })
      return
    }

    let html = messages.map((msg) => `
      <div class="aiw-msg ${msg.role}">
        <div class="aiw-msg-avatar ${msg.role}">${msg.role === 'user' ? '👤' : '🤖'}</div>
        <div class="aiw-bubble ${msg.role}">${escapeHtml(msg.content)}</div>
      </div>
    `).join('')
    if (isSending) {
      html += `
        <div class="aiw-msg assistant">
          <div class="aiw-msg-avatar assistant">🤖</div>
          <div class="aiw-thinking"><span></span><span></span><span></span></div>
        </div>
      `
    }
    body.innerHTML = html
    body.scrollTop = body.scrollHeight
  }

  // ----- Boot -------------------------------------------------------------
  function boot() {
    injectStyles()
    renderButton()
    checkStatus().then(() => {
      // If panel was already opened, re-render to reflect AI status.
      if (isOpen && panelEl) renderPanel()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
