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
  let view = 'list';              // 'list' or 'calendar'
  let calCursor = new Date();     // first day of currently displayed month

  // Edit-state for modals
  let editingPostId = null;
  let editingAccountId = null;
  let postImageUrl = null;
  let postTags = [];
  let movingPostId = null;
  let openPopover = null;         // currently-open groups popover element

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
      status: view === 'calendar' ? undefined : (filters.status === 'all' ? undefined : filters.status),
      q: view === 'calendar' ? undefined : (filters.q || undefined)
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
    renderContent();
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
        <button class="pub-tab ${isActive ? 'is-active' : ''}" data-account-id="${acc.id}" style="${style}">
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
          <h3>נתחיל ביצירת חשבון פייסבוק ראשון</h3>
          <p>כל חשבון פייסבוק שאת מנהלת יקבל כאן טאב משלו, ובכל טאב תוכלי לאסוף את כל הפוסטים שאת מתכננת או שכבר פרסמת. אחר כך — לחיצה אחת מעתיקה טקסט+תמונה ישירות לפייסבוק.</p>
          <button class="btn btn-primary" id="empty-create-btn">+ צרי חשבון פייסבוק</button>
        </div>
      `;
      contentEl.querySelector('#empty-create-btn').addEventListener('click', () => openAccountModal());
      return;
    }

    filtersEl.style.display = '';
    syncViewToggleUi();

    if (view === 'calendar') {
      contentEl.innerHTML = renderCalendar();
      wireCalendarHandlers();
      return;
    }

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

  function renderPostCard(post) {
    const statusLabel = { draft: 'טיוטה', scheduled: 'מתוכנן', published: 'פורסם' }[post.status] || post.status;
    const dateStr = post.publish_date ? formatDateShort(post.publish_date) : '';
    return `
      <article class="pub-post" data-post-id="${post.id}">
        <div class="pub-post-image pub-post-clickable" data-action="preview">
          ${post.image_url
            ? `<img src="${escapeHtml(post.image_url)}" alt="" loading="lazy">`
            : `<span class="pub-post-image-empty">🖼️</span>`}
          <span class="pub-post-status ${post.status}">${statusLabel}</span>
        </div>
        <div class="pub-post-body pub-post-clickable" data-action="preview">
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
          <button class="pub-post-btn primary" data-action="copy-text" title="העתק טקסט בלבד">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            טקסט
          </button>
          <button class="pub-post-btn" data-action="copy-image" title="העתק תמונה בלבד" ${post.image_url ? '' : 'disabled style="opacity:0.4"'}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            תמונה
          </button>
          <button class="pub-post-btn" data-action="groups" title="פרסם בקבוצה">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            קבוצה
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
          else if (action === 'copy-text') await handleCopyText(post, el);
          else if (action === 'copy-image') await handleCopyImage(post, el);
          else if (action === 'groups') openGroupsPopover(post, el);
          else if (action === 'edit') openPostModal(post);
        });
      });
    });
  }

  // ----- Calendar view ------------------------------------------------
  // Renders a 7-column month grid with scheduled+published posts placed
  // on their publish_date. Lets Tami plan a week (or a month) at a glance.
  function renderCalendar() {
    const cur = new Date(calCursor);
    cur.setDate(1);
    const monthName = cur.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    // Sunday-first columns (Hebrew week starts on Sunday)
    const dayHeads = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
    const firstDow = cur.getDay();
    const lastDay = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    const today = new Date(); today.setHours(0,0,0,0);

    // Bucket posts (with publish_date) by YYYY-MM-DD
    const byDate = {};
    for (const p of posts) {
      if (!p.publish_date) continue;
      const d = new Date(p.publish_date);
      if (isNaN(d)) continue;
      if (d.getFullYear() !== cur.getFullYear() || d.getMonth() !== cur.getMonth()) continue;
      const key = d.getDate();
      (byDate[key] = byDate[key] || []).push(p);
    }

    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push('<div class="pub-cal-cell is-empty"></div>');
    for (let day = 1; day <= lastDay; day++) {
      const cellDate = new Date(cur.getFullYear(), cur.getMonth(), day);
      const isToday = cellDate.getTime() === today.getTime();
      const isPast = cellDate < today && !isToday;
      const dayPosts = byDate[day] || [];
      const visibleCount = dayPosts.length > 3 ? 3 : dayPosts.length;
      const moreCount = dayPosts.length - visibleCount;
      cells.push(`
        <div class="pub-cal-cell ${isToday ? 'is-today' : ''} ${isPast ? 'is-past' : ''}" data-day="${day}">
          <div class="pub-cal-day">${day}</div>
          ${dayPosts.slice(0, visibleCount).map(p => `
            <div class="pub-cal-post ${p.status}" data-post-id="${p.id}" title="${escapeHtml(p.text ? p.text.slice(0, 80) : '(ללא טקסט)')}">
              ${escapeHtml((p.text || '(ללא טקסט)').slice(0, 30))}
            </div>
          `).join('')}
          ${moreCount > 0 ? `<div class="pub-cal-post" style="opacity:0.7">+${moreCount} עוד</div>` : ''}
          <div class="pub-cal-add">+ הוסיפי</div>
        </div>
      `);
    }

    return `
      <div class="pub-calendar">
        <div class="pub-cal-header">
          <div class="pub-cal-title">${escapeHtml(monthName)}</div>
          <div class="pub-cal-nav">
            <button id="cal-today-btn" title="חזרי להיום" style="width:auto;padding:0 14px;font-size:13px;font-weight:600;border-radius:99px">היום</button>
            <button id="cal-prev-btn" title="חודש קודם">›</button>
            <button id="cal-next-btn" title="חודש הבא">‹</button>
          </div>
        </div>
        <div class="pub-cal-grid">
          ${dayHeads.map(d => `<div class="pub-cal-dayhead">${d}</div>`).join('')}
          ${cells.join('')}
        </div>
      </div>
    `;
  }

  function wireCalendarHandlers() {
    document.getElementById('cal-prev-btn')?.addEventListener('click', () => {
      calCursor.setMonth(calCursor.getMonth() - 1);
      renderContent();
    });
    document.getElementById('cal-next-btn')?.addEventListener('click', () => {
      calCursor.setMonth(calCursor.getMonth() + 1);
      renderContent();
    });
    document.getElementById('cal-today-btn')?.addEventListener('click', () => {
      calCursor = new Date();
      renderContent();
    });
    document.querySelectorAll('.pub-cal-cell:not(.is-empty)').forEach(cell => {
      cell.addEventListener('click', (e) => {
        // Click on an existing post chip → open it
        const chip = e.target.closest('.pub-cal-post[data-post-id]');
        if (chip) {
          const id = parseInt(chip.dataset.postId, 10);
          const post = posts.find(p => p.id === id);
          if (post) openPreviewModal(post);
          return;
        }
        // Click on empty cell area → open new post for that day
        const day = parseInt(cell.dataset.day, 10);
        const target = new Date(calCursor.getFullYear(), calCursor.getMonth(), day, 12, 0, 0);
        openPostModal(null, { presetDate: target, presetStatus: 'scheduled' });
      });
    });
  }

  function syncViewToggleUi() {
    const toggle = document.getElementById('pub-view-toggle');
    if (!toggle) return;
    toggle.querySelectorAll('button').forEach(b => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
    // In calendar view, the status filter is implicit (any post with a
    // publish_date). Hide the filter UI to reduce clutter.
    document.getElementById('pub-filter-status').style.display = view === 'calendar' ? 'none' : '';
    document.querySelector('.pub-filter-search').style.display = view === 'calendar' ? 'none' : '';
  }

  // ----- Copy logic ---------------------------------------------------
  // Two separate buttons because Facebook's editor consumes only one
  // clipboard format at a time — when both text and image are on the
  // clipboard, pasting the image drops the text and vice-versa. So
  // Tami picks: copy text first, paste; then copy image, paste.

  async function handleCopyText(post, btn) {
    if (!post.text) {
      showToast('הפוסט ללא טקסט', 'error');
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      await navigator.clipboard.writeText(post.text);
      btn.classList.add('copied');
      btn.innerHTML = '✓ הועתק';
      showToast('הטקסט הועתק ללוח. הדביקי בפייסבוק (Ctrl+V)');
    } catch (e) {
      console.warn('writeText failed:', e);
      // Fallback: textarea select+copy
      const ta = document.createElement('textarea');
      ta.value = post.text;
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

  async function handleCopyImage(post, btn) {
    if (!post.image_url) {
      showToast('אין תמונה לפוסט הזה', 'error');
      return;
    }
    const original = btn.innerHTML;
    btn.disabled = true;
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) {
        throw new Error('ClipboardItem unsupported');
      }
      const res = await fetch(post.image_url);
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
      a.href = post.image_url;
      a.download = post.image_url.split('/').pop() || 'post-image';
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

  // ----- Groups popover (publish-to-group dropdown on each post) ------
  function closeOpenPopover() {
    if (openPopover) {
      openPopover.remove();
      openPopover = null;
    }
  }

  function openGroupsPopover(post, anchorBtn) {
    closeOpenPopover();
    const groups = groupsByAccount[post.account_id] || [];
    const pop = document.createElement('div');
    pop.className = 'pub-groups-popover';
    if (groups.length === 0) {
      pop.innerHTML = `
        <div class="pub-groups-popover-empty">
          עדיין לא הגדרת קבוצות לחשבון הזה.<br>
          ערכי את החשבון והוסיפי קבוצות.
        </div>`;
    } else {
      pop.innerHTML = groups.map(g => `
        <button data-group-id="${g.id}" title="${escapeHtml(g.url || '')}">
          📤 ${escapeHtml(g.name)}
        </button>
      `).join('');
      pop.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          const gid = parseInt(b.dataset.groupId, 10);
          const grp = groups.find(x => x.id === gid);
          await publishToGroup(post, grp);
          closeOpenPopover();
        });
      });
    }
    // Position it
    const rect = anchorBtn.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.right = (window.innerWidth - rect.right) + 'px';
    document.body.appendChild(pop);
    openPopover = pop;

    // Click-outside-to-close
    setTimeout(() => {
      const closer = (e) => {
        if (!pop.contains(e.target)) {
          closeOpenPopover();
          document.removeEventListener('click', closer);
        }
      };
      document.addEventListener('click', closer);
    }, 0);
  }

  async function publishToGroup(post, group) {
    if (!group) return;
    // Copy text to clipboard so the user can paste in the group's composer
    if (post.text) {
      try { await navigator.clipboard.writeText(post.text); } catch {}
    }
    // Open the group URL in a new tab so she can immediately paste
    if (group.url) {
      window.open(group.url, '_blank', 'noopener,noreferrer');
    }
    showToast(post.text
      ? `הטקסט הועתק. הקבוצה "${group.name}" נפתחה — הדביקי שם (Ctrl+V) ופרסמי`
      : `הקבוצה "${group.name}" נפתחה`);
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
      list.innerHTML = groups.map(g => `
        <div class="pub-group-row" data-group-id="${g.id}">
          <span class="pub-group-name">${escapeHtml(g.name)}</span>
          <span class="pub-group-url">${escapeHtml(g.url || '')}</span>
          <button data-action="del-group" data-group-id="${g.id}" title="מחק">🗑️</button>
        </div>
      `).join('');
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
    } catch (err) {
      list.innerHTML = '<div style="color:var(--color-red);font-size:12px">שגיאה בטעינת קבוצות</div>';
    }
  }

  async function handleAddGroup() {
    if (!editingAccountId) return;
    const nameEl = document.getElementById('new-group-name');
    const urlEl  = document.getElementById('new-group-url');
    const name = nameEl.value.trim();
    const url  = urlEl.value.trim();
    if (!name) { showToast('שם הקבוצה נדרש', 'error'); return; }
    try {
      await API.publishing.createGroup({
        account_id: editingAccountId,
        name,
        url: url || null
      });
      nameEl.value = '';
      urlEl.value = '';
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

    document.getElementById('post-text').value = post ? (post.text || '') : '';
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

    if (!account_id) { showToast('צריך לבחור חשבון', 'error'); return; }
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

  // ----- Preview modal ------------------------------------------------
  // Click on a post's body or image opens this. Shows the FULL text
  // (no clipping) and ALL actions inline — including the secondary
  // ones (duplicate, move, delete, publish-to-group) that don't fit
  // on the card itself.
  function openPreviewModal(post) {
    closeOpenPopover();
    const statusLabel = { draft: 'טיוטה', scheduled: 'מתוכנן', published: 'פורסם' }[post.status] || post.status;
    const groups = groupsByAccount[post.account_id] || [];
    const dateStr = post.publish_date ? formatDate(post.publish_date) : '';

    document.getElementById('preview-modal-title').textContent = `פוסט · ${statusLabel}`;
    document.getElementById('preview-modal-content').innerHTML = `
      ${post.image_url ? `<img class="pub-preview-image" src="${escapeHtml(post.image_url)}" alt="">` : ''}
      <div class="pub-preview-text">${escapeHtml(post.text || '')}</div>
      <div class="pub-preview-meta">
        <span class="pub-post-status ${post.status}" style="position:static">${statusLabel}</span>
        ${dateStr ? `<span>📅 ${escapeHtml(dateStr)}</span>` : ''}
        ${post.tags && post.tags.length ? post.tags.map(t => `<span class="pub-tag">${escapeHtml(t)}</span>`).join('') : ''}
      </div>
      <div class="pub-preview-actions">
        <button class="btn btn-primary" data-prev-action="copy-text">📄 העתק טקסט</button>
        <button class="btn btn-secondary" data-prev-action="copy-image" ${post.image_url ? '' : 'disabled'}>🖼️ העתק תמונה</button>
        ${groups.length > 0 ? `
          <select id="prev-group-select" style="padding:8px 12px;border:1px solid var(--color-border);border-radius:var(--radius);font-family:inherit;font-size:13px">
            <option value="">📤 פרסמי בקבוצה...</option>
            ${groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('')}
          </select>
        ` : ''}
        <button class="btn btn-secondary" data-prev-action="edit">✏️ ערוך</button>
        <button class="btn btn-secondary" data-prev-action="duplicate">📋 שכפל</button>
        <button class="btn btn-secondary" data-prev-action="move">🔀 העבר</button>
        <button class="btn btn-secondary" data-prev-action="delete" style="color:var(--color-red)">🗑️ מחק</button>
      </div>
    `;

    // Wire up actions
    const content = document.getElementById('preview-modal-content');
    content.querySelectorAll('[data-prev-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const a = btn.dataset.prevAction;
        if (a === 'copy-text')  await handleCopyText(post, btn);
        else if (a === 'copy-image') await handleCopyImage(post, btn);
        else if (a === 'edit')      { closeModal('preview-modal'); openPostModal(post); }
        else if (a === 'duplicate') { closeModal('preview-modal'); await handleDuplicate(post); }
        else if (a === 'move')      { closeModal('preview-modal'); openMoveModal(post); }
        else if (a === 'delete')    {
          if (!confirm('למחוק את הפוסט?')) return;
          closeModal('preview-modal');
          await handleDelete(post);
        }
      });
    });
    const groupSel = content.querySelector('#prev-group-select');
    if (groupSel) {
      groupSel.addEventListener('change', async () => {
        const gid = parseInt(groupSel.value, 10);
        if (!gid) return;
        const grp = groups.find(x => x.id === gid);
        await publishToGroup(post, grp);
        groupSel.value = '';
      });
    }

    openModal('preview-modal');
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
    document.getElementById('pub-view-toggle').querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.dataset.view;
        if (v === view) return;
        view = v;
        // In calendar mode we want all posts (including out-of-month
        // ones we'll just ignore at render time). loadPosts handles the
        // filter difference internally.
        loadPosts().then(renderContent);
      });
    });

    // Close popover on Esc / outside-click
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOpenPopover(); });
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
