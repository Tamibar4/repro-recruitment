/**
 * Training page logic - AI tutor chat + document management
 */

const MODE_META = {
  qa:       { icon: '💬', title: 'שאלות ותשובות', desc: 'שאלי אותי על כל נושא מחומרי ההכשרה', suggestions: [
    'מה הן הדרכים הכי יעילות לסנן מועמדים?',
    'איך פותחים שיחה עם מועמד חדש?',
    'מה חשוב לזכור בשלב הראשון של השיחה?',
    'איך מתמודדים עם התנגדויות?'
  ]},
  consult:  { icon: '🧭', title: 'התייעצות', desc: 'יעוץ מעשי למצבים שאת נתקלת בהם', suggestions: [
    'יש לי מועמד שמתלבט בין שתי משרות - איך אני עוזרת לו להחליט?',
    'המעסיק דוחה מועמדים בלי לתת הסבר - מה עושים?',
    'מועמד שביקש שכר גבוה מדי, איך אני מגיבה?',
    'איך אני שומרת על קשר עם מועמד במהלך תהליך ארוך?'
  ]},
  scenario: { icon: '🎭', title: 'תרגול תרחישים', desc: 'משחק תפקידים - אני אהיה המועמד/מעסיק', suggestions: [
    'תתחיל/י בבקשה תרחיש של שיחה ראשונה עם מועמד לתחום הצימיני',
    'תשחק מועמד שקצת סקפטי ודורש שכר גבוה',
    'תשחק מעסיק שרוצה לדחות מועמד שאני מציעה',
    'תשחק מועמד שעובד כבר ומתלבט אם להחליף'
  ]},
  quiz:     { icon: '📝', title: 'בוחן אותי', desc: 'שאלות לבדיקת הבנה של החומר', suggestions: [
    'תתחיל/י את הבוחן',
    'תתחיל/י בוחן על שלב הסינון',
    'תתחיל/י בוחן על טכניקות פתיחת שיחה',
    'תתחיל/י בוחן על ניהול לידים'
  ]}
};

let currentMode = 'qa';
let currentConversationId = null;
let currentConversation = null;
let sendingMessage = false;
let aiEnabled = false;

// ============================================================
// Init
// ============================================================
(async function init() {
  // Check admin status for upload zone
  try {
    const me = await API.request('/auth/me');
    if (me && me.role === 'admin') {
      document.getElementById('admin-only-upload').style.display = 'block';
    }
  } catch(e) {}

  // Check AI status
  try {
    const status = await API.request('/training/status');
    aiEnabled = !!status.ai_enabled;
    const warning = document.getElementById('ai-warning');
    if (!aiEnabled && warning) warning.style.display = 'flex';
  } catch(e) {}

  await loadConversations();
  await loadDocuments();
  renderEmptyChat();
  updateChatHeader();

  setupEventListeners();
})();

function setupEventListeners() {
  // Tabs
  document.querySelectorAll('.training-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.training-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.dataset.tab;
      document.getElementById('tab-chat').style.display = tabName === 'chat' ? 'block' : 'none';
      document.getElementById('tab-docs').style.display = tabName === 'docs' ? 'block' : 'none';
    });
  });

  // Mode selector
  document.querySelectorAll('.training-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      document.querySelectorAll('.training-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateChatHeader();
      // Start fresh conversation on mode change
      currentConversationId = null;
      currentConversation = null;
      renderEmptyChat();
    });
  });

  // New conversation
  document.getElementById('new-conv-btn').addEventListener('click', () => {
    currentConversationId = null;
    currentConversation = null;
    document.querySelectorAll('.training-conv-item').forEach(i => i.classList.remove('active'));
    renderEmptyChat();
    document.getElementById('chat-input').focus();
  });

  // Chat input - auto-resize + Enter to send
  const input = document.getElementById('chat-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Send button
  document.getElementById('chat-send-btn').addEventListener('click', sendMessage);

  // Upload
  const uploadInput = document.getElementById('doc-upload-input');
  const uploadZone = document.getElementById('docs-upload-zone');
  if (uploadInput) {
    uploadInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) await uploadDocument(file);
      uploadInput.value = '';
    });
  }
  if (uploadZone) {
    ['dragenter', 'dragover'].forEach(ev => uploadZone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      uploadZone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => uploadZone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      uploadZone.classList.remove('dragover');
    }));
    uploadZone.addEventListener('drop', async (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) await uploadDocument(file);
    });
  }
}

function updateChatHeader() {
  const meta = MODE_META[currentMode];
  // Defensive: the chat tab was removed from training.html (it now lives in
  // the floating widget), but the file-upload code still calls these
  // helpers via init(). Bail out if the chat DOM isn't on this page.
  const titleEl = document.getElementById('chat-mode-title');
  const descEl = document.getElementById('chat-mode-desc');
  const iconEl = document.querySelector('.chat-header-icon');
  if (!titleEl || !descEl || !iconEl) return;
  titleEl.textContent = meta.title;
  descEl.textContent = meta.desc;
  iconEl.textContent = meta.icon;
}

function renderEmptyChat() {
  const meta = MODE_META[currentMode];
  const container = document.getElementById('chat-messages');
  if (!container) return; // chat removed from training.html
  container.innerHTML = `
    <div class="chat-empty">
      <div class="chat-empty-icon">${meta.icon}</div>
      <div class="chat-empty-title">${escapeHtml(meta.title)}</div>
      <div class="chat-empty-desc">${escapeHtml(meta.desc)}</div>
      <div class="chat-suggestions">
        ${meta.suggestions.map(s => `<button class="chat-suggestion" data-text="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
      </div>
    </div>
  `;
  container.querySelectorAll('.chat-suggestion').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('chat-input').value = btn.dataset.text;
      sendMessage();
    });
  });
}

// ============================================================
// Chat
// ============================================================
async function sendMessage() {
  if (sendingMessage) return;
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (!aiEnabled) {
    showToast('סוכן AI עדיין לא מחובר - פני למנהל המערכת', 'error');
    return;
  }

  sendingMessage = true;
  input.disabled = true;
  document.getElementById('chat-send-btn').disabled = true;

  // If this is a new conversation, clear the empty state
  const messagesContainer = document.getElementById('chat-messages');
  if (!currentConversationId) {
    messagesContainer.innerHTML = '';
  }

  // Append user bubble
  appendMessage('user', text);

  // Clear input
  input.value = '';
  input.style.height = 'auto';

  // Show thinking indicator
  const thinkingId = 'thinking-' + Date.now();
  appendThinking(thinkingId);

  try {
    const res = await API.request('/training/chat', {
      method: 'POST',
      body: JSON.stringify({
        conversation_id: currentConversationId,
        message: text,
        mode: currentMode
      })
    });
    removeThinking(thinkingId);
    appendMessage('assistant', res.message);

    // Store conversation id for follow-ups
    if (!currentConversationId) {
      currentConversationId = res.conversation_id;
      await loadConversations();
    }
  } catch (err) {
    removeThinking(thinkingId);
    appendMessage('assistant', '❌ שגיאה: ' + (err.message || 'לא הצלחתי לקבל תשובה. נסי שוב.'));
  } finally {
    sendingMessage = false;
    input.disabled = false;
    document.getElementById('chat-send-btn').disabled = false;
    input.focus();
  }
}

function appendMessage(role, content) {
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.className = 'chat-message ' + role;
  wrap.innerHTML = `
    <div class="chat-avatar ${role}">${role === 'user' ? 'את' : '🤖'}</div>
    <div class="chat-bubble ${role}">${escapeHtml(content)}</div>
  `;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function appendThinking(id) {
  const container = document.getElementById('chat-messages');
  const wrap = document.createElement('div');
  wrap.className = 'chat-message assistant';
  wrap.id = id;
  wrap.innerHTML = `
    <div class="chat-avatar assistant">🤖</div>
    <div class="chat-thinking">
      <div class="chat-dots"><span></span><span></span><span></span></div>
      <span>חושב...</span>
    </div>
  `;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
}

function removeThinking(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

// ============================================================
// Conversations
// ============================================================
async function loadConversations() {
  try {
    const container = document.getElementById('conversations-list');
    if (!container) return; // chat tab removed from this page
    const conversations = await API.request('/training/conversations');
    if (!conversations || conversations.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:var(--color-text-light);padding:8px 12px">אין שיחות קודמות</div>';
      return;
    }
    container.innerHTML = conversations.slice(0, 20).map(c => {
      const modeMeta = MODE_META[c.mode] || MODE_META.qa;
      const isActive = c.id === currentConversationId;
      return `
        <div class="training-conv-item ${isActive ? 'active' : ''}" data-id="${c.id}" data-mode="${c.mode || 'qa'}">
          <span>${modeMeta.icon}</span>
          <span class="training-conv-item-title">${escapeHtml(c.title || 'שיחה ללא שם')}</span>
          <button class="training-conv-delete" data-id="${c.id}" title="מחק">🗑</button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.training-conv-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        if (e.target.closest('.training-conv-delete')) return;
        const id = parseInt(item.dataset.id);
        await loadConversation(id);
      });
    });
    container.querySelectorAll('.training-conv-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.id);
        if (!confirm('למחוק את השיחה?')) return;
        try {
          await API.request('/training/conversations/' + id, { method: 'DELETE' });
          if (currentConversationId === id) {
            currentConversationId = null;
            currentConversation = null;
            renderEmptyChat();
          }
          await loadConversations();
        } catch (err) {
          showToast('שגיאה במחיקה', 'error');
        }
      });
    });
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

async function loadConversation(id) {
  try {
    const conv = await API.request('/training/conversations/' + id);
    currentConversationId = conv.id;
    currentConversation = conv;
    currentMode = conv.mode || 'qa';

    // Update mode buttons
    document.querySelectorAll('.training-mode-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === currentMode);
    });
    updateChatHeader();

    // Update active conv item
    document.querySelectorAll('.training-conv-item').forEach(i => i.classList.remove('active'));
    const activeItem = document.querySelector(`.training-conv-item[data-id="${id}"]`);
    if (activeItem) activeItem.classList.add('active');

    // Render messages
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    (conv.messages || []).forEach(m => {
      appendMessage(m.role, m.content);
    });
  } catch (err) {
    showToast('שגיאה בטעינת שיחה', 'error');
  }
}

// ============================================================
// Documents
// ============================================================
// Cached docs from the latest fetch — used by reorder helpers
let docsCache = [];

async function loadDocuments() {
  try {
    docsCache = await API.request('/training/documents');
    document.getElementById('docs-count').textContent = docsCache.length;
    const list = document.getElementById('docs-list');
    if (!docsCache || docsCache.length === 0) {
      list.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 20px;color:var(--color-text-light)"><div style="font-size:48px;margin-bottom:12px">📭</div>אין חומרי הכשרה עדיין</div>';
      return;
    }
    list.innerHTML = docsCache.map((d, i) => renderDocCard(d, i, docsCache.length)).join('');

    // Delete
    list.querySelectorAll('.doc-btn.danger').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm('למחוק את החומר לצמיתות?')) return;
        try {
          await API.request('/training/documents/' + id, { method: 'DELETE' });
          showToast('נמחק');
          loadDocuments();
        } catch (err) {
          showToast('שגיאה במחיקה', 'error');
        }
      });
    });

    // Hide/show toggle
    list.querySelectorAll('.doc-btn-hide').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const doc = docsCache.find(d => d.id == id);
        try {
          await API.request('/training/documents/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ hidden: !doc.hidden }),
          });
          showToast(doc.hidden ? 'הוצג למגייסות' : 'הוסתר מהמגייסות');
          loadDocuments();
        } catch (err) {
          showToast('שגיאה', 'error');
        }
      });
    });

    // Inline title edit
    list.querySelectorAll('.doc-title-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const doc = docsCache.find(d => d.id == id);
        const cur = doc.display_title || doc.original_name.replace(/\.pdf$/i, '');
        const next = prompt('שם חדש לקורס (כפי שיופיע למגייסות):', cur);
        if (next === null) return;
        try {
          await API.request('/training/documents/' + id, {
            method: 'PATCH',
            body: JSON.stringify({ display_title: next.trim() }),
          });
          showToast('השם עודכן');
          loadDocuments();
        } catch (err) {
          showToast('שגיאה', 'error');
        }
      });
    });

    // Move up / down — swap display_order with neighbour
    list.querySelectorAll('.doc-btn-up, .doc-btn-down').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        const dir = btn.classList.contains('doc-btn-up') ? -1 : +1;
        const idx = docsCache.findIndex(d => d.id === id);
        const targetIdx = idx + dir;
        if (targetIdx < 0 || targetIdx >= docsCache.length) return;

        // Build a fresh continuous order (1..N) matching current docsCache,
        // then swap the two neighbours and PATCH both.
        const orders = docsCache.map((d, i) => ({ id: d.id, order: i + 1 }));
        const tmp = orders[idx].order;
        orders[idx].order = orders[targetIdx].order;
        orders[targetIdx].order = tmp;

        try {
          // Persist orders in parallel
          await Promise.all(orders.map(({ id, order }) =>
            API.request('/training/documents/' + id, {
              method: 'PATCH',
              body: JSON.stringify({ display_order: order }),
            })
          ));
          loadDocuments();
        } catch (err) {
          showToast('שגיאה בסידור', 'error');
        }
      });
    });
  } catch (err) {
    console.error('Failed to load documents:', err);
  }
}

function renderDocCard(d, idx, total) {
  const ext = (d.original_name || '').split('.').pop().toLowerCase();
  const icon = ext === 'pdf' ? '📄' : (ext === 'pptx' || ext === 'ppt') ? '📊' : (ext === 'docx' || ext === 'doc') ? '📝' : '📁';
  const sizeMB = d.size ? (d.size / 1024 / 1024).toFixed(1) + ' MB' : '';
  const token = API.getToken();
  const viewUrl = '/api/training/documents/' + d.id + '/file?token=' + token;
  const displayName = d.display_title && d.display_title.trim()
    ? d.display_title
    : d.original_name.replace(/\.pdf$/i, '');

  return `
    <div class="doc-card" style="${d.hidden ? 'opacity:0.55;border-style:dashed' : ''}">
      <div class="doc-icon">${icon}</div>
      <div class="doc-info">
        <div class="doc-name" title="${escapeHtml(d.original_name)}">
          <span style="background:#0073ea;color:white;padding:2px 8px;border-radius:10px;font-size:11px;margin-left:6px">${idx + 1}</span>
          ${escapeHtml(displayName)}
          ${d.hidden ? '<span style="background:#fee;color:#e2445c;padding:2px 8px;border-radius:10px;font-size:11px;margin-right:6px">מוסתר</span>' : ''}
        </div>
        <div class="doc-meta">
          ${sizeMB} · קובץ מקור: ${escapeHtml(d.original_name)}
        </div>
        <div class="doc-actions" style="flex-wrap:wrap;gap:4px;margin-top:8px">
          <button class="doc-btn doc-btn-up" data-id="${d.id}" ${idx === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''} title="הזיז למעלה">↑</button>
          <button class="doc-btn doc-btn-down" data-id="${d.id}" ${idx === total - 1 ? 'disabled style="opacity:0.4;cursor:not-allowed"' : ''} title="הזיז למטה">↓</button>
          <button class="doc-btn doc-title-edit" data-id="${d.id}">✏ ערוך שם</button>
          <button class="doc-btn doc-btn-hide" data-id="${d.id}">${d.hidden ? '👁 הצג' : '🙈 הסתר'}</button>
          <a href="${viewUrl}" target="_blank" class="doc-btn">צפייה</a>
          <button class="doc-btn danger" data-id="${d.id}">🗑 מחק</button>
        </div>
      </div>
    </div>
  `;
}

// Upload with XHR so we get a real progress event during the upload —
// fetch() doesn't expose progress for the request body. The user reported
// 'pressing upload does nothing'; the progress bar makes it obvious that
// an upload IS happening, and any HTTP/network error surfaces clearly
// instead of silently failing.
function uploadDocument(file) {
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  console.log(`[upload] starting: ${file.name} (${sizeMB} MB)`);

  // Render a progress bar inside the upload zone so the user sees activity
  const zone = document.getElementById('docs-upload-zone');
  if (zone) {
    zone.innerHTML = `
      <div class="docs-upload-icon">⬆️</div>
      <div class="docs-upload-text" id="upload-progress-text">מעלה ${file.name}... 0%</div>
      <div style="margin-top:14px;height:6px;background:var(--color-border);border-radius:99px;overflow:hidden">
        <div id="upload-progress-fill" style="height:100%;width:0%;background:linear-gradient(90deg,#0073ea,#5559df);transition:width 0.2s ease;border-radius:99px"></div>
      </div>
    `;
  }

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const token = API.getToken();

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      console.log(`[upload] progress ${pct}%`);
      const txt = document.getElementById('upload-progress-text');
      const fill = document.getElementById('upload-progress-fill');
      if (txt) txt.textContent = `מעלה ${file.name}... ${pct}%`;
      if (fill) fill.style.width = pct + '%';
    });

    xhr.addEventListener('load', () => {
      console.log(`[upload] HTTP ${xhr.status}`, xhr.responseText && xhr.responseText.slice(0, 200));
      if (xhr.status >= 200 && xhr.status < 300) {
        showToast('✓ הקובץ הועלה בהצלחה');
        loadDocuments(); // re-render the docs list (also re-renders the upload zone)
      } else {
        let msg = `קוד שגיאה ${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          if (j && j.error) msg = j.error;
        } catch {}
        showToast('שגיאה בהעלאה: ' + msg, 'error');
        loadDocuments(); // restore the upload zone
      }
      resolve();
    });

    xhr.addEventListener('error', () => {
      console.error('[upload] network error', xhr);
      showToast('שגיאת רשת — בדקי את החיבור ונסי שוב', 'error');
      loadDocuments();
      resolve();
    });

    xhr.addEventListener('abort', () => {
      console.warn('[upload] aborted');
      showToast('ההעלאה בוטלה', 'error');
      loadDocuments();
      resolve();
    });

    xhr.addEventListener('timeout', () => {
      console.error('[upload] timeout');
      showToast('ההעלאה ארכה זמן רב מדי — נסי קובץ קטן יותר', 'error');
      loadDocuments();
      resolve();
    });

    const formData = new FormData();
    formData.append('file', file);

    xhr.open('POST', '/api/training/documents');
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    // 5-minute timeout — generous for large PDFs over slow networks
    xhr.timeout = 5 * 60 * 1000;
    try {
      xhr.send(formData);
    } catch (e) {
      console.error('[upload] xhr.send threw', e);
      showToast('שגיאה: ' + e.message, 'error');
      loadDocuments();
      resolve();
    }
  });
}
