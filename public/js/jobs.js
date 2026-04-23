/**
 * Jobs page logic
 */

let allJobs = [];
let currentJob = null;
let currentLocations = []; // working copy of locations being edited
let currentRequirements = []; // working copy of requirements being edited
let filters = { categories: ['all'], regions: ['all'], status: 'all', search: '' };

// Countries loaded dynamically from server (has keywords for city → country matching)
let COUNTRIES_DATA = [];

function getJobRegions(job) {
  const regions = new Set();
  if (!job.locations || job.locations.length === 0) return regions;
  job.locations.forEach(loc => {
    const name = (loc.name || '').toLowerCase();
    COUNTRIES_DATA.forEach(country => {
      const kws = country.keywords || [];
      if (kws.some(kw => kw && name.includes(kw.toLowerCase()))) {
        regions.add(country.id);
      }
    });
  });
  return regions;
}

async function loadCountries() {
  try {
    COUNTRIES_DATA = await API.request('/countries');
  } catch (err) {
    console.error('Failed to load countries:', err);
    COUNTRIES_DATA = [];
  }
}

// Read URL params
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('status')) {
  filters.status = urlParams.get('status');
}
if (urlParams.has('category')) {
  filters.categories = [urlParams.get('category')];
}

async function loadJobs() {
  try {
    const params = {};
    if (filters.status !== 'all') params.status = filters.status;
    if (filters.search) params.search = filters.search;

    let jobs = await API.jobs.list(params);

    // Client-side multi-category filter
    if (!filters.categories.includes('all')) {
      jobs = jobs.filter(j => filters.categories.includes(j.category));
    }

    // Client-side multi-region filter
    if (!filters.regions.includes('all')) {
      jobs = jobs.filter(j => {
        const jobRegions = getJobRegions(j);
        return filters.regions.some(r => jobRegions.has(r));
      });
    }

    allJobs = jobs;
    renderJobs();
  } catch (err) {
    console.error('Failed to load jobs:', err);
    showToast(I18n.t('error'), 'error');
  }
}

function renderJobs() {
  const container = document.getElementById('jobs-container');

  if (allJobs.length === 0) {
    container.innerHTML = `
      <div class="panel">
        <div class="empty-state">
          <div class="empty-state-icon">💼</div>
          <div class="empty-state-title">${I18n.t('no_jobs')}</div>
          <div class="empty-state-desc">${I18n.t('no_jobs_desc')}</div>
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="jobs-grid">
      ${allJobs.map(renderJobCard).join('')}
    </div>
  `;

  // Card click → open details modal
  container.querySelectorAll('.job-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn') || e.target.closest('.urgent-toggle-btn')) return;
      const id = card.dataset.id;
      const job = allJobs.find(j => j.id == id);
      if (job) openDetailsModal(job);
    });

    // Hover preview tooltip
    card.addEventListener('mouseenter', (e) => {
      const id = card.dataset.id;
      const job = allJobs.find(j => j.id == id);
      if (job) showJobTooltip(job, card);
    });
    card.addEventListener('mouseleave', () => {
      hideJobTooltip();
    });
  });

  // Edit button
  container.querySelectorAll('.btn-edit-job').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      openJobModal(allJobs.find(j => j.id == id));
    });
  });

  // Delete button
  container.querySelectorAll('.btn-delete-job').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm(I18n.t('confirm_delete'))) return;
      try {
        await API.jobs.delete(id);
        showToast(I18n.t('deleted'));
        loadJobs();
      } catch (err) {
        showToast(I18n.t('error'), 'error');
      }
    });
  });

  // Quick urgent toggle on card
  container.querySelectorAll('.urgent-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const job = allJobs.find(j => j.id == id);
      if (!job) return;
      try {
        await API.request(`/jobs/${id}/urgent`, {
          method: 'PATCH',
          body: JSON.stringify({ is_urgent: !job.is_urgent })
        });
        showToast(I18n.t('saved'));
        loadJobs();
      } catch (err) {
        showToast(I18n.t('error'), 'error');
      }
    });
  });
}

function renderJobCard(job) {
  const counts = job.candidate_counts || { stage1: 0, stage2: 0, accepted: 0 };
  const urgentClass = job.is_urgent ? 'urgent' : '';
  const locationsCount = (job.locations || []).length;
  return `
    <div class="job-card cat-${job.category} ${urgentClass}" data-id="${job.id}">
      ${job.is_urgent ? `
        <div class="urgent-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
          <span data-i18n="urgent">דחוף</span>
        </div>
      ` : ''}
      <div class="job-card-header">
        <div style="flex: 1; min-width: 0;">
          <div class="job-card-title">${escapeHtml(job.title)}</div>
          ${job.company ? `
            <div class="job-card-company">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/>
              </svg>
              ${escapeHtml(job.company)}
            </div>
          ` : ''}
          ${locationsCount > 0 ? `
            <div class="job-card-location">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              ${locationsCount} ${I18n.t('locations_list')}
            </div>
          ` : (job.location ? `
            <div class="job-card-location">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              ${escapeHtml(job.location)}
            </div>
          ` : '')}
        </div>
      </div>

      <div class="job-card-meta">
        ${getCategoryTag(job.category)}
        ${getStatusPill(job.status)}
      </div>

      ${job.salary_range ? `
        <div class="job-card-salary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="1" x2="12" y2="23"/>
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
          </svg>
          ${escapeHtml(job.salary_range)}
        </div>
      ` : ''}

      ${job.commission ? `
        <div class="job-card-commission">
          <span>💰 עמלת גיוס:</span>
          <strong>$${Number(job.commission).toLocaleString()}</strong>
          <span class="commission-per">למועמד</span>
        </div>
      ` : ''}

      <div class="job-card-footer">
        <div class="job-card-stats">
          <div class="job-stat"><div class="job-stat-dot stage1"></div><span class="job-stat-value">${counts.stage1}</span></div>
          <div class="job-stat"><div class="job-stat-dot stage2"></div><span class="job-stat-value">${counts.stage2}</span></div>
          <div class="job-stat"><div class="job-stat-dot accepted"></div><span class="job-stat-value">${counts.accepted}</span></div>
        </div>
        <div class="job-card-actions">
          <button class="icon-btn urgent-toggle-btn ${job.is_urgent ? 'active' : ''}" data-id="${job.id}" title="${job.is_urgent ? I18n.t('unmark_urgent') : I18n.t('mark_urgent')}" aria-label="${job.is_urgent ? I18n.t('unmark_urgent') : I18n.t('mark_urgent')}">
            <svg viewBox="0 0 24 24" fill="${job.is_urgent ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </button>
          <button class="icon-btn btn-edit-job" data-id="${job.id}" title="${I18n.t('edit')}" aria-label="${I18n.t('edit')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <button class="icon-btn danger btn-delete-job" data-id="${job.id}" title="${I18n.t('delete')}" aria-label="${I18n.t('delete')}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Job Details Modal
// ============================================================
function openDetailsModal(job) {
  currentJob = job;
  // Ensure locations array exists
  if (!Array.isArray(currentJob.locations)) currentJob.locations = [];

  renderDetailsModalBody();
  openModal('job-details-modal');
}

function renderDetailsModalBody() {
  const job = currentJob;
  const body = document.getElementById('job-details-body');

  body.innerHTML = `
    ${job.is_urgent ? `
      <div class="details-urgent-banner">
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        <span data-i18n="urgent_job">משרה דחופה</span>
      </div>
    ` : ''}

    <div class="details-title-block">
      <h3 class="details-title">${escapeHtml(job.title)}</h3>
      ${job.company ? `<div class="details-company">${escapeHtml(job.company)}</div>` : ''}
    </div>

    <div class="details-meta">
      ${getCategoryTag(job.category)}
      ${getStatusPill(job.status)}
    </div>

    ${job.salary_range || job.commission ? `
      <div class="details-section">
        ${job.salary_range ? `
          <div class="details-label">💰 ${I18n.t('salary')}</div>
          <div class="details-value">${escapeHtml(job.salary_range)}</div>
        ` : ''}
        ${job.commission ? `
          <div class="details-commission" style="margin-top: ${job.salary_range ? '12px' : '0'}">
            <div class="details-label">🏆 עמלת גיוס</div>
            <div class="details-commission-value">$${Number(job.commission).toLocaleString()} <span>למועמד</span></div>
          </div>
        ` : ''}
      </div>
    ` : ''}

    <div class="details-section">
      <div class="details-label-row">
        <div class="details-label">📍 ${I18n.t('locations_list')}</div>
        <button class="btn btn-sm btn-secondary" id="btn-details-add-location">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          <span data-i18n="add_location">הוסף מיקום</span>
        </button>
      </div>
      <div class="details-locations-editable" id="details-locations-list">
        ${renderEditableLocations(job.locations)}
      </div>
    </div>

    ${job.description ? `
      <div class="details-section">
        <div class="details-label">📋 ${I18n.t('description')}</div>
        <div class="details-value details-text">${escapeHtml(job.description)}</div>
        <button class="btn-copy-below" onclick="copyDescription(this)" data-text="${escapeHtml(job.description).replace(/"/g, '&quot;')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>${I18n.current === 'he' ? 'העתק תיאור' : 'Copy description'}</span>
        </button>
      </div>
    ` : ''}

    ${job.requirements && job.requirements.length > 0 ? `
      <div class="details-section">
        <div class="details-label">📋 דרישות</div>
        <div class="requirements-list">
          ${job.requirements.map(req => `
            <div class="requirement-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="9 11 12 14 22 4"/>
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <span>${escapeHtml(req)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    ${job.notes ? `
      <div class="details-section">
        <div class="details-label">📝 ${I18n.t('notes')}</div>
        <div class="details-value details-text">${escapeHtml(job.notes)}</div>
      </div>
    ` : ''}
  `;

  attachLocationListeners();
}

function renderEditableLocations(locations) {
  if (!locations || locations.length === 0) {
    return `<div class="details-empty">${I18n.t('no_locations')}</div>`;
  }
  return locations.map((loc, idx) => `
    <div class="loc-editable-row" data-idx="${idx}">
      <div class="loc-editable-name">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
          <circle cx="12" cy="10" r="3"/>
        </svg>
        <input type="text" class="loc-editable-name-input" data-idx="${idx}" value="${escapeHtml(loc.name || '')}" placeholder="${I18n.t('placeholder_location')}">
      </div>
      <div class="loc-editable-controls">
        <div class="pressure-buttons" data-idx="${idx}">
          <button type="button" class="pressure-btn ${loc.pressure === 'high' ? 'active high' : ''}" data-pressure="high" data-idx="${idx}" title="${I18n.t('pressure_high')}">${I18n.t('pressure_high')}</button>
          <button type="button" class="pressure-btn ${loc.pressure === 'medium' ? 'active medium' : ''}" data-pressure="medium" data-idx="${idx}" title="${I18n.t('pressure_medium')}">${I18n.t('pressure_medium')}</button>
          <button type="button" class="pressure-btn ${loc.pressure === 'low' ? 'active low' : ''}" data-pressure="low" data-idx="${idx}" title="${I18n.t('pressure_low')}">${I18n.t('pressure_low')}</button>
        </div>
        <input type="text" class="loc-needed-input" data-idx="${idx}" value="${escapeHtml(loc.needed || '')}" placeholder="${I18n.t('placeholder_needed')}" title="${I18n.t('candidates_needed')}">
        <button type="button" class="icon-btn danger loc-delete-btn" data-idx="${idx}" aria-label="${I18n.t('delete')}" title="${I18n.t('delete')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('');
}

function attachLocationListeners() {
  // Pressure button toggle
  document.querySelectorAll('#details-locations-list .pressure-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const newPressure = btn.dataset.pressure;
      const loc = currentJob.locations[idx];
      // Toggle off if already active
      loc.pressure = (loc.pressure === newPressure) ? '' : newPressure;
      await saveCurrentJobLocations();
      renderDetailsModalBody();
    });
  });

  // Needed input - debounced save on change
  document.querySelectorAll('#details-locations-list .loc-needed-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.dataset.idx);
      currentJob.locations[idx].needed = input.value;
      debouncedSaveLocations();
    });
  });

  // Name input - debounced save on change
  document.querySelectorAll('#details-locations-list .loc-editable-name-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(input.dataset.idx);
      currentJob.locations[idx].name = input.value;
      debouncedSaveLocations();
    });
  });

  // Delete location
  document.querySelectorAll('#details-locations-list .loc-delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      currentJob.locations.splice(idx, 1);
      await saveCurrentJobLocations();
      renderDetailsModalBody();
    });
  });

  // Add new location button
  const addBtn = document.getElementById('btn-details-add-location');
  if (addBtn) {
    addBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      currentJob.locations.push({ name: '', pressure: '', needed: '' });
      renderDetailsModalBody();
      // Focus the new input
      setTimeout(() => {
        const inputs = document.querySelectorAll('#details-locations-list .loc-editable-name-input');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
      }, 50);
    });
  }
}

// Debounced save (avoid spamming the API on every keystroke)
let __saveLocationsTimer = null;
function debouncedSaveLocations() {
  clearTimeout(__saveLocationsTimer);
  __saveLocationsTimer = setTimeout(() => saveCurrentJobLocations(true), 600);
}

async function saveCurrentJobLocations(silent = false) {
  if (!currentJob) return;
  try {
    // Filter out completely empty locations from saving
    const cleanLocations = currentJob.locations
      .filter(l => (l.name && l.name.trim()) || l.pressure || l.needed)
      .map(l => ({
        name: (l.name || '').trim(),
        pressure: l.pressure || null,
        needed: l.needed ? l.needed.trim() : null
      }));

    const updated = await API.jobs.update(currentJob.id, {
      title: currentJob.title,
      category: currentJob.category,
      status: currentJob.status,
      company: currentJob.company,
      location: currentJob.location,
      locations: cleanLocations,
      salary_range: currentJob.salary_range,
      description: currentJob.description,
      notes: currentJob.notes,
      is_urgent: currentJob.is_urgent
    });
    // Update the job in our local cache (preserve UI working copy in currentJob.locations)
    const idx = allJobs.findIndex(j => j.id == currentJob.id);
    if (idx !== -1) {
      allJobs[idx] = { ...updated, locations: currentJob.locations };
    }
    if (!silent) showToast(I18n.t('saved'));
  } catch (err) {
    console.error('Save locations error:', err);
    showToast(I18n.t('error'), 'error');
  }
}

// ============================================================
// Job Edit Modal
// ============================================================
function openJobModal(job = null) {
  const title = document.getElementById('job-modal-title');

  if (job) {
    title.textContent = I18n.t('edit_job');
    document.getElementById('job-id').value = job.id;
    document.getElementById('job-title').value = job.title || '';
    document.getElementById('job-category').value = job.category || '';
    document.getElementById('job-status').value = job.status || 'open';
    document.getElementById('job-company').value = job.company || '';
    document.getElementById('job-salary').value = job.salary_range || '';
    document.getElementById('job-commission').value = job.commission != null ? job.commission : '';
    document.getElementById('job-description').value = job.description || '';
    document.getElementById('job-notes').value = job.notes || '';
    document.getElementById('job-urgent').checked = !!job.is_urgent;
    currentLocations = Array.isArray(job.locations) ? [...job.locations] : [];
    currentRequirements = Array.isArray(job.requirements) ? [...job.requirements] : [];
  } else {
    title.textContent = I18n.t('new_job');
    document.getElementById('job-form').reset();
    document.getElementById('job-id').value = '';
    document.getElementById('job-urgent').checked = false;
    currentLocations = [];
    currentRequirements = [];
  }

  renderLocationsEditor();
  renderRequirementsEditor();
  openModal('job-modal');
}

function renderLocationsEditor() {
  const container = document.getElementById('locations-editor');
  if (currentLocations.length === 0) {
    container.innerHTML = `<div class="locations-empty">${I18n.t('no_locations')}</div>`;
    return;
  }

  container.innerHTML = currentLocations.map((loc, idx) => `
    <div class="location-edit-row" data-idx="${idx}">
      <input type="text" class="loc-name" data-idx="${idx}" value="${escapeHtml(loc.name || '')}" placeholder="${I18n.t('placeholder_location')}">
      <select class="loc-pressure" data-idx="${idx}">
        <option value="" ${!loc.pressure ? 'selected' : ''}>—</option>
        <option value="high" ${loc.pressure === 'high' ? 'selected' : ''}>${I18n.t('pressure_high')}</option>
        <option value="medium" ${loc.pressure === 'medium' ? 'selected' : ''}>${I18n.t('pressure_medium')}</option>
        <option value="low" ${loc.pressure === 'low' ? 'selected' : ''}>${I18n.t('pressure_low')}</option>
      </select>
      <input type="text" class="loc-needed" data-idx="${idx}" value="${escapeHtml(loc.needed || '')}" placeholder="${I18n.t('placeholder_needed')}">
      <button type="button" class="icon-btn danger loc-remove" data-idx="${idx}" aria-label="${I18n.t('delete')}" title="${I18n.t('delete')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"/>
        </svg>
      </button>
    </div>
  `).join('');

  // Wire up inputs
  container.querySelectorAll('.loc-name').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      currentLocations[idx].name = e.target.value;
    });
  });
  container.querySelectorAll('.loc-pressure').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      currentLocations[idx].pressure = e.target.value;
    });
  });
  container.querySelectorAll('.loc-needed').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      currentLocations[idx].needed = e.target.value;
    });
  });
  container.querySelectorAll('.loc-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.dataset.idx);
      currentLocations.splice(idx, 1);
      renderLocationsEditor();
    });
  });
}

// ============================================================
// Requirements Editor
// ============================================================
function renderRequirementsEditor() {
  const container = document.getElementById('requirements-editor');
  if (!container) return;
  if (currentRequirements.length === 0) {
    container.innerHTML = '<div class="locations-empty">אין דרישות - לחצי "הוסף דרישה"</div>';
    return;
  }

  container.innerHTML = currentRequirements.map((req, idx) => `
    <div class="requirement-edit-row" data-idx="${idx}">
      <input type="text" class="req-text" data-idx="${idx}" value="${escapeHtml(req)}" placeholder="לדוגמה: אנגלית טובה">
      <button type="button" class="icon-btn danger req-remove" data-idx="${idx}" aria-label="מחק">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.req-text').forEach(input => {
    input.addEventListener('input', (e) => {
      currentRequirements[parseInt(e.target.dataset.idx)] = e.target.value;
    });
  });
  container.querySelectorAll('.req-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      currentRequirements.splice(parseInt(btn.dataset.idx), 1);
      renderRequirementsEditor();
    });
  });
}

function addRequirement() {
  currentRequirements.push('');
  renderRequirementsEditor();
  setTimeout(() => {
    const inputs = document.querySelectorAll('.req-text');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }, 50);
}

document.getElementById('btn-add-requirement').addEventListener('click', addRequirement);

function addLocation() {
  currentLocations.push({ name: '', pressure: '', needed: '' });
  renderLocationsEditor();
  // Focus the new input
  setTimeout(() => {
    const inputs = document.querySelectorAll('.loc-name');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  }, 50);
}

async function saveJob() {
  const id = document.getElementById('job-id').value;
  // Filter out empty locations
  const locations = currentLocations
    .filter(l => l.name && l.name.trim())
    .map(l => ({
      name: l.name.trim(),
      pressure: l.pressure || null,
      needed: l.needed ? l.needed.trim() : null
    }));

  const data = {
    title: document.getElementById('job-title').value.trim(),
    category: document.getElementById('job-category').value,
    status: document.getElementById('job-status').value,
    company: document.getElementById('job-company').value.trim(),
    salary_range: document.getElementById('job-salary').value.trim(),
    commission: document.getElementById('job-commission').value ? Number(document.getElementById('job-commission').value) : null,
    description: document.getElementById('job-description').value.trim(),
    notes: document.getElementById('job-notes').value.trim(),
    is_urgent: document.getElementById('job-urgent').checked,
    locations,
    requirements: currentRequirements.filter(r => r.trim())
  };

  if (!data.title || !data.category) {
    showToast(I18n.t('required'), 'error');
    return;
  }

  try {
    if (id) {
      await API.jobs.update(id, data);
    } else {
      await API.jobs.create(data);
    }
    showToast(I18n.t('saved'));
    closeModal('job-modal');
    loadJobs();
  } catch (err) {
    console.error('Save job error:', err);
    showToast(I18n.t('error'), 'error');
  }
}

function onLangChange() {
  renderJobs();
}

// ---------- Event Listeners ----------
document.getElementById('btn-new-job').addEventListener('click', () => openJobModal());
document.getElementById('btn-save-job').addEventListener('click', saveJob);
document.getElementById('btn-add-location').addEventListener('click', addLocation);

// Details modal buttons
document.getElementById('btn-details-edit').addEventListener('click', () => {
  if (!currentJob) return;
  closeModal('job-details-modal');
  setTimeout(() => openJobModal(currentJob), 200);
});
document.getElementById('btn-details-view-candidates').addEventListener('click', () => {
  if (!currentJob) return;
  window.location.href = `candidates.html?job_id=${currentJob.id}`;
});
document.getElementById('btn-details-delete').addEventListener('click', async () => {
  if (!currentJob) return;
  if (!confirm(I18n.t('confirm_delete'))) return;
  try {
    await API.jobs.delete(currentJob.id);
    showToast(I18n.t('deleted'));
    closeModal('job-details-modal');
    loadJobs();
  } catch (err) {
    showToast(I18n.t('error'), 'error');
  }
});

document.getElementById('search-input').addEventListener('input', (e) => {
  filters.search = e.target.value.trim();
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadJobs, 300);
});

// Multi-select category chips
document.querySelectorAll('#category-filter .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const value = chip.dataset.value;

    if (value === 'all') {
      // "All" deselects everything else
      filters.categories = ['all'];
      document.querySelectorAll('#category-filter .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    } else {
      // Remove "all" if selecting specific
      filters.categories = filters.categories.filter(c => c !== 'all');
      document.querySelector('#category-filter .filter-chip[data-value="all"]').classList.remove('active');

      if (chip.classList.contains('active')) {
        // Deselect this chip
        chip.classList.remove('active');
        filters.categories = filters.categories.filter(c => c !== value);
        // If nothing selected, go back to "all"
        if (filters.categories.length === 0) {
          filters.categories = ['all'];
          document.querySelector('#category-filter .filter-chip[data-value="all"]').classList.add('active');
        }
      } else {
        // Select this chip
        chip.classList.add('active');
        filters.categories.push(value);
      }
    }
    loadJobs();
  });
});

// Multi-select location/region chips
document.querySelectorAll('#location-filter .filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const value = chip.dataset.value;
    if (value === 'all') {
      filters.regions = ['all'];
      document.querySelectorAll('#location-filter .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    } else {
      filters.regions = filters.regions.filter(c => c !== 'all');
      document.querySelector('#location-filter .filter-chip[data-value="all"]').classList.remove('active');
      if (chip.classList.contains('active')) {
        chip.classList.remove('active');
        filters.regions = filters.regions.filter(c => c !== value);
        if (filters.regions.length === 0) {
          filters.regions = ['all'];
          document.querySelector('#location-filter .filter-chip[data-value="all"]').classList.add('active');
        }
      } else {
        chip.classList.add('active');
        filters.regions.push(value);
      }
    }
    loadJobs();
  });
});

document.getElementById('filter-status').addEventListener('change', (e) => {
  filters.status = e.target.value;
  loadJobs();
});

// Copy description to clipboard
function copyDescription(btn) {
  const text = btn.getAttribute('data-text');
  navigator.clipboard.writeText(text).then(() => {
    const label = btn.querySelector('span');
    const origText = label.textContent;
    label.textContent = I18n.current === 'he' ? '✓ הועתק!' : '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      label.textContent = origText;
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    const label = btn.querySelector('span');
    label.textContent = I18n.current === 'he' ? '✓ הועתק!' : '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      label.textContent = I18n.current === 'he' ? 'העתק' : 'Copy';
      btn.classList.remove('copied');
    }, 2000);
  });
}

// Apply URL filters on init
const filterStatusEl = document.getElementById('filter-status');
if (filters.status !== 'all') filterStatusEl.value = filters.status;
// Activate category chips from URL
if (!filters.categories.includes('all')) {
  document.querySelector('#category-filter .filter-chip[data-value="all"]').classList.remove('active');
  filters.categories.forEach(cat => {
    const chip = document.querySelector('#category-filter .filter-chip[data-value="' + cat + '"]');
    if (chip) chip.classList.add('active');
  });
}

// ============================================================
// Hover Tooltip - Job Locations Preview
// ============================================================
let __tooltipShowTimer = null;
let __tooltipHideTimer = null;

function showJobTooltip(job, cardEl) {
  clearTimeout(__tooltipHideTimer);
  clearTimeout(__tooltipShowTimer);

  __tooltipShowTimer = setTimeout(() => {
    const tooltip = document.getElementById('job-tooltip');
    if (!tooltip) return;

    const locations = job.locations || [];
    const hasUrgent = locations.some(l => l.pressure === 'high');

    let bodyHtml;
    if (locations.length === 0) {
      bodyHtml = `<div class="job-tooltip-empty">${I18n.t('tooltip_no_locations')}</div>`;
    } else {
      // Sort: urgent first, then medium, then low, then no pressure
      const order = { high: 0, medium: 1, low: 2 };
      const sorted = [...locations].sort((a, b) => {
        const ap = order[a.pressure] !== undefined ? order[a.pressure] : 3;
        const bp = order[b.pressure] !== undefined ? order[b.pressure] : 3;
        return ap - bp;
      });

      bodyHtml = `
        <div class="job-tooltip-locations">
          ${sorted.map(loc => {
            const isUrgent = loc.pressure === 'high';
            return `
              <div class="tooltip-loc ${isUrgent ? 'urgent' : ''}">
                <div class="tooltip-loc-name">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                  </svg>
                  ${escapeHtml(loc.name || '—')}
                </div>
                <div class="tooltip-loc-meta">
                  ${loc.needed ? `<span class="tooltip-needed">${escapeHtml(loc.needed)}</span>` : ''}
                  ${loc.pressure ? `<span class="tooltip-pressure ${loc.pressure}">${I18n.t('pressure_' + loc.pressure)}</span>` : ''}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    tooltip.innerHTML = `
      <div class="job-tooltip-header">
        <div class="job-tooltip-header-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </div>
        <div class="job-tooltip-title">${I18n.t('tooltip_locations_title')}</div>
        ${locations.length > 0 ? `<span class="job-tooltip-count">${locations.length}</span>` : ''}
      </div>
      ${bodyHtml}
      <div class="job-tooltip-footer">${I18n.t('tooltip_click_for_details')}</div>
      <div class="job-tooltip-arrow"></div>
    `;

    positionTooltip(tooltip, cardEl);
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');
  }, 250);
}

function positionTooltip(tooltip, cardEl) {
  // Reset to measure
  tooltip.style.top = '0px';
  tooltip.style.left = '0px';
  tooltip.style.visibility = 'hidden';
  tooltip.classList.add('visible');

  const cardRect = cardEl.getBoundingClientRect();
  const ttRect = tooltip.getBoundingClientRect();
  const arrow = tooltip.querySelector('.job-tooltip-arrow');

  const margin = 12;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  // Horizontal: center on card
  let left = cardRect.left + cardRect.width / 2 - ttRect.width / 2;
  if (left < margin) left = margin;
  if (left + ttRect.width > viewportW - margin) left = viewportW - margin - ttRect.width;

  // Vertical: try above the card first
  let top = cardRect.top - ttRect.height - 12;
  let arrowOnTop = false;
  if (top < margin) {
    // Place below if not enough space above
    top = cardRect.bottom + 12;
    arrowOnTop = true;
  }

  tooltip.style.top = top + 'px';
  tooltip.style.left = left + 'px';
  tooltip.style.visibility = 'visible';
  tooltip.classList.remove('visible'); // re-trigger animation

  // Position arrow horizontally relative to tooltip (centered on card)
  if (arrow) {
    const arrowLeft = (cardRect.left + cardRect.width / 2) - left - 6;
    arrow.style.left = Math.max(12, Math.min(ttRect.width - 24, arrowLeft)) + 'px';
    if (arrowOnTop) arrow.classList.add('top');
  }
}

function hideJobTooltip() {
  clearTimeout(__tooltipShowTimer);
  __tooltipHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('job-tooltip');
    if (!tooltip) return;
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
  }, 100);
}

// Hide tooltip on scroll
window.addEventListener('scroll', hideJobTooltip, { passive: true });

document.getElementById('job-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && !e.target.classList.contains('loc-name') && !e.target.classList.contains('loc-needed')) {
    e.preventDefault();
    saveJob();
  }
});

// ============================================================
// Dynamic Categories UI
// ============================================================
function buildCategoryUI() {
  // Build filter chips
  const filterContainer = document.getElementById('category-filter');
  if (filterContainer) {
    let html = '<button class="filter-chip active" data-value="all">הכל</button>';
    CATEGORIES_DATA.forEach(cat => {
      html += `<button class="filter-chip" data-value="${cat.id}">${I18n.current === 'he' ? cat.label_he : cat.label_en}</button>`;
    });
    html += `<button class="filter-chip add-category-chip" id="btn-add-category-chip" title="הוסף קטגוריה">+</button>`;
    filterContainer.innerHTML = html;

    // Re-attach click handlers
    filterContainer.querySelectorAll('.filter-chip:not(.add-category-chip)').forEach(chip => {
      chip.addEventListener('click', () => {
        const value = chip.dataset.value;
        if (value === 'all') {
          filters.categories = ['all'];
          filterContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
        } else {
          filters.categories = filters.categories.filter(c => c !== 'all');
          filterContainer.querySelector('.filter-chip[data-value="all"]').classList.remove('active');
          if (chip.classList.contains('active')) {
            chip.classList.remove('active');
            filters.categories = filters.categories.filter(c => c !== value);
            if (filters.categories.length === 0) {
              filters.categories = ['all'];
              filterContainer.querySelector('.filter-chip[data-value="all"]').classList.add('active');
            }
          } else {
            chip.classList.add('active');
            filters.categories.push(value);
          }
        }
        loadJobs();
      });
    });

    // Add category button
    document.getElementById('btn-add-category-chip').addEventListener('click', showAddCategoryDialog);
  }

  // Build category select dropdown (in edit form)
  const catSelect = document.getElementById('job-category');
  if (catSelect) {
    let opts = '<option value="">בחרי קטגוריה</option>';
    CATEGORIES_DATA.forEach(cat => {
      opts += `<option value="${cat.id}">${I18n.current === 'he' ? cat.label_he : cat.label_en}</option>`;
    });
    catSelect.innerHTML = opts;
  }
}

function showAddCategoryDialog() {
  const nameHe = prompt(I18n.current === 'he' ? 'שם הקטגוריה בעברית:' : 'Category name (Hebrew):');
  if (!nameHe || !nameHe.trim()) return;

  const nameEn = prompt(I18n.current === 'he' ? 'שם הקטגוריה באנגלית (אופציונלי):' : 'Category name (English, optional):');

  const id = nameHe.trim().toLowerCase()
    .replace(/[\u0590-\u05FF]/g, '')  // remove Hebrew chars for ID
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const finalId = id || 'cat_' + Date.now();

  const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#e91e63', '#00bcd4'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  API.request('/categories', {
    method: 'POST',
    body: JSON.stringify({ id: finalId, label_he: nameHe.trim(), label_en: (nameEn || nameHe).trim(), color })
  }).then(() => {
    showToast(I18n.current === 'he' ? 'קטגוריה נוספה!' : 'Category added!');
    return loadCategories();
  }).then(() => {
    buildCategoryUI();
    loadJobs();
  }).catch(err => {
    showToast(err.message, 'error');
  });
}

// ============================================================
// Dynamic Countries UI
// ============================================================
function buildCountryUI() {
  const filterContainer = document.getElementById('location-filter');
  if (!filterContainer) return;

  let html = '<button class="filter-chip filter-chip-sm active" data-value="all">הכל</button>';
  COUNTRIES_DATA.forEach(country => {
    html += `<button class="filter-chip filter-chip-sm" data-value="${country.id}">${I18n.current === 'he' ? country.label_he : country.label_en}</button>`;
  });
  html += `<button class="filter-chip filter-chip-sm add-category-chip" id="btn-add-country-chip" title="הוסף מדינה">+</button>`;
  filterContainer.innerHTML = html;

  // Re-attach click handlers for country chips
  filterContainer.querySelectorAll('.filter-chip:not(.add-category-chip)').forEach(chip => {
    chip.addEventListener('click', () => {
      const value = chip.dataset.value;
      if (value === 'all') {
        filters.regions = ['all'];
        filterContainer.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      } else {
        filters.regions = filters.regions.filter(r => r !== 'all');
        filterContainer.querySelector('.filter-chip[data-value="all"]').classList.remove('active');
        if (chip.classList.contains('active')) {
          chip.classList.remove('active');
          filters.regions = filters.regions.filter(r => r !== value);
          if (filters.regions.length === 0) {
            filters.regions = ['all'];
            filterContainer.querySelector('.filter-chip[data-value="all"]').classList.add('active');
          }
        } else {
          chip.classList.add('active');
          filters.regions.push(value);
        }
      }
      loadJobs();
    });
  });

  // Add country button
  const addBtn = document.getElementById('btn-add-country-chip');
  if (addBtn) addBtn.addEventListener('click', showAddCountryDialog);
}

function showAddCountryDialog() {
  const nameHe = prompt(I18n.current === 'he' ? 'שם המדינה בעברית (למשל: ישראל):' : 'Country name (Hebrew):');
  if (!nameHe || !nameHe.trim()) return;

  const nameEn = prompt(I18n.current === 'he' ? 'שם המדינה באנגלית (אופציונלי):' : 'Country name (English, optional):');

  const keywordsStr = prompt(
    I18n.current === 'he'
      ? 'מילות חיפוש - ערים / אזורים באותה מדינה, מופרדות בפסיקים (למשל: תל אביב, חיפה, ישראל):'
      : 'Keywords - cities/regions in that country, comma separated:',
    nameHe.trim()
  );
  const keywords = (keywordsStr || nameHe).split(',').map(k => k.trim()).filter(Boolean);

  const id = nameHe.trim().toLowerCase()
    .replace(/[\u0590-\u05FF]/g, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const finalId = id || 'country_' + Date.now();

  API.request('/countries', {
    method: 'POST',
    body: JSON.stringify({ id: finalId, label_he: nameHe.trim(), label_en: (nameEn || nameHe).trim(), keywords })
  }).then(() => {
    showToast(I18n.current === 'he' ? 'מדינה נוספה!' : 'Country added!');
    return loadCountries();
  }).then(() => {
    buildCountryUI();
    loadJobs();
  }).catch(err => {
    showToast(err.message, 'error');
  });
}

// ---------- Initialize ----------
(async function init() {
  await Promise.all([loadCategories(), loadCountries()]);
  buildCategoryUI();
  buildCountryUI();
  loadJobs();
})();
