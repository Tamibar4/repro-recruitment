/**
 * Publishing page — Tami's Facebook publishing manager (admin-only).
 *
 * Provides one tab per Facebook account, with a grid of post drafts
 * underneath. Posts have text + optional image + status (draft / scheduled
 * / published) + tags + optional publish date. Each post card has a "copy"
 * button that copies BOTH text and image to the clipboard at once, so Tami
 * can switch to Facebook and just Ctrl+V — no copy-paste juggling.
 *
 * Hard-gated: if the logged-in user isn't an admin, the page redirects
 * to the dashboard.
 */
(function () {
  'use strict';

  // ----- State --------------------------------------------------------
  let accounts = [];
  let posts = [];
  let currentAccountId = null;
  let allTags = [];
  let filters = { status: 'all', q: '' };
  let editingPostId = null;
  let editingAccountId = null;
  let postImageUrl = null;        // image_url for the post being edited
  let postTags = [];              // tag list for the post being edited
  let movingPostId = null;

  // ----- Init ---------------------------------------------------------
  async function init() {
    if (!localStorage.getItem('auth_token')) {
      window.location.href = 'login.html';
      return;
    }
    const me = API.getCurrentUser();
    if (!me || me.role !== 'admin') {
      // Recruiters / non-admins shouldn't even be here. Bounce them.
      window.location.href = 'index.html';
      return;
    }
    // Render the user badge so the sidebar footer looks right
    if (typeof renderUserBadge === 'function') renderUserBadge(me);

    await reload();
    setupEventListeners();
  }

  async function reload() {
    try {
      [accounts, allTags] = await Promise.all([
        API.publishing.listAccounts(),
        API.publishing.listTags()
      ]);
      // Pick the first account by default; preserve current selection if still present
      if (accounts.length > 0) {
        if (!currentAccountId || !accounts.find(a => a.id === currentAccountId)) {
          currentAccountId = accounts[0].id;
        }
        await loadPosts();
      } else {
        currentAccountId = null;
        posts = [];
      }
      render();
    } catch (err) {
      console.error('publishing reload failed:', err);
      showToast(err.message || 'שגיאה בטעינת הנתונים', 'error');
    }
  }

  async function loadPosts() {
    if (!currentAccountId) { posts = []; return; }
    posts = await API.publishing.listPosts({
      account_id: currentAccountId,
      status: filters.status === 'all' ? undefined : filters.status,
      q: filters.q || undefined
    });
  }

  // ----- Render -------------------------------------------------------
  function render() {
    renderTabs();
    renderContent();
  }

  function renderTabs() {
    const tabsEl = document.getElementById('pub-tabs');
    if (accounts.length === 0) {
      // Show only an "add" button — empty state is in main content below
      tabsEl.innerHTML = `
        <button class="pub-tab-add" id="add-account-btn" title="הוסיפי דף פייסבוק">+</button>
      `;
      tabsEl.querySelector('#add-account-btn').addEventListener('click', () => openAccountModal());
      return;
    }

    tabsEl.innerHTML = accounts.map(acc => {
      const isActive = acc.id === currentAccountId;
      const style = isActive
        ? `background:${acc.color}; border-color:${acc.color};`
        : '';
      const c = acc.counts || { draft: 0, scheduled: 0, published: 0 };
      return `
        <button class="pub-tab ${isActive ? 'is-active' : ''}" data-account-id="${acc.id}" style="${style}">
          <span class="pub-tab-icon">${escapeHtml(acc.icon || '👤')}</span>
          <span>${escapeHtml(acc.name)}</span>
          <span class="pub-tab-counts">
            ${c.draft     ? `<span class="pub-tab-count-dot">📝${c.draft}</span>` : ''}
            ${c.scheduled ? `<span class="pub-tab-count-dot">⏰${c.scheduled}</span>` : ''}
            ${c.published ? `<span class="pub-tab-count-dot">✅${c.published}</span>` : ''}
          </span>
          ${isActive ? `
            <button class="pub-tab-edit" data-edit-account="${acc.id}" title="ערוך דף">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>` : ''}
        </button>
      `;
    }).join('') + `
      <button class="pub-tab-add" id="add-account-btn" title="הוסיפי דף פייסבוק">+</button>
    `;

    // Wire up tab clicks
    tabsEl.querySelectorAll('.pub-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        // ignore if the inner edit button was clicked
        if (e.target.closest('.pub-tab-edit')) return;
        const id = parseInt(tab.dataset.accountId, 10);
        if (id !== currentAccountId) {
          currentAccountId = id;
          loadPosts().then(render);
        }
      });
    });
    tabsEl.querySelectorAll('.pub-tab-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.dataset.editAccount, 10);
        const acc = accounts.find(a => a.id === id);
        if (acc) openAccountModal(acc);
      });
    });
    tabsEl.querySelector('#add-account-btn').addEventListener('click', () => openAccountModal());
  }

  function renderContent() {
    const filtersEl = document.getElementById('pub-filters');
    const contentEl = document.getElementById('pub-content');

    if (accounts.length === 0) {
      filtersEl.style.display = 'none';
      contentEl.innerHTML = `
        <div class="pub-empty">
          <div class="pub-empty-icon">📘</div>
          <h3>נתחיל ביצירת דף פייסבוק ראשון</h3>
          <p>כל דף פייסבוק שאת מנהלת יקבל כאן טאב משלו, ובכל טאב תוכלי לאסוף את כל הפוסטים שאת מתכננת או שכבר פרסמת. אחר כך — לחיצה אחת מעתיקה טקסט+תמונה ישירות לפייסבוק.</p>
          <button class="btn btn-primary" id="empty-create-btn">+ צרי דף פייסבוק</button>
        </div>
      `;
      contentEl.querySelector('#empty-create-btn').addEventListener('click', () => openAccountModal());
      return;
    }

    filtersEl.style.display = '';

    if (posts.length === 0) {
      contentEl.innerHTML = `
        <div class="pub-empty">
          <div class="pub-empty-icon">✍️</div>
          <h3>אין פוסטים בדף הזה עדיין</h3>
          <p>לחצי על "פוסט חדש" למעלה כדי להתחיל לאסוף תכנים.</p>
        </div>
      `;
      return;
    }

    contentEl.innerHTML = `<div class="pub-posts">${posts.map(renderPostCard).join('')}</div>`;
    wirePostCardHandlers();
  }

  function renderPostCard(post) {
    const statusLabel = { draft: 'טיוטה', scheduled: 'מתוכנן', published: 'פורסם' }[post.status] || post.status;
    const dateStr = post.publish_date ? formatDateShort(post.publish_date) : '';
    return `
      <article class="pub-post" data-post-id="${post.id}">
        <div class="pub-post-image">
          ${post.image_url
            ? `<img src="${escapeHtml(post.image_url)}" alt="" loading="lazy">`
            : `<span class="pub-post-image-empty">🖼️</span>`}
          <span class="pub-post-status ${post.status}">${statusLabel}</span>
        </div>
        <div class="pub-post-body">
          <div class="pub-post-text">${escapeHtml(post.text || '')}</div>
          ${post.tags && post.tags.length ? `
            <div class="pub-post-tags">
              ${post.tags.map(t => `<span class="pub-tag">${escapeHtml(t)}</span>`).join('')}
            </div>` : ''}
          <div class="pub-post-meta">
            ${dateStr ? `📅 ${escapeHtml(dateStr)}` : `נערך ${escapeHtml(formatDateShort(post.updated_at || post.created_at))}`}
          </div>
        </div>
        <div class="pub-post-actions">
          <button class="pub-post-btn primary" data-action="copy" title="העתק טקסט+תמונה">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            העתק
          </button>
          <button class="pub-post-btn" data-action="edit" title="ערוך">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="pub-post-btn" data-action="duplicate" title="שכפל">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button class="pub-post-btn" data-action="move" title="העבר לדף אחר">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
          <button class="pub-post-btn danger" data-action="delete" title="מחק">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>
      </article>
    `;
  }

  function wirePostCardHandlers() {
    document.querySelectorAll('.pub-post').forEach(card => {
      const id = parseInt(card.dataset.postId, 10);
      card.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          const post = posts.find(p => p.id === id);
          if (!post) return;
          if (action === 'copy') await handleCopy(post, btn);
          else if (action === 'edit') openPostModal(post);
          else if (action === 'duplicate') await handleDuplicate(post);
          else if (action === 'move') openMoveModal(post);
          else if (action === 'delete') await handleDelete(post);
        });
      });
    });
  }

  // ----- Copy text + image to clipboard -------------------------------
  // The hero feature of this whole page. Tami clicks "copy", switches to
  // Facebook, and Ctrl+V drops in BOTH the text and the image. If the
  // browser doesn't support multi-MIME ClipboardItem (Firefox), we fall
  // back to copying text and downloading the image to the user's computer
  // so they can attach it manually.
  async function handleCopy(post, btn) {
    if (!post.text && !post.image_url) {
      showToast('הפוסט ריק — אין מה להעתיק', 'error');
      return;
    }
    const originalLabel = btn.innerHTML;
    btn.disabled = true;

    try {
      if (post.image_url && navigator.clipboard?.write && window.ClipboardItem) {
        // Try the modern path: text + image in one ClipboardItem.
        // Note: the Clipboard API only accepts image/png — we convert
        // anything else (jpeg/webp/gif) via OffscreenCanvas.
        const res = await fetch(post.image_url);
        if (!res.ok) throw new Error('Failed to fetch image');
        const blob = await res.blob();
        const pngBlob = blob.type === 'image/png' ? blob : await convertToPng(blob);
        const items = {
          'image/png': pngBlob
        };
        if (post.text) items['text/plain'] = new Blob([post.text], { type: 'text/plain' });
        await navigator.clipboard.write([new ClipboardItem(items)]);
        flashCopied(btn, 'הועתק! ✓');
        showToast('הטקסט והתמונה הועתקו ללוח. פתחי פייסבוק והדביקי (Ctrl+V)');
        return;
      }
    } catch (e) {
      console.warn('text+image copy failed, falling back:', e);
    }

    // Fallback: copy text to clipboard, then trigger image download
    try {
      if (post.text) await navigator.clipboard.writeText(post.text);
    } catch (e) {
      console.warn('writeText failed:', e);
    }
    if (post.image_url) {
      const a = document.createElement('a');
      a.href = post.image_url;
      a.download = post.image_url.split('/').pop() || 'post-image';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    flashCopied(btn, 'הועתק! ✓');
    if (post.image_url && post.text) {
      showToast('הטקסט הועתק ללוח, התמונה ירדה למחשב. גררי אותה לפייסבוק');
    } else if (post.image_url) {
      showToast('התמונה ירדה למחשב');
    } else {
      showToast('הטקסט הועתק ללוח');
    }

    function flashCopied(b, label) {
      b.disabled = false;
      b.classList.add('copied');
      b.innerHTML = label;
      setTimeout(() => { b.classList.remove('copied'); b.innerHTML = originalLabel; }, 2000);
    }
  }

  // Convert non-PNG image blob to PNG via OffscreenCanvas (Clipboard API
  // requirement). Falls back to a regular canvas if OffscreenCanvas isn't
  // available.
  async function convertToPng(blob) {
    const img = await createImageBitmap(blob);
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(img.width, img.height);
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.convertToBlob({ type: 'image/png' });
    }
    canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  // ----- Account modal ------------------------------------------------
  function openAccountModal(account = null) {
    editingAccountId = account ? account.id : null;
    document.getElementById('account-modal-title').textContent = account ? 'עריכת דף פייסבוק' : 'דף פייסבוק חדש';
    document.getElementById('account-id').value = account ? account.id : '';
    document.getElementById('account-name').value = account ? account.name : '';
    document.getElementById('account-icon').value = account ? (account.icon || '') : '👤';
    document.getElementById('account-url').value = account ? (account.profile_url || '') : '';
    const color = account ? account.color : '#0073ea';
    const colorInput = document.querySelector(`input[name="account-color"][value="${color}"]`);
    if (colorInput) colorInput.checked = true;
    document.getElementById('account-delete-btn').style.display = account ? '' : 'none';
    openModal('account-modal');
  }

  async function saveAccount() {
    const name = document.getElementById('account-name').value.trim();
    if (!name) { showToast('צריך להזין שם לדף', 'error'); return; }
    const data = {
      name,
      icon: document.getElementById('account-icon').value.trim() || '👤',
      color: document.querySelector('input[name="account-color"]:checked')?.value || '#0073ea',
      profile_url: document.getElementById('account-url').value.trim() || null
    };
    try {
      let saved;
      if (editingAccountId) {
        saved = await API.publishing.updateAccount(editingAccountId, data);
      } else {
        saved = await API.publishing.createAccount(data);
        currentAccountId = saved.id; // jump to the newly-created account
      }
      closeModal('account-modal');
      await reload();
      showToast(editingAccountId ? 'הדף עודכן' : 'הדף נוסף');
    } catch (err) {
      showToast(err.message || 'שגיאה בשמירה', 'error');
    }
  }

  async function deleteAccount() {
    if (!editingAccountId) return;
    const acc = accounts.find(a => a.id === editingAccountId);
    if (!acc) return;
    const postCount = (acc.counts?.total || 0);
    const confirmMsg = postCount
      ? `למחוק את "${acc.name}" ואת ${postCount} הפוסטים שלו? הפעולה אינה הפיכה.`
      : `למחוק את "${acc.name}"?`;
    if (!confirm(confirmMsg)) return;
    try {
      await API.publishing.deleteAccount(editingAccountId);
      closeModal('account-modal');
      // If we just deleted the active tab, fall back to the first remaining
      if (currentAccountId === editingAccountId) currentAccountId = null;
      await reload();
      showToast('הדף נמחק');
    } catch (err) {
      showToast(err.message || 'שגיאה במחיקה', 'error');
    }
  }

  // ----- Post modal ---------------------------------------------------
  function openPostModal(post = null) {
    editingPostId = post ? post.id : null;
    document.getElementById('post-modal-title').textContent = post ? 'עריכת פוסט' : 'פוסט חדש';
    document.getElementById('post-id').value = post ? post.id : '';

    // Account dropdown
    const accountSel = document.getElementById('post-account');
    accountSel.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${(post ? post.account_id : currentAccountId) === a.id ? 'selected' : ''}>
        ${escapeHtml(a.icon || '👤')} ${escapeHtml(a.name)}
      </option>`).join('');

    document.getElementById('post-text').value = post ? (post.text || '') : '';
    const status = post ? post.status : 'draft';
    document.querySelector(`input[name="post-status"][value="${status}"]`).checked = true;
    togglePublishDateRow(status);

    const dateInput = document.getElementById('post-publish-date');
    dateInput.value = post && post.publish_date ? toLocalDateTimeInput(post.publish_date) : '';

    postImageUrl = post ? (post.image_url || null) : null;
    renderImageArea();

    postTags = post && Array.isArray(post.tags) ? post.tags.slice() : [];
    renderTagsInput();

    document.getElementById('post-delete-btn').style.display = post ? '' : 'none';
    openModal('post-modal');
  }

  function togglePublishDateRow(status) {
    document.getElementById('post-publish-date-row').style.display =
      (status === 'scheduled' || status === 'published') ? '' : 'none';
  }

  function renderImageArea() {
    const area = document.getElementById('post-image-area');
    if (postImageUrl) {
      area.innerHTML = `
        <div class="pub-image-preview">
          <img src="${escapeHtml(postImageUrl)}" alt="">
          <button type="button" class="pub-image-preview-remove" id="image-remove-btn" title="הסר תמונה">✕</button>
        </div>`;
      area.querySelector('#image-remove-btn').addEventListener('click', () => {
        postImageUrl = null;
        renderImageArea();
      });
    } else {
      area.innerHTML = `
        <div class="pub-image-upload">
          <input type="file" id="post-image-file" accept="image/*">
          <div class="pub-image-upload-icon">🖼️</div>
          <div class="pub-image-upload-text">גררי תמונה לכאן או לחצי לבחירה</div>
          <div class="pub-image-upload-hint">JPG / PNG / WEBP / GIF · עד 10MB</div>
        </div>`;
      area.querySelector('#post-image-file').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          showToast('התמונה גדולה מדי (מעל 10MB)', 'error');
          return;
        }
        try {
          area.innerHTML = `<div class="pub-image-upload"><div class="pub-image-upload-text">⏳ מעלה...</div></div>`;
          const result = await API.publishing.uploadImage(file);
          postImageUrl = result.url;
          renderImageArea();
        } catch (err) {
          showToast(err.message || 'העלאת התמונה נכשלה', 'error');
          renderImageArea();
        }
      });
    }
  }

  function renderTagsInput() {
    const wrap = document.getElementById('post-tags-input');
    const entry = document.getElementById('post-tag-entry');
    // Wipe everything except the entry input
    wrap.querySelectorAll('.pub-tag').forEach(t => t.remove());
    postTags.forEach(tag => {
      const el = document.createElement('span');
      el.className = 'pub-tag';
      el.innerHTML = `${escapeHtml(tag)}<button type="button" data-tag="${escapeHtml(tag)}">×</button>`;
      el.querySelector('button').addEventListener('click', (e) => {
        e.preventDefault();
        postTags = postTags.filter(t => t !== tag);
        renderTagsInput();
      });
      wrap.insertBefore(el, entry);
    });
  }

  async function savePost() {
    const account_id = parseInt(document.getElementById('post-account').value, 10);
    const text = document.getElementById('post-text').value;
    const status = document.querySelector('input[name="post-status"]:checked')?.value || 'draft';
    const dateRaw = document.getElementById('post-publish-date').value;
    const publish_date = dateRaw ? new Date(dateRaw).toISOString() : null;

    if (!account_id) { showToast('צריך לבחור דף', 'error'); return; }
    if (!text.trim() && !postImageUrl) {
      showToast('פוסט חייב להכיל טקסט או תמונה', 'error');
      return;
    }
    if ((status === 'scheduled' || status === 'published') && !publish_date) {
      showToast('צריך להזין תאריך פרסום', 'error');
      return;
    }

    const payload = {
      account_id,
      text: text || '',
      image_url: postImageUrl,
      status,
      publish_date,
      tags: postTags
    };
    try {
      if (editingPostId) {
        await API.publishing.updatePost(editingPostId, payload);
      } else {
        await API.publishing.createPost(payload);
      }
      closeModal('post-modal');
      // If the user changed the account_id, jump there
      if (account_id !== currentAccountId) currentAccountId = account_id;
      await reload();
      showToast(editingPostId ? 'הפוסט עודכן' : 'הפוסט נוצר');
    } catch (err) {
      showToast(err.message || 'שגיאה בשמירה', 'error');
    }
  }

  async function handleDuplicate(post) {
    try {
      await API.publishing.duplicatePost(post.id);
      await reload();
      showToast('הפוסט שוכפל כטיוטה');
    } catch (err) {
      showToast(err.message || 'שכפול נכשל', 'error');
    }
  }

  async function handleDelete(post) {
    if (!confirm('למחוק את הפוסט הזה? הפעולה אינה הפיכה.')) return;
    try {
      await API.publishing.deletePost(post.id);
      await reload();
      showToast('הפוסט נמחק');
    } catch (err) {
      showToast(err.message || 'מחיקה נכשלה', 'error');
    }
  }

  // ----- Move modal ---------------------------------------------------
  function openMoveModal(post) {
    movingPostId = post.id;
    const sel = document.getElementById('move-target-account');
    const otherAccounts = accounts.filter(a => a.id !== post.account_id);
    if (otherAccounts.length === 0) {
      showToast('אין דף אחר להעביר אליו', 'error');
      return;
    }
    sel.innerHTML = otherAccounts.map(a => `
      <option value="${a.id}">${escapeHtml(a.icon || '👤')} ${escapeHtml(a.name)}</option>
    `).join('');
    openModal('move-modal');
  }

  async function confirmMove() {
    const targetId = parseInt(document.getElementById('move-target-account').value, 10);
    if (!movingPostId || !targetId) return;
    try {
      await API.publishing.movePost(movingPostId, targetId);
      closeModal('move-modal');
      await reload();
      showToast('הפוסט הועבר');
    } catch (err) {
      showToast(err.message || 'ההעברה נכשלה', 'error');
    }
  }

  // ----- Event wiring -------------------------------------------------
  function setupEventListeners() {
    // New post button (top right)
    document.getElementById('btn-new-post').addEventListener('click', () => {
      if (accounts.length === 0) {
        showToast('צריך ליצור קודם דף פייסבוק', 'error');
        return;
      }
      openPostModal(null);
    });

    // Account modal save / delete
    document.getElementById('account-save-btn').addEventListener('click', saveAccount);
    document.getElementById('account-delete-btn').addEventListener('click', deleteAccount);

    // Post modal save / delete + status radio + tag entry
    document.getElementById('post-save-btn').addEventListener('click', savePost);
    document.getElementById('post-delete-btn').addEventListener('click', async () => {
      if (!editingPostId) return;
      const post = posts.find(p => p.id === editingPostId);
      if (!post) return;
      if (!confirm('למחוק את הפוסט הזה? הפעולה אינה הפיכה.')) return;
      try {
        await API.publishing.deletePost(editingPostId);
        closeModal('post-modal');
        await reload();
        showToast('הפוסט נמחק');
      } catch (err) {
        showToast(err.message || 'מחיקה נכשלה', 'error');
      }
    });
    document.querySelectorAll('input[name="post-status"]').forEach(r => {
      r.addEventListener('change', () => togglePublishDateRow(r.value));
    });
    document.getElementById('post-tag-entry').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = e.target.value.trim();
        if (v && !postTags.includes(v) && postTags.length < 20) {
          postTags.push(v);
          renderTagsInput();
        }
        e.target.value = '';
        // Re-focus on the entry (renderTagsInput re-attaches DOM)
        document.getElementById('post-tag-entry').focus();
      }
    });

    // Move modal
    document.getElementById('move-confirm-btn').addEventListener('click', confirmMove);

    // Filters
    document.getElementById('pub-search').addEventListener('input', debounce(() => {
      filters.q = document.getElementById('pub-search').value.trim();
      loadPosts().then(renderContent);
    }, 250));
    document.getElementById('pub-filter-status').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        document.getElementById('pub-filter-status').querySelectorAll('button').forEach(x => x.classList.remove('is-active'));
        b.classList.add('is-active');
        filters.status = b.dataset.status;
        loadPosts().then(renderContent);
      });
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // Convert ISO datetime to a value the <input type="datetime-local">
  // accepts (YYYY-MM-DDTHH:mm in local time).
  function toLocalDateTimeInput(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
