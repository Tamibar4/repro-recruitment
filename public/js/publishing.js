/**
 * Publishing page — Tami's Facebook publishing manager (admin-only).
 *
 * One tab per Facebook account (a real Facebook profile she manages).
 * Each account has:
 *   - Posts (drafts / scheduled / published)
 *   - Groups (Facebook groups she's a member of and posts to)
 *
 * Two views: list (grid of post cards) and calendar (month grid with
 * scheduled posts on their dates — for week-ahead planning).
 *
 * Hero feature: per-post copy buttons that put text OR image on the
 * clipboard (Facebook strips one when both are present), plus a
 * "publish to group" dropdown that copies the content and opens the
 * target group's URL in a new tab.
 *
 * Hard-gated: if the logged-in user isn't an admin, the page redirects
 * to the dashboard.
 */
(function () {
  'use strict';

  // ----- State --------------------------------------------------------
  let accounts = [];
  let posts = [];
  let groupsByAccount = {};       // account_id -> array of groups
  let currentAccountId = null;
  let allTags = [];
  let filters = { status: 'all', q: '' };
  let draggingAccountId = null;   // tab being dragged (account id)

  // Display title for a post: ONLY the explicit title field. No fallback
  // to the body text — if the user didn't enter a title, the card shows
  // "(ללא כותרת)" via CSS so it's obvious she should add one.
  function postTitle(post) {
    return (post.title || '').trim();
  }

  // Edit-state for modals
  let editingPostId = null;
  let editingAccountId = null;
  let postImages = [];          // all images attached to the post being edited
  let postSelectedImage = null; // currently-selected (primary) image URL
  let postTexts = [''];         // text variations being edited (always at least 1)
  let postTags = [];
  let movingPostId = null;

  // ----- Init ---------------------------------------------------------
  async function init() {
    if (!localStorage.getItem('auth_token')) {
      window.location.href = 'login.html';
      return;
    }
    const me = API.getCurrentUser();
    if (!me || me.role !== 'admin') {
      window.location.href = 'index.html';
      return;
    }
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
        await Promise.all([loadPosts(), loadGroupsForCurrentAccount()]);
      } else {
        currentAccountId = null;
        posts = [];
        groupsByAccount = {};
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

  async function loadGroupsForCurrentAccount() {
    if (!currentAccountId) return;
    if (groupsByAccount[currentAccountId]) return; // cached
    try {
      groupsByAccount[currentAccountId] = await API.publishing.listGroups(currentAccountId);
    } catch (e) {
      console.warn('Could not load groups for account', currentAccountId, e);
      groupsByAccount[currentAccountId] = [];
    }
  }

  // ----- Render -------------------------------------------------------
  function render() {
    renderTabs();
    renderGroupsBar();
    renderContent();
  }

  // Renders the row of group chips beneath the account tabs. Click a
  // chip to open the corresponding Facebook group in a new tab. The
  // chips are page-level "quick links" — the user copies a post's text
  // or image first via the per-post buttons, then clicks a group chip
  // to navigate.
  function renderGroupsBar() {
    const bar = document.getElementById('pub-groups-bar');
    if (!bar) return;
    if (!currentAccountId || accounts.length === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const groups = groupsByAccount[currentAccountId] || [];
    if (groups.length === 0) {
      bar.style.display = 'flex';
      bar.innerHTML = `
        <span class="pub-groups-bar-label">📤 קבוצות:</span>
        <span class="pub-groups-bar-empty">לא הוגדרו עדיין. ערכי את החשבון (✏️ ליד השם) והוסיפי קבוצות.</span>
      `;
      return;
    }
    bar.style.display = 'flex';
    bar.innerHTML = `
      <span class="pub-groups-bar-label">📤 פרסמי בקבוצה:</span>
      ${groups.map(g => {
        const ok = !!normalizeUrl(g.url);
        return `
          <button class="pub-group-chip ${ok ? '' : 'is-broken'}" data-group-id="${g.id}"
                  title="${escapeHtml(g.url || 'אין קישור — ערכי את הקבוצה כדי להוסיף')}">
            <span class="pub-group-chip-icon">👥</span>
            ${escapeHtml(g.name)}
          </button>
        `;
      }).join('')}
    `;
    bar.querySelectorAll('[data-group-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const gid = parseInt(btn.dataset.groupId, 10);
        const grp = groups.find(g => g.id === gid);
        if (!grp) return;
        const validUrl = normalizeUrl(grp.url);
        if (validUrl) {
          window.open(validUrl, '_blank', 'noopener,noreferrer');
        } else {
          showToast(`לקבוצה "${grp.name}" אין קישור תקין. ערכי את החשבון להוסיף קישור.`, 'error');
        }
      });
    });
  }

  function renderTabs() {
    const tabsEl = document.getElementById('pub-tabs');
    if (accounts.length === 0) {
      tabsEl.innerHTML = `
        <button class="pub-tab-add" id="add-account-btn" title="הוסיפי חשבון פייסבוק">+</button>
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
        <button class="pub-tab ${isActive ? 'is-active' : ''}" data-account-id="${acc.id}" style="${style}"
                draggable="true" title="גררי להזזה">
          <span class="pub-tab-icon">${escapeHtml(acc.icon || '👤')}</span>
          <span>${escapeHtml(acc.name)}</span>
          <span class="pub-tab-counts">
            ${c.draft     ? `<span class="pub-tab-count-dot">📝${c.draft}</span>` : ''}
            ${c.scheduled ? `<span class="pub-tab-count-dot">⏰${c.scheduled}</span>` : ''}
            ${c.published ? `<span class="pub-tab-count-dot">✅${c.published}</span>` : ''}
          </span>
          ${isActive ? `
            <button class="pub-tab-edit" data-edit-account="${acc.id}" title="ערוך חשבון">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </button>` : ''}
        </button>
      `;
    }).join('') + `
      <button class="pub-tab-add" id="add-account-btn" title="הוסיפי חשבון פייסבוק">+</button>
    `;

    tabsEl.querySelectorAll('.pub-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        if (e.target.closest('.pub-tab-edit')) return;
        const id = parseInt(tab.dataset.accountId, 10);
        if (id !== currentAccountId) {
          currentAccountId = id;
          Promise.all([loadPosts(), loadGroupsForCurrentAccount()]).then(render);
        }
      });
      // Drag-and-drop: drag a tab to reorder accounts
      tab.addEventListener('dragstart', (e) => {
        draggingAccountId = parseInt(tab.dataset.accountId, 10);
        tab.classList.add('is-dragging');
        try { e.dataTransfer.effectAllowed = 'move'; } catch {}
        // Some browsers require setData() to be called for drag to work
        try { e.dataTransfer.setData('text/plain', String(draggingAccountId)); } catch {}
      });
      tab.addEventListener('dragend', () => {
        tab.classList.remove('is-dragging');
        tabsEl.querySelectorAll('.pub-tab').forEach(t => t.classList.remove('is-drop-target'));
        draggingAccountId = null;
      });
      tab.addEventListener('dragover', (e) => {
        if (draggingAccountId == null) return;
        const overId = parseInt(tab.dataset.accountId, 10);
        if (overId === draggingAccountId) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch {}
        tabsEl.querySelectorAll('.pub-tab').forEach(t => t.classList.remove('is-drop-target'));
        tab.classList.add('is-drop-target');
      });
      tab.addEventListener('dragleave', () => {
        tab.classList.remove('is-drop-target');
      });
      tab.addEventListener('drop', async (e) => {
        e.preventDefault();
        tab.classList.remove('is-drop-target');
        if (draggingAccountId == null) return;
        const targetId = parseInt(tab.dataset.accountId, 10);
        if (targetId === draggingAccountId) return;
        await reorderAccounts(draggingAccountId, targetId);
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

  // Move the dragged account so it sits right before the drop-target,
  // then renumber sort_order across all accounts (so the order is stable
  // across reloads) and persist via PUT /accounts/:id.
  async function reorderAccounts(fromId, toId) {
    const fromIdx = accounts.findIndex(a => a.id === fromId);
    const toIdx   = accounts.findIndex(a => a.id === toId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = accounts.splice(fromIdx, 1);
    accounts.splice(toIdx, 0, moved);
    // Renumber locally and re-render right away (optimistic)
    accounts.forEach((acc, i) => { acc.sort_order = i; });
    renderTabs();
    // Persist in the background. If any one save fails we don't roll back —
    // worst case the order on next reload is what the server has, which is
    // close enough.
    try {
      await Promise.all(accounts.map((acc, i) =>
        API.publishing.updateAccount(acc.id, { sort_order: i })
      ));
    } catch (err) {
      console.warn('Reorder save failed:', err);
      showToast('סדר עודכן מקומית, אבל היתה בעיה בשמירה לשרת', 'error');
    }
  }

  function renderContent() {
    const filtersEl = document.getElementById('pub-filters');
    const contentEl = document.getElementById('pub-content');

    if (accounts.length === 0) {
      filtersEl.style.display = 'none';
      contentEl.innerHTML = `
        <div class="pub-empty">
          <div class="pub-empty-icon">📘</div>
          <h3>נתחיל ביצירת חשבון פייסבוק ראשון</h3>
          <p>כל חשבון פייסבוק שאת מנהלת יקבל כאן טאב משלו, ובכל טאב תוכלי לאסוף את כל הפוסטים שאת מתכננת או שכבר פרסמת. אחר כך — לחיצה אחת מעתיקה טקסט+תמונה ישירות לפייסבוק.</p>
          <button class="btn btn-primary" id="empty-create-btn">+ צרי חשבון פייסבוק</button>
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
          <h3>אין פוסטים בחשבון הזה עדיין</h3>
          <p>לחצי על "פוסט חדש" למעלה כדי להתחיל לאסוף תכנים.</p>
        </div>
      `;
      return;
    }

    contentEl.innerHTML = `<div class="pub-posts">${posts.map(renderPostCard).join('')}</div>`;
    wirePostCardHandlers();
  }

  // Build the actual <img src> URL we use for post images. We always
  // route through the authenticated /api/publishing/image endpoint
  // because it's been more reliable across environments than direct
  // static serving (Railway volumes etc). The token is included in
  // the query string because <img> tags can't set Authorization headers.
  function imageUrl(rawUrl) {
    if (!rawUrl) return null;
    if (rawUrl.startsWith('/uploads/posts/')) {
      const filename = rawUrl.replace(/^\/uploads\/posts\//, '');
      const token = API.getToken();
      return '/api/publishing/image/' + encodeURIComponent(filename) +
             (token ? '?token=' + encodeURIComponent(token) : '');
    }
    return rawUrl; // already a full URL or data: URL
  }

  function renderPostCard(post) {
    const statusLabel = { draft: 'טיוטה', scheduled: 'מתוכנן', published: 'פורסם' }[post.status] || post.status;
    const dateStr = post.publish_date ? formatDateShort(post.publish_date) : '';
    const title = postTitle(post);
    const imgSrc = imageUrl(post.image_url);
    return `
      <article class="pub-post" data-post-id="${post.id}">
        <div class="pub-post-image">
          ${imgSrc
            ? `<img src="${escapeHtml(imgSrc)}" alt="" loading="lazy"
                    onerror="this.parentElement.innerHTML='<span class=&quot;pub-post-image-empty&quot; style=&quot;color:#e2445c&quot;>⚠️ תמונה לא נטענה</span><span class=&quot;pub-post-status ${post.status}&quot;>${escapeHtml(statusLabel)}</span>';">`
            : `<button type="button" class="pub-post-add-image-btn" data-action="add-image" title="הוסיפי תמונה">
                 <span class="icon">📷</span>
                 <span class="label">הוסיפי תמונה</span>
               </button>`}
          <span class="pub-post-status ${post.status}">${statusLabel}</span>
        </div>
        <div class="pub-post-body pub-post-clickable" data-action="preview"
             title="לחצי לראות את התוכן המלא">
          <div class="pub-post-title">${escapeHtml(title)}</div>
          ${post.text ? `<div class="pub-post-readmore">לחצי לראות את הפוסט המלא ←</div>` : ''}
          ${post.reference_url ? `
            <a class="pub-post-reflink" href="${escapeHtml(post.reference_url)}" target="_blank" rel="noopener noreferrer"
               onclick="event.stopPropagation()">
              קישור לפוסט מקורי
            </a>` : ''}
          ${post.tags && post.tags.length ? `
            <div class="pub-post-tags">
              ${post.tags.map(t => `<span class="pub-tag">${escapeHtml(t)}</span>`).join('')}
            </div>` : ''}
          <div class="pub-post-meta">
            ${dateStr ? `📅 ${escapeHtml(dateStr)}` : `נערך ${escapeHtml(formatDateShort(post.updated_at || post.created_at))}`}
          </div>
        </div>
        <div class="pub-post-actions">
          <button class="pub-post-btn primary" data-action="copy-text" title="העתק טקסט בלבד">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            העתק טקסט
          </button>
          <button class="pub-post-btn" data-action="copy-image" title="העתק תמונה בלבד" ${post.image_url ? '' : 'disabled style="opacity:0.4"'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            העתק תמונה
          </button>
          <button class="pub-post-btn" data-action="edit" title="ערוך">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
        </div>
      </article>
    `;
  }

  function wirePostCardHandlers() {
    document.querySelectorAll('.pub-post').forEach(card => {
      const id = parseInt(card.dataset.postId, 10);
      card.querySelectorAll('[data-action]').forEach(el => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          const action = el.dataset.action;
          const post = posts.find(p => p.id === id);
          if (!post) return;
          if (action === 'preview') openPreviewModal(post);
          else if (action === 'copy-text')  await handleCopyText(post, el);
          else if (action === 'copy-image') await handleCopyImage(post, el);
          else if (action === 'edit')       openPostModal(post);
          else if (action === 'add-image')  triggerImageUploadForPost(post);
        });
      });
    });
  }

  // Modal that shows the full post content + every action when the user
  // clicks the body of a card. Two interactive sections:
  //
  //  1. Image carousel — navigate with prev/next, dot indicators show
  //     position. A "📋 העתק תמונה" button on the carousel copies the
  //     CURRENTLY-VISIBLE image (so the user can flip + copy any image).
  //
  //  2. Text cubes — one cube per text variation (post.texts). Each
  //     cube shows a 2-line preview; click to expand inline → reveals
  //     the full text + a per-cube copy button. Click again to collapse.
  //
  // Plus: title, reference link, status badge, tags, plus the standard
  // post-level actions (edit, duplicate, move, delete).
  function openPreviewModal(post) {
    const statusLabel = { draft: 'טיוטה', scheduled: 'מתוכנן', published: 'פורסם' }[post.status] || post.status;
    const dateStr = post.publish_date ? formatDate(post.publish_date) : '';
    const title = postTitle(post);
    const images = Array.isArray(post.images) && post.images.length > 0
      ? post.images
      : (post.image_url ? [post.image_url] : []);
    const texts = Array.isArray(post.texts) && post.texts.length > 0
      ? post.texts
      : (post.text ? [post.text] : []);

    document.getElementById('preview-modal-title').textContent = title || `פוסט · ${statusLabel}`;
    document.getElementById('preview-modal-content').innerHTML = `
      ${images.length > 0 ? `
        <div class="pub-carousel" data-current="0">
          <div class="pub-carousel-stage" id="carousel-stage">
            <img src="${escapeHtml(imageUrl(images[0]))}" alt=""
                 onerror="this.outerHTML='<div style=&quot;padding:24px;color:var(--color-red);text-align:center&quot;>⚠️ התמונה לא נטענה. נסי להעלות שוב.</div>';">
          </div>
          ${images.length > 1 ? `
            <button class="pub-carousel-nav prev" id="carousel-prev" title="הקודם" disabled>›</button>
            <button class="pub-carousel-nav next" id="carousel-next" title="הבא">‹</button>
            <div class="pub-carousel-counter" id="carousel-counter">1 / ${images.length}</div>
          ` : ''}
          <button class="pub-carousel-copy" id="carousel-copy" title="העתק את התמונה הזו">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            העתק תמונה
          </button>
          ${images.length > 1 ? `
            <div class="pub-carousel-dots" id="carousel-dots">
              ${images.map((_, i) => `<button class="${i === 0 ? 'active' : ''}" data-idx="${i}" title="תמונה ${i + 1}"></button>`).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${title ? `<div class="pub-preview-title">${escapeHtml(title)}</div>` : ''}
      ${texts.length > 0 ? `
        <div class="pub-text-carousel" data-current="0">
          <div class="pub-text-carousel-stage">
            ${texts.length > 1 ? `<span class="pub-text-carousel-num" id="text-carousel-num">וריאציה 1 / ${texts.length}</span>` : ''}
            <div class="pub-text-carousel-text" id="text-carousel-text">${escapeHtml(texts[0])}</div>
            ${texts.length > 1 ? `
              <button class="pub-text-carousel-nav prev" id="text-carousel-prev" title="הקודם" disabled>›</button>
              <button class="pub-text-carousel-nav next" id="text-carousel-next" title="הבא">‹</button>
            ` : ''}
          </div>
          <div class="pub-text-carousel-actions">
            <button class="pub-text-carousel-copy" id="text-carousel-copy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              העתק טקסט
            </button>
          </div>
          ${texts.length > 1 ? `
            <div class="pub-text-carousel-dots" id="text-carousel-dots">
              ${texts.map((_, i) => `<button class="${i === 0 ? 'active' : ''}" data-idx="${i}" title="וריאציה ${i + 1}"></button>`).join('')}
            </div>
          ` : ''}
        </div>
      ` : ''}
      ${post.reference_url ? `
        <div style="margin-bottom:14px">
          <a class="pub-post-reflink" href="${escapeHtml(post.reference_url)}" target="_blank" rel="noopener noreferrer">
            קישור לפוסט מקורי / לדוגמה
          </a>
        </div>` : ''}
      <div class="pub-preview-meta">
        <span class="pub-post-status ${post.status}" style="position:static">${statusLabel}</span>
        ${dateStr ? `<span>📅 ${escapeHtml(dateStr)}</span>` : ''}
        ${post.tags && post.tags.length ? post.tags.map(t => `<span class="pub-tag">${escapeHtml(t)}</span>`).join('') : ''}
      </div>
      <div class="pub-preview-actions">
        <button class="btn btn-secondary" data-prev-action="edit">✏️ ערוך</button>
        <button class="btn btn-secondary" data-prev-action="duplicate">📋 שכפלי</button>
        <button class="btn btn-secondary" data-prev-action="move">🔀 העבירי</button>
        <button class="btn btn-secondary" data-prev-action="delete" style="color:var(--color-red)">🗑️ מחקי</button>
      </div>
    `;

    const content = document.getElementById('preview-modal-content');

    // ---- Carousel wiring ----
    if (images.length > 0) {
      const stage    = content.querySelector('#carousel-stage');
      const counter  = content.querySelector('#carousel-counter');
      const dotsWrap = content.querySelector('#carousel-dots');
      const prevBtn  = content.querySelector('#carousel-prev');
      const nextBtn  = content.querySelector('#carousel-next');
      const copyBtn  = content.querySelector('#carousel-copy');
      let currentImageIdx = 0;

      const showImage = (idx) => {
        if (idx < 0 || idx >= images.length) return;
        currentImageIdx = idx;
        stage.innerHTML = `<img src="${escapeHtml(imageUrl(images[idx]))}" alt=""
          onerror="this.outerHTML='<div style=&quot;padding:24px;color:var(--color-red);text-align:center&quot;>⚠️ התמונה לא נטענה</div>';">`;
        if (counter) counter.textContent = `${idx + 1} / ${images.length}`;
        if (dotsWrap) {
          dotsWrap.querySelectorAll('button').forEach((d, i) => d.classList.toggle('active', i === idx));
        }
        if (prevBtn) prevBtn.disabled = idx === 0;
        if (nextBtn) nextBtn.disabled = idx === images.length - 1;
      };

      prevBtn?.addEventListener('click', () => showImage(currentImageIdx - 1));
      nextBtn?.addEventListener('click', () => showImage(currentImageIdx + 1));
      dotsWrap?.querySelectorAll('button').forEach((d) => {
        d.addEventListener('click', () => showImage(parseInt(d.dataset.idx, 10)));
      });
      copyBtn?.addEventListener('click', async () => {
        await handleCopyImage(post, copyBtn, images[currentImageIdx]);
      });

      if (nextBtn) nextBtn.disabled = images.length <= 1;
    }

    // ---- Text carousel wiring ----
    if (texts.length > 0) {
      const textStage = content.querySelector('#text-carousel-text');
      const textNum   = content.querySelector('#text-carousel-num');
      const textPrev  = content.querySelector('#text-carousel-prev');
      const textNext  = content.querySelector('#text-carousel-next');
      const textCopy  = content.querySelector('#text-carousel-copy');
      const textDots  = content.querySelector('#text-carousel-dots');
      let currentTextIdx = 0;

      const showText = (idx) => {
        if (idx < 0 || idx >= texts.length) return;
        currentTextIdx = idx;
        textStage.textContent = texts[idx];
        if (textNum)  textNum.textContent = `וריאציה ${idx + 1} / ${texts.length}`;
        if (textPrev) textPrev.disabled = idx === 0;
        if (textNext) textNext.disabled = idx === texts.length - 1;
        if (textDots) {
          textDots.querySelectorAll('button').forEach((d, i) => d.classList.toggle('active', i === idx));
        }
      };

      textPrev?.addEventListener('click', () => showText(currentTextIdx - 1));
      textNext?.addEventListener('click', () => showText(currentTextIdx + 1));
      textDots?.querySelectorAll('button').forEach(d => {
        d.addEventListener('click', () => showText(parseInt(d.dataset.idx, 10)));
      });
      textCopy?.addEventListener('click', async () => {
        await handleCopyText(post, textCopy, texts[currentTextIdx]);
      });

      if (textNext) textNext.disabled = texts.length <= 1;
    }

    // ---- Post-level actions ----
    content.querySelectorAll('[data-prev-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = btn.dataset.prevAction;
        if (a === 'edit')           { closeModal('preview-modal'); openPostModal(post); }
        else if (a === 'duplicate') { closeModal('preview-modal'); await handleDuplicate(post); }
        else if (a === 'move')      { closeModal('preview-modal'); openMoveModal(post); }
        else if (a === 'delete')    {
          if (!confirm('למחוק את הפוסט?')) return;
          closeModal('preview-modal');
          await handleDelete(post);
        }
      });
    });

    openModal('preview-modal');
  }

  // Quick-add image: lets the user upload an image directly from a card
  // without opening the full edit modal. Creates a hidden file input,
  // uploads, then PATCHes the post with the new image_url.
  function triggerImageUploadForPost(post) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        showToast('התמונה גדולה מדי (מעל 10MB)', 'error');
        return;
      }
      try {
        showToast('מעלה תמונה...');
        const result = await API.publishing.uploadImage(file);
        const existingImages = Array.isArray(post.images) && post.images.length > 0
          ? post.images
          : (post.image_url ? [post.image_url] : []);
        const newImages = [...existingImages, result.url];
        await API.publishing.updatePost(post.id, {
          images: newImages,
          image_url: post.image_url || result.url, // keep current selection or pick this one
        });
        await reload();
        showToast('התמונה נוספה');
      } catch (err) {
        showToast(err.message || 'העלאה נכשלה', 'error');
      }
    });
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 5000);
  }

  // ----- Copy logic ---------------------------------------------------
  // Two separate buttons because Facebook's editor consumes only one
  // clipboard format at a time — when both text and image are on the
  // clipboard, pasting the image drops the text and vice-versa. So
  // Tami picks: copy text first, paste; then copy image, paste.

  async function handleCopyText(post, btn, explicitText) {
    // If an explicit text is passed (from a cube/variation), use that.
    // Otherwise fall back to the post's primary/first text.
    const txt = explicitText != null
      ? explicitText
      : (post.text || (Array.isArray(post.texts) ? post.texts[0] : '') || '');
    if (!txt) {
      showToast('הפוסט ללא טקסט', 'error');
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      await navigator.clipboard.writeText(txt);
      btn.classList.add('copied');
      btn.innerHTML = '✓ הועתק';
      showToast('הטקסט הועתק ללוח. הדביקי בפייסבוק (Ctrl+V)');
    } catch (e) {
      console.warn('writeText failed:', e);
      const ta = document.createElement('textarea');
      ta.value = txt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      btn.classList.add('copied');
      btn.innerHTML = '✓ הועתק';
      showToast('הטקסט הועתק');
    }
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = original; btn.disabled = false; }, 1800);
  }

  async function handleCopyImage(post, btn, explicitUrl) {
    const rawUrl = explicitUrl || post.image_url;
    if (!rawUrl) {
      showToast('אין תמונה לפוסט הזה', 'error');
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) {
        throw new Error('ClipboardItem unsupported');
      }
      // Use the same authenticated URL the <img> tag uses, so this works
      // even if direct static serving is blocked.
      const fetchUrl = imageUrl(rawUrl);
      const res = await fetch(fetchUrl);
      if (!res.ok) throw new Error('Failed to fetch image');
      const blob = await res.blob();
      const pngBlob = blob.type === 'image/png' ? blob : await convertToPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      btn.classList.add('copied');
      btn.innerHTML = '✓ הועתק';
      showToast('התמונה הועתקה ללוח. הדביקי בפייסבוק (Ctrl+V)');
    } catch (e) {
      console.warn('image copy failed, falling back to download:', e);
      const a = document.createElement('a');
      a.href = imageUrl(rawUrl);
      a.download = rawUrl.split('/').pop() || 'post-image';
      document.body.appendChild(a); a.click(); a.remove();
      btn.classList.add('copied');
      btn.innerHTML = '✓ ירדה';
      showToast('התמונה ירדה למחשב — גררי אותה לפייסבוק');
    }
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = original; btn.disabled = false; }, 1800);
  }

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

  // Take whatever the user typed into the URL field and try to make it
  // into a real https URL. Returns null if it's clearly not a URL (Hebrew
  // text, gibberish, etc.) so callers can refuse to navigate to it.
  function normalizeUrl(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    if (!s) return null;
    // Already has a protocol
    if (/^https?:\/\//i.test(s)) {
      try { new URL(s); return s; } catch { return null; }
    }
    // No protocol — try prepending https:// if it looks like a domain.
    // A domain has at least one dot followed by a TLD-like part. Hebrew
    // text or words without dots are NOT URLs and we refuse to coerce
    // them into "https://<hebrew-text>" which the browser would reject.
    if (/^[a-z0-9][a-z0-9.\-_/?#=&%]*\.[a-z]{2,}/i.test(s)) {
      try { new URL('https://' + s); return 'https://' + s; } catch { return null; }
    }
    return null;
  }

  // ----- Account modal ------------------------------------------------
  function openAccountModal(account = null) {
    editingAccountId = account ? account.id : null;
    document.getElementById('account-modal-title').textContent = account ? 'עריכת חשבון פייסבוק' : 'חשבון פייסבוק חדש';
    document.getElementById('account-id').value = account ? account.id : '';
    document.getElementById('account-name').value = account ? account.name : '';
    document.getElementById('account-icon').value = account ? (account.icon || '') : '👤';
    document.getElementById('account-url').value = account ? (account.profile_url || '') : '';
    const color = account ? account.color : '#0073ea';
    const colorInput = document.querySelector(`input[name="account-color"][value="${color}"]`);
    if (colorInput) colorInput.checked = true;
    document.getElementById('account-delete-btn').style.display = account ? '' : 'none';

    // Groups section is only meaningful for existing accounts (since
    // groups have account_id as a foreign key).
    const groupsSection = document.getElementById('account-groups-section');
    if (account) {
      groupsSection.style.display = '';
      renderGroupsList(account.id);
    } else {
      groupsSection.style.display = 'none';
    }

    openModal('account-modal');
  }

  async function renderGroupsList(accountId) {
    const list = document.getElementById('account-groups-list');
    list.innerHTML = '<div style="font-size:12px;color:var(--color-text-light);padding:6px 0">טוען קבוצות...</div>';
    try {
      // Force-refresh from server in case we just edited
      const groups = await API.publishing.listGroups(accountId);
      groupsByAccount[accountId] = groups;
      if (groups.length === 0) {
        list.innerHTML = '<div style="font-size:12px;color:var(--color-text-light);padding:6px 0">עדיין אין קבוצות. הוסיפי בשורה למטה.</div>';
        return;
      }
      list.innerHTML = groups.map(g => {
        const urlOk = !!normalizeUrl(g.url);
        return `
          <div class="pub-group-row" data-group-id="${g.id}">
            <span class="pub-group-name">${escapeHtml(g.name)}</span>
            <span class="pub-group-url" title="${escapeHtml(g.url || '')}">
              ${g.url
                ? (urlOk
                    ? escapeHtml(g.url)
                    : `<span style="color:var(--color-red)">⚠️ קישור לא תקין: ${escapeHtml(g.url)}</span>`)
                : '<span style="color:var(--color-text-light)">ללא קישור</span>'}
            </span>
            <button data-action="edit-group" data-group-id="${g.id}" title="ערוך"
                    style="color:var(--color-primary)">✏️</button>
            <button data-action="del-group" data-group-id="${g.id}" title="מחק">🗑️</button>
          </div>
        `;
      }).join('');
      list.querySelectorAll('[data-action="del-group"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const gid = parseInt(btn.dataset.groupId, 10);
          if (!confirm('למחוק את הקבוצה הזאת?')) return;
          try {
            await API.publishing.deleteGroup(gid);
            renderGroupsList(accountId);
          } catch (err) {
            showToast(err.message || 'מחיקה נכשלה', 'error');
          }
        });
      });
      list.querySelectorAll('[data-action="edit-group"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const gid = parseInt(btn.dataset.groupId, 10);
          const grp = groups.find(g => g.id === gid);
          if (!grp) return;
          // Use prompt() for inline editing — simple but effective
          const newName = prompt('שם הקבוצה:', grp.name);
          if (newName === null) return;
          if (!newName.trim()) { showToast('השם לא יכול להיות ריק', 'error'); return; }
          const newUrlRaw = prompt('קישור הקבוצה (https://facebook.com/groups/...):', grp.url || '');
          if (newUrlRaw === null) return;
          // Validate the URL — if it doesn't look like a URL, warn and abort
          const newUrl = newUrlRaw.trim();
          if (newUrl && !normalizeUrl(newUrl)) {
            if (!confirm('הקישור שהזנת לא נראה תקין. לשמור בכל זאת?\nכדאי שיהיה כמו: https://facebook.com/groups/...')) return;
          }
          try {
            await API.publishing.updateGroup(gid, {
              name: newName.trim(),
              url: newUrl ? (normalizeUrl(newUrl) || newUrl) : null
            });
            renderGroupsList(accountId);
            // Invalidate group cache so popovers show fresh data
            delete groupsByAccount[accountId];
          } catch (err) {
            showToast(err.message || 'עדכון נכשל', 'error');
          }
        });
      });
    } catch (err) {
      list.innerHTML = '<div style="color:var(--color-red);font-size:12px">שגיאה בטעינת קבוצות</div>';
    }
  }

  async function handleAddGroup() {
    if (!editingAccountId) return;
    const nameEl = document.getElementById('new-group-name');
    const urlEl  = document.getElementById('new-group-url');
    const name = nameEl.value.trim();
    const urlRaw = urlEl.value.trim();
    if (!name) { showToast('שם הקבוצה נדרש', 'error'); return; }
    // Validate URL — if user typed something that doesn't look like a
    // URL (e.g. they pasted Hebrew text into the URL field), warn them.
    // If they DID type a URL but forgot the https://, we auto-prepend.
    let urlToSave = null;
    if (urlRaw) {
      const normalized = normalizeUrl(urlRaw);
      if (!normalized) {
        if (!confirm('הקישור שהזנת לא נראה כמו URL תקין. \nכדאי שיהיה כמו: https://facebook.com/groups/...\n\nלשמור בכל זאת? (לא נוכל לפתוח את הקבוצה אוטומטית)')) {
          return;
        }
        urlToSave = urlRaw; // save as-is so user can fix later
      } else {
        urlToSave = normalized;
      }
    }
    try {
      await API.publishing.createGroup({
        account_id: editingAccountId,
        name,
        url: urlToSave
      });
      nameEl.value = '';
      urlEl.value = '';
      // Invalidate cache so the post-card popover sees the new group
      delete groupsByAccount[editingAccountId];
      renderGroupsList(editingAccountId);
    } catch (err) {
      showToast(err.message || 'הוספה נכשלה', 'error');
    }
  }

  async function saveAccount() {
    const name = document.getElementById('account-name').value.trim();
    if (!name) { showToast('צריך להזין שם לחשבון', 'error'); return; }
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
        currentAccountId = saved.id;
      }
      closeModal('account-modal');
      // Drop cached groups so they re-fetch fresh
      delete groupsByAccount[saved.id];
      await reload();
      showToast(editingAccountId ? 'החשבון עודכן' : 'החשבון נוסף');
    } catch (err) {
      showToast(err.message || 'שגיאה בשמירה', 'error');
    }
  }

  async function deleteAccount() {
    if (!editingAccountId) return;
    const acc = accounts.find(a => a.id === editingAccountId);
    if (!acc) return;
    const postCount = (acc.counts?.total || 0);
    const groupCount = (groupsByAccount[acc.id] || []).length;
    let confirmMsg = `למחוק את "${acc.name}"?`;
    if (postCount || groupCount) {
      const parts = [];
      if (postCount) parts.push(`${postCount} פוסטים`);
      if (groupCount) parts.push(`${groupCount} קבוצות`);
      confirmMsg = `למחוק את "${acc.name}" + ${parts.join(' ו-')} שלו? הפעולה אינה הפיכה.`;
    }
    if (!confirm(confirmMsg)) return;
    try {
      await API.publishing.deleteAccount(editingAccountId);
      closeModal('account-modal');
      if (currentAccountId === editingAccountId) currentAccountId = null;
      delete groupsByAccount[editingAccountId];
      await reload();
      showToast('החשבון נמחק');
    } catch (err) {
      showToast(err.message || 'שגיאה במחיקה', 'error');
    }
  }

  // ----- Post modal ---------------------------------------------------
  // `prefill` lets the calendar view pre-fill the date + status when a
  // user clicks an empty day cell.
  function openPostModal(post = null, prefill = {}) {
    editingPostId = post ? post.id : null;
    document.getElementById('post-modal-title').textContent = post ? 'עריכת פוסט' : 'פוסט חדש';
    document.getElementById('post-id').value = post ? post.id : '';

    const accountSel = document.getElementById('post-account');
    accountSel.innerHTML = accounts.map(a => `
      <option value="${a.id}" ${(post ? post.account_id : currentAccountId) === a.id ? 'selected' : ''}>
        ${escapeHtml(a.icon || '👤')} ${escapeHtml(a.name)}
      </option>`).join('');

    document.getElementById('post-title').value = post ? (post.title || '') : '';
    document.getElementById('post-reference-url').value = post ? (post.reference_url || '') : '';
    // Load text variations: prefer post.texts, fall back to single post.text
    if (post && Array.isArray(post.texts) && post.texts.length > 0) {
      postTexts = post.texts.slice();
    } else if (post && post.text) {
      postTexts = [post.text];
    } else {
      postTexts = [''];
    }
    renderTextsArea();
    const status = post ? post.status : (prefill.presetStatus || 'draft');
    document.querySelector(`input[name="post-status"][value="${status}"]`).checked = true;
    togglePublishDateRow(status);

    const dateInput = document.getElementById('post-publish-date');
    if (post && post.publish_date) {
      dateInput.value = toLocalDateTimeInput(post.publish_date);
    } else if (prefill.presetDate) {
      dateInput.value = toLocalDateTimeInput(prefill.presetDate.toISOString());
    } else {
      dateInput.value = '';
    }

    // Image gallery state — load existing images, fall back to image_url
    // alone for posts that predate the multi-image schema.
    if (post) {
      postImages = Array.isArray(post.images) && post.images.length > 0
        ? post.images.slice()
        : (post.image_url ? [post.image_url] : []);
      postSelectedImage = post.image_url || (postImages[0] || null);
    } else {
      postImages = [];
      postSelectedImage = null;
    }
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

  // Renders the multi-text editor inside the post modal. Each variation
  // is a textarea; one row gets a delete button (when there's more than
  // one); a "+ הוסיפי וריאציה" button appends another. We only re-render
  // on add/delete so typing doesn't fight focus with the React-style
  // re-render loop.
  function renderTextsArea() {
    const area = document.getElementById('post-texts-area');
    if (!area) return;
    if (!Array.isArray(postTexts) || postTexts.length === 0) postTexts = [''];
    area.innerHTML = postTexts.map((t, i) => `
      <div class="pub-text-edit-row" data-idx="${i}">
        <span class="pub-text-edit-label">${postTexts.length > 1 ? `וריאציה ${i + 1}` : 'טקסט'}</span>
        <textarea data-text-idx="${i}" maxlength="5000" placeholder="${i === 0 ? 'כתבי כאן את תוכן הפוסט...' : 'גרסה נוספת...'}">${escapeHtml(t || '')}</textarea>
        ${postTexts.length > 1
          ? `<button type="button" class="pub-text-edit-delete" data-del-idx="${i}" title="מחקי וריאציה">🗑️</button>`
          : ''}
      </div>
    `).join('') + `
      <button type="button" class="pub-text-add-btn" id="add-text-variation">+ הוסיפי וריאציה</button>
    `;
    // Wire up: keep state in sync as user types
    area.querySelectorAll('textarea[data-text-idx]').forEach(ta => {
      ta.addEventListener('input', () => {
        const idx = parseInt(ta.dataset.textIdx, 10);
        postTexts[idx] = ta.value;
      });
    });
    area.querySelectorAll('.pub-text-edit-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.delIdx, 10);
        postTexts.splice(idx, 1);
        if (postTexts.length === 0) postTexts = [''];
        renderTextsArea();
      });
    });
    document.getElementById('add-text-variation')?.addEventListener('click', () => {
      if (postTexts.length >= 10) {
        showToast('הגעת למקסימום של 10 וריאציות', 'error');
        return;
      }
      postTexts.push('');
      renderTextsArea();
      // Focus the new textarea
      setTimeout(() => {
        const lastTa = area.querySelector(`textarea[data-text-idx="${postTexts.length - 1}"]`);
        if (lastTa) lastTa.focus();
      }, 30);
    });
  }

  // Renders the multi-image gallery inside the post modal. The user can
  // upload many images, click a thumbnail to mark it as the "primary"
  // (the one that appears on the card / gets copied), or delete any
  // image. The selected one gets a colored border + "ראשית" badge.
  function renderImageArea() {
    const area = document.getElementById('post-image-area');
    if (!area) return;
    const thumbs = postImages.map((url, i) => {
      const isSel = url === postSelectedImage;
      return `
        <div class="pub-image-thumb ${isSel ? 'is-selected' : ''}" data-img-url="${escapeHtml(url)}" data-idx="${i}">
          <img src="${escapeHtml(imageUrl(url))}" alt="" loading="lazy"
               onerror="this.parentElement.innerHTML='<div style=&quot;color:#e2445c;font-size:10px;padding:6px;text-align:center&quot;>⚠️ תמונה לא נטענה</div>';">
          <button type="button" class="pub-image-thumb-delete" data-del-idx="${i}" title="מחקי תמונה">✕</button>
        </div>
      `;
    }).join('');
    area.innerHTML = `
      <div class="pub-image-gallery">
        ${thumbs}
        <label class="pub-image-add-thumb" title="העלי תמונה נוספת">
          <input type="file" id="post-image-file" accept="image/*">
          <span class="icon">+</span>
          <span class="label">${postImages.length === 0 ? 'הוסיפי תמונה' : 'תמונה נוספת'}</span>
        </label>
      </div>
    `;
    // Click thumbnail → mark as selected (primary)
    area.querySelectorAll('.pub-image-thumb').forEach(thumb => {
      thumb.addEventListener('click', (e) => {
        if (e.target.closest('.pub-image-thumb-delete')) return;
        const url = thumb.dataset.imgUrl;
        if (url && url !== postSelectedImage) {
          postSelectedImage = url;
          renderImageArea();
        }
      });
    });
    // Delete button → remove from list
    area.querySelectorAll('.pub-image-thumb-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.delIdx, 10);
        const removed = postImages[idx];
        postImages.splice(idx, 1);
        // If we removed the selected one, fall back to first remaining
        if (removed === postSelectedImage) {
          postSelectedImage = postImages[0] || null;
        }
        renderImageArea();
      });
    });
    // Upload another image → push to gallery
    const fileInput = area.querySelector('#post-image-file');
    if (fileInput) {
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          showToast('התמונה גדולה מדי (מעל 10MB)', 'error');
          return;
        }
        try {
          const result = await API.publishing.uploadImage(file);
          postImages.push(result.url);
          // First-uploaded image becomes the primary by default
          if (!postSelectedImage) postSelectedImage = result.url;
          renderImageArea();
        } catch (err) {
          showToast(err.message || 'העלאת התמונה נכשלה', 'error');
        }
      });
    }
  }

  function renderTagsInput() {
    const wrap = document.getElementById('post-tags-input');
    const entry = document.getElementById('post-tag-entry');
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
    const title = document.getElementById('post-title').value;
    const reference_url = document.getElementById('post-reference-url').value.trim() || null;
    const status = document.querySelector('input[name="post-status"]:checked')?.value || 'draft';
    const dateRaw = document.getElementById('post-publish-date').value;
    const publish_date = dateRaw ? new Date(dateRaw).toISOString() : null;

    // Collect texts from postTexts state, drop empties
    const cleanTexts = (postTexts || []).map(t => t.trim()).filter(Boolean);

    if (!account_id) { showToast('צריך לבחור חשבון', 'error'); return; }
    if (!title.trim() && cleanTexts.length === 0 && postImages.length === 0) {
      showToast('פוסט חייב להכיל כותרת, טקסט או תמונה', 'error');
      return;
    }
    if ((status === 'scheduled' || status === 'published') && !publish_date) {
      showToast('צריך להזין תאריך פרסום', 'error');
      return;
    }

    const payload = {
      account_id,
      title: title || '',
      texts: cleanTexts,
      text: cleanTexts[0] || '',  // legacy field kept in sync with first variant
      images: postImages,
      image_url: postSelectedImage,
      reference_url,
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
      showToast('אין חשבון אחר להעביר אליו', 'error');
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
    document.getElementById('btn-new-post').addEventListener('click', () => {
      if (accounts.length === 0) {
        showToast('צריך ליצור קודם חשבון פייסבוק', 'error');
        return;
      }
      openPostModal(null);
    });

    document.getElementById('account-save-btn').addEventListener('click', saveAccount);
    document.getElementById('account-delete-btn').addEventListener('click', deleteAccount);
    document.getElementById('add-group-btn').addEventListener('click', handleAddGroup);

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
        document.getElementById('post-tag-entry').focus();
      }
    });

    document.getElementById('move-confirm-btn').addEventListener('click', confirmMove);

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

  function toLocalDateTimeInput(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
