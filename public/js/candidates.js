/**
 * Candidates (Kanban) page logic
 */

let allCandidates = [];
let allJobs = [];
let filters = { category: 'all', job_id: 'all', search: '', stage: 'all' };

// Read URL params (e.g. ?job_id=5, ?stage=stage1)
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('job_id')) {
  filters.job_id = urlParams.get('job_id');
}
if (urlParams.has('stage')) {
  filters.stage = urlParams.get('stage');
}

async function loadJobs() {
  try {
    allJobs = await API.jobs.list();
    const select = document.getElementById('filter-job');
    const candidateJobSelect = document.getElementById('candidate-job');

    // Populate filter dropdown
    const jobOptions = allJobs.map(j =>
      `<option value="${j.id}">${escapeHtml(j.title)}${j.company ? ' — ' + escapeHtml(j.company) : ''}</option>`
    ).join('');

    select.innerHTML = `<option value="all" data-i18n="all_jobs">${I18n.t('all_jobs')}</option>` + jobOptions;
    candidateJobSelect.innerHTML = `<option value="">${I18n.t('select_job')}</option>` + jobOptions;

    // Apply filter from URL if present
    if (filters.job_id !== 'all') {
      select.value = filters.job_id;
    }
  } catch (err) {
    console.error('Failed to load jobs:', err);
  }
}

async function loadCandidates() {
  try {
    const params = {};
    if (filters.category !== 'all') params.category = filters.category;
    if (filters.job_id !== 'all') params.job_id = filters.job_id;
    if (filters.search) params.search = filters.search;

    allCandidates = await API.candidates.list(params);
    renderKanban();
  } catch (err) {
    console.error('Failed to load candidates:', err);
    showToast(I18n.t('error'), 'error');
  }
}

function renderKanban() {
  const columns = {
    stage1: [],
    stage2: [],
    accepted: []
  };

  allCandidates.forEach(c => {
    if (columns[c.stage]) columns[c.stage].push(c);
  });

  // Update counts
  document.getElementById('count-stage1').textContent = columns.stage1.length;
  document.getElementById('count-stage2').textContent = columns.stage2.length;
  document.getElementById('count-accepted').textContent = columns.accepted.length;

  // Render each column
  renderColumn('stage1', columns.stage1);
  renderColumn('stage2', columns.stage2);
  renderColumn('accepted', columns.accepted);
  renderPaymentSummary(columns.accepted);

  // Highlight the column that matches URL stage filter
  if (filters.stage && filters.stage !== 'all') {
    document.querySelectorAll('.kanban-column').forEach(col => col.classList.remove('highlighted', 'dimmed'));
    const targetColumn = document.getElementById('column-' + filters.stage);
    if (targetColumn) {
      const parentColumn = targetColumn.closest('.kanban-column');
      if (parentColumn) {
        parentColumn.classList.add('highlighted');
        // Dim other columns
        document.querySelectorAll('.kanban-column').forEach(col => {
          if (col !== parentColumn) col.classList.add('dimmed');
        });
      }
    }
  }
}

function renderColumn(stage, items) {
  const container = document.getElementById('column-' + stage);

  if (items.length === 0) {
    const emptyIcons = { stage1: '👋', stage2: '📋', accepted: '🎉' };
    container.innerHTML = `
      <div class="kanban-empty">
        <div class="kanban-empty-icon">${emptyIcons[stage] || '✨'}</div>
        <div>${I18n.t('no_candidates_' + stage)}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = items.map(c => renderCandidateCard(c, stage)).join('');

  // Card click -> open modal
  container.querySelectorAll('.candidate-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.move-btn')) return;
      const id = card.dataset.id;
      const candidate = allCandidates.find(c => c.id == id);
      if (candidate) openCandidateModal(candidate);
    });
  });

  // Move buttons
  container.querySelectorAll('.move-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const newStage = btn.dataset.stage;
      try {
        await API.candidates.updateStage(id, newStage);
        showToast(I18n.t('saved'));
        loadCandidates();
      } catch (err) {
        showToast(I18n.t('error'), 'error');
      }
    });
  });
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function getAvatarColor(id) {
  return 'color-' + ((id % 6) + 1);
}

function getFollowUpStatus(candidate) {
  if (!candidate.follow_up_at || candidate.follow_up_done) return null;
  const now = new Date();
  const due = new Date(candidate.follow_up_at);
  const diffMs = due.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffMs < 0) return 'overdue';
  if (diffHours < 24) return 'due-soon';
  return 'upcoming';
}

function renderCandidateCard(candidate, stage) {
  const stageOrder = ['stage1', 'stage2', 'accepted'];
  const currentIdx = stageOrder.indexOf(stage);
  const canPrev = currentIdx > 0;
  const canNext = currentIdx < stageOrder.length - 1;
  const prevStage = canPrev ? stageOrder[currentIdx - 1] : null;
  const nextStage = canNext ? stageOrder[currentIdx + 1] : null;

  const isRtl = document.documentElement.dir === 'rtl';
  const initials = getInitials(candidate.name);
  const avatarColor = getAvatarColor(candidate.id);
  const followUpStatus = getFollowUpStatus(candidate);
  const followUpClass = followUpStatus === 'overdue' ? 'has-followup-overdue' : '';

  let followUpBadgeHtml = '';
  if (followUpStatus) {
    const labels = {
      'overdue': I18n.t('follow_up_overdue'),
      'due-soon': I18n.t('follow_up_due_soon'),
      'upcoming': I18n.t('follow_up_upcoming')
    };
    followUpBadgeHtml = `
      <div class="follow-up-badge ${followUpStatus}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        ${formatDateShort(candidate.follow_up_at)}
      </div>
    `;
  }

  const waLink = buildWhatsAppLink(candidate.phone);

  return `
    <div class="candidate-card ${followUpClass}" data-id="${candidate.id}">
      <div class="candidate-card-top">
        <div class="candidate-avatar ${avatarColor}">${escapeHtml(initials)}</div>
        <div class="candidate-card-info">
          <div class="candidate-card-name">${escapeHtml(candidate.name)}</div>
          ${candidate.phone ? `
            <div class="candidate-card-phone-row">
              <div class="candidate-card-phone" dir="ltr">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                ${escapeHtml(candidate.phone)}
              </div>
              ${waLink ? `
                <a href="${waLink}" target="_blank" rel="noopener" class="whatsapp-btn" onclick="event.stopPropagation()" title="WhatsApp" aria-label="WhatsApp">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                  </svg>
                </a>
              ` : ''}
            </div>
          ` : ''}
        </div>
        ${candidate.job_category ? getCategoryTag(candidate.job_category) : ''}
      </div>
      ${candidate.job_title ? `
        <div class="candidate-card-job">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2"/>
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>
          </svg>
          <span class="candidate-card-job-title">${escapeHtml(candidate.job_title)}${candidate.job_company ? ' · ' + escapeHtml(candidate.job_company) : ''}</span>
        </div>
      ` : ''}
      ${followUpBadgeHtml ? `<div style="margin-top: 10px;">${followUpBadgeHtml}</div>` : ''}
      ${candidate.call_summary ? `
        <div class="candidate-card-summary">${escapeHtml(candidate.call_summary)}</div>
      ` : ''}
      ${stage === 'accepted' && (candidate.start_date || candidate.payment_date || candidate.payment_amount) ? `
        <div class="candidate-payment-info">
          ${candidate.payment_plan ? `<div class="payment-row"><span>📋 תוכנית:</span><strong>${{
            '45days': '45 יום',
            '2weeks': 'שבועיים ($500)',
            '5050': '50/50',
            'custom': 'ידני'
          }[candidate.payment_plan] || candidate.payment_plan}</strong></div>` : ''}
          ${candidate.start_date ? `<div class="payment-row"><span>📅 הגעה:</span><strong>${candidate.start_date}</strong></div>` : ''}
          ${candidate.payment_date ? `<div class="payment-row"><span>💰 תשלום:</span><strong>${candidate.payment_date}</strong></div>` : ''}
          ${candidate.payment_amount ? `<div class="payment-row"><span>💵 סכום:</span><strong>$${Number(candidate.payment_amount).toLocaleString()}</strong></div>` : ''}
        </div>
      ` : ''}
      <div class="candidate-card-footer">
        <div class="candidate-card-date">
          ${candidate.call_date ? `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
            ${formatDateShort(candidate.call_date)}
          ` : '—'}
        </div>
        <div class="candidate-card-move">
          ${canPrev ? `
            <button class="move-btn" data-id="${candidate.id}" data-stage="${prevStage}" title="${I18n.t('prev_stage')}">
              ${isRtl ? '→' : '←'}
            </button>
          ` : ''}
          ${canNext ? `
            <button class="move-btn" data-id="${candidate.id}" data-stage="${nextStage}" title="${I18n.t('next_stage')}">
              ${isRtl ? '←' : '→'}
            </button>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

function openCandidateModal(candidate = null) {
  const modal = document.getElementById('candidate-modal');
  const title = document.getElementById('candidate-modal-title');
  const deleteBtn = document.getElementById('btn-delete-candidate');

  if (candidate) {
    title.textContent = I18n.t('edit_candidate');
    document.getElementById('candidate-id').value = candidate.id;
    document.getElementById('candidate-name').value = candidate.name || '';
    document.getElementById('candidate-phone').value = candidate.phone || '';
    document.getElementById('candidate-email').value = candidate.email || '';
    document.getElementById('candidate-source').value = candidate.source || '';
    document.getElementById('candidate-job').value = candidate.job_id || '';
    document.getElementById('candidate-stage').value = candidate.stage || 'stage1';
    // Format date for datetime-local input
    if (candidate.call_date) {
      const d = new Date(candidate.call_date);
      if (!isNaN(d)) {
        const pad = n => String(n).padStart(2, '0');
        const formatted = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        document.getElementById('candidate-call-date').value = formatted;
      } else {
        document.getElementById('candidate-call-date').value = '';
      }
    } else {
      document.getElementById('candidate-call-date').value = '';
    }
    // Format follow-up date
    if (candidate.follow_up_at) {
      const f = new Date(candidate.follow_up_at);
      if (!isNaN(f)) {
        const pad = n => String(n).padStart(2, '0');
        document.getElementById('candidate-follow-up').value =
          `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}T${pad(f.getHours())}:${pad(f.getMinutes())}`;
      } else {
        document.getElementById('candidate-follow-up').value = '';
      }
    } else {
      document.getElementById('candidate-follow-up').value = '';
    }
    document.getElementById('candidate-summary').value = candidate.call_summary || '';
    document.getElementById('candidate-notes').value = candidate.notes || '';
    document.getElementById('candidate-start-date').value = candidate.start_date || '';
    document.getElementById('candidate-payment-date').value = candidate.payment_date || '';
    document.getElementById('candidate-payment-amount').value = candidate.payment_amount != null ? candidate.payment_amount : '';
    // Set active payment plan button
    const savedPlan = candidate.payment_plan || '';
    document.getElementById('candidate-payment-plan').value = savedPlan;
    document.querySelectorAll('#payment-plan-options .plan-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.plan === savedPlan);
    });
    if (savedPlan && candidate.start_date) {
      calculatePaymentSchedule();
    } else {
      document.getElementById('payment-schedule-section').style.display = 'none';
    }
    deleteBtn.style.display = '';
  } else {
    title.textContent = I18n.t('new_candidate');
    document.getElementById('candidate-form').reset();
    document.getElementById('candidate-id').value = '';
    // Default to current date/time for call_date
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    document.getElementById('candidate-call-date').value = nowStr;
    document.getElementById('candidate-follow-up').value = '';
    document.getElementById('candidate-start-date').value = '';
    document.getElementById('candidate-payment-date').value = '';
    document.getElementById('candidate-payment-amount').value = '';
    document.getElementById('candidate-payment-plan').value = '';
    document.querySelectorAll('#payment-plan-options .plan-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('payment-schedule-section').style.display = 'none';
    deleteBtn.style.display = 'none';
  }

  // Update WhatsApp button visibility based on phone
  updatePhoneWaBtn();

  // Show/hide payment fields based on stage
  togglePaymentFields();

  openModal('candidate-modal');
}

function togglePaymentFields() {
  const stage = document.getElementById('candidate-stage').value;
  const paymentFields = document.getElementById('payment-fields');
  if (paymentFields) {
    paymentFields.style.display = stage === 'accepted' ? 'block' : 'none';
  }
}

async function saveCandidate() {
  const id = document.getElementById('candidate-id').value;
  const data = {
    name: document.getElementById('candidate-name').value.trim(),
    phone: document.getElementById('candidate-phone').value.trim(),
    email: document.getElementById('candidate-email').value.trim(),
    source: document.getElementById('candidate-source').value.trim(),
    job_id: document.getElementById('candidate-job').value || null,
    stage: document.getElementById('candidate-stage').value,
    call_date: document.getElementById('candidate-call-date').value || null,
    follow_up_at: document.getElementById('candidate-follow-up').value || null,
    call_summary: document.getElementById('candidate-summary').value.trim(),
    notes: document.getElementById('candidate-notes').value.trim(),
    start_date: document.getElementById('candidate-start-date').value || null,
    payment_date: document.getElementById('candidate-payment-date').value || null,
    payment_amount: document.getElementById('candidate-payment-amount').value || null,
    payment_plan: document.getElementById('candidate-payment-plan').value || null
  };

  if (!data.name) {
    showToast(I18n.t('required'), 'error');
    return;
  }

  try {
    if (id) {
      await API.candidates.update(id, data);
    } else {
      await API.candidates.create(data);
    }
    showToast(I18n.t('saved'));
    closeModal('candidate-modal');
    loadCandidates();
  } catch (err) {
    console.error('Save candidate error:', err);
    showToast(I18n.t('error'), 'error');
  }
}

async function deleteCandidate() {
  const id = document.getElementById('candidate-id').value;
  if (!id) return;
  if (!confirm(I18n.t('confirm_delete'))) return;
  try {
    await API.candidates.delete(id);
    showToast(I18n.t('deleted'));
    closeModal('candidate-modal');
    loadCandidates();
  } catch (err) {
    showToast(I18n.t('error'), 'error');
  }
}

function onLangChange() {
  renderKanban();
}

// ---------- Event Listeners ----------
document.getElementById('btn-new-candidate').addEventListener('click', () => openCandidateModal());
document.getElementById('btn-save-candidate').addEventListener('click', saveCandidate);
document.getElementById('btn-delete-candidate').addEventListener('click', deleteCandidate);

document.getElementById('search-input').addEventListener('input', (e) => {
  filters.search = e.target.value.trim();
  clearTimeout(window.__searchTimer);
  window.__searchTimer = setTimeout(loadCandidates, 300);
});

document.getElementById('filter-category').addEventListener('change', (e) => {
  filters.category = e.target.value;
  loadCandidates();
});

document.getElementById('filter-job').addEventListener('change', (e) => {
  filters.job_id = e.target.value;
  loadCandidates();
});

document.getElementById('candidate-form').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    saveCandidate();
  }
});

// WhatsApp button in modal - update href as user types phone number
// Show/hide payment fields when stage changes
document.getElementById('candidate-stage').addEventListener('change', togglePaymentFields);

// Payment plan buttons
document.querySelectorAll('#payment-plan-options .plan-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#payment-plan-options .plan-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('candidate-payment-plan').value = btn.dataset.plan;
    calculatePaymentSchedule();
  });
});

// Recalculate when start date or amount changes
document.getElementById('candidate-start-date').addEventListener('change', calculatePaymentSchedule);
document.getElementById('candidate-payment-amount').addEventListener('input', calculatePaymentSchedule);

function calculatePaymentSchedule() {
  const plan = document.getElementById('candidate-payment-plan').value;
  const startDate = document.getElementById('candidate-start-date').value;
  const totalAmount = parseFloat(document.getElementById('candidate-payment-amount').value) || 0;
  const scheduleSection = document.getElementById('payment-schedule-section');
  const scheduleDisplay = document.getElementById('payment-schedule-display');
  const paymentDateField = document.getElementById('candidate-payment-date');

  if (!plan || !startDate) {
    scheduleSection.style.display = 'none';
    return;
  }

  const start = new Date(startDate);
  const payments = [];
  const formatDate = (d) => d.toLocaleDateString('he-IL', { year: 'numeric', month: 'short', day: 'numeric' });
  const toISO = (d) => d.toISOString().split('T')[0];

  if (plan === '45days') {
    const payDate = new Date(start);
    payDate.setDate(payDate.getDate() + 45);
    payments.push({ label: 'תשלום מלא (אחרי 45 יום)', date: payDate, amount: totalAmount });
    paymentDateField.value = toISO(payDate);
  }
  else if (plan === '2weeks') {
    const payDate = new Date(start);
    payDate.setDate(payDate.getDate() + 14);
    const amount = 500;
    payments.push({ label: 'תשלום ($500 אחרי שבועיים)', date: payDate, amount });
    paymentDateField.value = toISO(payDate);
    if (totalAmount > 500) {
      document.getElementById('candidate-payment-amount').value = 500;
    }
  }
  else if (plan === '5050') {
    const firstPay = new Date(start);
    const secondPay = new Date(start);
    secondPay.setDate(secondPay.getDate() + 30);
    const half = Math.round(totalAmount / 2);
    payments.push({ label: 'תשלום ראשון (50% בנחיתה)', date: firstPay, amount: half });
    payments.push({ label: 'תשלום שני (50% אחרי חודש)', date: secondPay, amount: totalAmount - half });
    paymentDateField.value = toISO(firstPay);
  }
  else if (plan === 'custom') {
    scheduleSection.style.display = 'none';
    return;
  }

  if (payments.length === 0) {
    scheduleSection.style.display = 'none';
    return;
  }

  const total = payments.reduce((s, p) => s + p.amount, 0);

  scheduleDisplay.innerHTML = payments.map(p => `
    <div class="schedule-row">
      <div class="schedule-row-label">${p.label}</div>
      <div class="schedule-row-date">${formatDate(p.date)}</div>
      <div class="schedule-row-amount">$${p.amount.toLocaleString()}</div>
    </div>
  `).join('') + (payments.length > 1 ? `
    <div class="schedule-row total">
      <div class="schedule-row-label">סה"כ</div>
      <div class="schedule-row-date"></div>
      <div class="schedule-row-amount">$${total.toLocaleString()}</div>
    </div>
  ` : '');

  scheduleSection.style.display = 'block';
}

// Export CSV button
document.getElementById('btn-export-csv').addEventListener('click', () => {
  const token = API.getToken();
  window.open('/api/candidates/export/accepted?token=' + token, '_blank');
});

function updatePhoneWaBtn() {
  const phone = document.getElementById('candidate-phone').value;
  const waBtn = document.getElementById('candidate-phone-wa');
  if (!waBtn) return;
  const link = buildWhatsAppLink(phone);
  if (link) {
    waBtn.href = link;
    waBtn.classList.remove('hidden');
  } else {
    waBtn.classList.add('hidden');
  }
}
document.getElementById('candidate-phone').addEventListener('input', updatePhoneWaBtn);

// ---------- Payment Summary ----------
function renderPaymentSummary(acceptedCandidates) {
  const container = document.getElementById('payment-summary');
  if (!container) return;

  const withPayment = acceptedCandidates.filter(c => c.payment_date && c.payment_amount);
  if (withPayment.length === 0) {
    container.innerHTML = '';
    return;
  }

  // Group by month
  const byMonth = {};
  withPayment.forEach(c => {
    const d = new Date(c.payment_date);
    if (isNaN(d)) return;
    const monthNames = I18n.current === 'he'
      ? ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר']
      : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const label = monthNames[d.getMonth()] + ' ' + d.getFullYear();
    if (!byMonth[key]) byMonth[key] = { label, total: 0, count: 0 };
    byMonth[key].total += Number(c.payment_amount);
    byMonth[key].count++;
  });

  const months = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  const grandTotal = months.reduce((s, [, m]) => s + m.total, 0);

  container.innerHTML = `
    <div class="payment-summary-inner">
      <div class="payment-summary-title">💰 סיכום תשלומים לפי חודש</div>
      ${months.map(([, m]) => `
        <div class="payment-month-row">
          <span class="payment-month-label">${m.label} (${m.count})</span>
          <span class="payment-month-amount">$${m.total.toLocaleString()}</span>
        </div>
      `).join('')}
      <div class="payment-total-row">
        <span>סה"כ</span>
        <span class="payment-total-amount">$${grandTotal.toLocaleString()}</span>
      </div>
    </div>
  `;
}

// ---------- Initial load ----------
(async function init() {
  await loadJobs();
  await loadCandidates();
})();
