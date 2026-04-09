/**
 * Dashboard page logic
 */

let statsData = null;

async function loadStats() {
  try {
    const stats = await API.stats();
    statsData = stats;
    renderStats();
  } catch (err) {
    console.error('Failed to load stats:', err);
    showToast(I18n.t('error'), 'error');
  }
}

function renderStats() {
  if (!statsData) return;

  // Reminders banner (must be first - alerts the user)
  renderReminders();

  // Update stat cards
  document.getElementById('stat-open-jobs').textContent = statsData.jobs.open || 0;
  document.getElementById('stat-new-jobs').textContent = statsData.jobs.newThisWeek || 0;
  document.getElementById('stat-stage1').textContent = statsData.candidates.stage1 || 0;
  document.getElementById('stat-stage2').textContent = statsData.candidates.stage2 || 0;
  document.getElementById('stat-accepted-month').textContent = statsData.candidates.acceptedThisMonth || 0;
  document.getElementById('stat-total').textContent = statsData.candidates.total || 0;

  // Render category chart
  renderCategoryChart();

  // Render new jobs panel
  renderNewJobs();

  // Render recent activity
  renderActivity();
}

function renderReminders() {
  const container = document.getElementById('reminders-container');
  if (!container) return;

  const followUps = statsData.followUps || { overdue: 0, dueSoon: 0 };
  container.innerHTML = '';

  if (followUps.overdue > 0) {
    const banner = document.createElement('a');
    banner.href = 'candidates.html';
    banner.className = 'reminder-banner critical';
    banner.innerHTML = `
      <div class="reminder-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
      </div>
      <div class="reminder-content">
        <div class="reminder-title">${followUps.overdue} ${I18n.t('reminder_overdue_title')}</div>
        <div class="reminder-desc">${I18n.t('reminder_overdue_desc')}</div>
      </div>
      <div class="reminder-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `;
    container.appendChild(banner);
  }

  if (followUps.dueSoon > 0) {
    const banner = document.createElement('a');
    banner.href = 'candidates.html';
    banner.className = 'reminder-banner';
    banner.innerHTML = `
      <div class="reminder-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <div class="reminder-content">
        <div class="reminder-title">${followUps.dueSoon} ${I18n.t('reminder_due_soon_title')}</div>
        <div class="reminder-desc">${I18n.t('reminder_due_soon_desc')}</div>
      </div>
      <div class="reminder-arrow">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `;
    container.appendChild(banner);
  }
}

function renderCategoryChart() {
  const container = document.getElementById('category-chart');
  const data = statsData.byCategory || [];

  if (data.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">${I18n.t('no_activity')}</div>
      </div>
    `;
    return;
  }

  // Find max value for scaling
  const max = Math.max(...data.map(d => d.count), 1);

  const categoryColors = {
    chimney: 'var(--cat-chimney)',
    air_duct: 'var(--cat-airduct)',
    garage_door: 'var(--cat-garage)',
    construction: 'var(--cat-construction)',
    cosmetics: 'var(--cat-cosmetics)'
  };

  // Ensure all categories present
  const rows = CATEGORIES.map(cat => {
    const found = data.find(d => d.category === cat);
    return {
      category: cat,
      count: found ? found.count : 0,
      color: categoryColors[cat] || 'var(--color-primary)'
    };
  });

  container.innerHTML = rows.map(row => {
    const width = row.count > 0 ? Math.max(8, (row.count / max * 100)).toFixed(0) : 0;
    return `
      <div class="chart-row" data-cat="${row.category}">
        <div class="chart-label">${getCategoryLabel(row.category)}</div>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width: ${width}%; background: ${row.color};">
            ${row.count > 0 && width > 12 ? row.count : ''}
          </div>
        </div>
        <div class="chart-value">${row.count}</div>
      </div>
    `;
  }).join('');
}

function renderNewJobs() {
  const container = document.getElementById('new-jobs-list');
  const countEl = document.getElementById('new-jobs-count');
  const newJobs = statsData.newJobs || [];
  const totalNew = statsData.jobs.newThisWeek || 0;

  if (countEl) countEl.textContent = totalNew;

  if (newJobs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✨</div>
        <div class="empty-state-title">${I18n.t('no_new_jobs')}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = newJobs.map(job => `
    <a class="new-job-item" href="jobs.html">
      <div class="new-job-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="7" width="20" height="14" rx="2"/>
          <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
        </svg>
      </div>
      <div class="new-job-info">
        <div class="new-job-title">${escapeHtml(job.title)}${job.is_urgent ? ' <span class="new-job-urgent-dot" title="' + I18n.t('urgent') + '"></span>' : ''}</div>
        <div class="new-job-meta">
          ${getCategoryTag(job.category)}
          ${job.company ? ' · ' + escapeHtml(job.company) : ''}
        </div>
      </div>
      <div class="new-job-time">${timeAgo(job.created_at)}</div>
    </a>
  `).join('');
}

function renderActivity() {
  const container = document.getElementById('activity-list');
  const activity = statsData.recentActivity || [];

  if (activity.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">✨</div>
        <div class="empty-state-title">${I18n.t('no_activity')}</div>
        <div class="empty-state-desc">${I18n.current === 'he' ? 'הוסיפי מועמדים והפעילות תופיע כאן' : 'Add candidates and activity will appear here'}</div>
      </div>
    `;
    return;
  }

  const stageIcons = {
    stage1: '1',
    stage2: '2',
    accepted: '✓',
    rejected: '✕'
  };

  container.innerHTML = activity.map(item => {
    const stageLabel = I18n.t(item.to_stage);
    return `
      <div class="activity-item">
        <div class="activity-icon ${item.to_stage}">
          ${stageIcons[item.to_stage] || '•'}
        </div>
        <div class="activity-content">
          <div class="activity-title">${escapeHtml(item.candidate_name)}</div>
          <div class="activity-desc">
            ${I18n.t('moved_to')} <strong>${stageLabel}</strong>
            ${item.job_title ? ' · ' + escapeHtml(item.job_title) : ''}
          </div>
        </div>
        <div class="activity-time">${timeAgo(item.changed_at)}</div>
      </div>
    `;
  }).join('');
}

function onLangChange() {
  if (statsData) renderStats();
}

loadStats();

// Auto-refresh every 60 seconds to catch new follow-ups
setInterval(loadStats, 60000);
