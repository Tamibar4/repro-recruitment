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
    no_response: [],
    accepted: [],
    rejected: []
  };

  // Only active stages in main Kanban (delayed goes to separate tab)
  allCandidates.forEach(c => {
    if (c.stage !== 'delayed' && columns[c.stage]) {
      columns[c.stage].push(c);
    }
  });

  // Update counts
  document.getElementById('count-stage1').textContent = columns.stage1.length;
  document.getElementById('count-stage2').textContent = columns.stage2.length;
  document.getElementById('count-no_response').textContent = columns.no_response.length;
  document.getElementById('count-rejected').textContent = columns.rejected.length;

  // Render each column (accepted shows as separate table below)
  renderColumn('stage1', columns.stage1);
  renderColumn('stage2', columns.stage2);
  renderColumn('no_response', columns.no_response);
  renderColumn('rejected', columns.rejected);
  renderAcceptedTable(columns.accepted);
  // Wire up drag-drop targets on each kanban-column so the user can
  // drag a row into another stage's container.
  wireStageDropTargets();

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

// Map of passport_type values → Hebrew labels for display
const PASSPORT_LABELS = {
  american: '🇺🇸 אמריקאי',
  green_card: '💳 גרין קארד',
  tourist_visa: '🛂 ויזת תייר',
  esta_visa: '✈️ ESTA',
  '': '–',
  null: '–'
};
function passportLabel(p) { return PASSPORT_LABELS[p || ''] || '–'; }

// Render a stage's container as a TABLE (instead of the old card view).
// Each stage gets its own column set:
//   - stage1: full detail (date, phone+WA, name, age, residence, job,
//             passport, availability, has-card, summary)
//   - stage2: focused on the two summaries (recruiter + employer)
//   - no_response / rejected / delayed: compact view (date, name,
//             phone+WA, job, summary)
//
// Every row is draggable so the user can drop it on a different
// stage's container to move it.
function renderColumn(stage, items) {
  const container = document.getElementById('column-' + stage);
  if (!container) return;

  if (items.length === 0) {
    const emptyIcons = { stage1: '👋', stage2: '📋', no_response: '🔇', accepted: '🎉', rejected: '📭', delayed: '⏳' };
    const emptyTexts = {
      stage1: 'אין מועמדים בשלב זה',
      stage2: 'אין מועמדים בשלב זה',
      no_response: 'אין מועמדים שלא ענו',
      accepted: 'אין מועמדים בשלב זה',
      rejected: 'אין מועמדים לא רלוונטיים',
      delayed: 'אין מועמדים עם זמינות מאוחרת'
    };
    container.innerHTML = `
      <div class="kanban-empty">
        <div class="kanban-empty-icon">${emptyIcons[stage] || '✨'}</div>
        <div>${emptyTexts[stage] || 'אין מועמדים'}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="cand-table-wrap">
      <table class="cand-table">
        ${renderTableHeader(stage)}
        <tbody>
          ${items.map(c => renderCandidateRow(c, stage)).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Row click → open modal (but not if drag, button, or link was clicked)
  container.querySelectorAll('tr.cand-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, textarea, .cand-row-actions')) return;
      const id = row.dataset.id;
      const candidate = allCandidates.find(c => c.id == id);
      if (candidate) openCandidateModal(candidate);
    });
    // Drag-and-drop: row → another stage's container
    row.addEventListener('dragstart', (e) => {
      if (e.target.closest('button, a, input, textarea')) {
        e.preventDefault();
        return;
      }
      draggingCandidateId = parseInt(row.dataset.id, 10);
      row.classList.add('is-dragging');
      try { e.dataTransfer.effectAllowed = 'move'; } catch {}
      try { e.dataTransfer.setData('text/plain', 'candidate:' + row.dataset.id); } catch {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('is-drop-target'));
      draggingCandidateId = null;
    });
  });

  // Move buttons (kept as a fallback for non-drag use)
  container.querySelectorAll('.cand-move-btn').forEach(btn => {
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

// Mutable state for drag-and-drop between stages
let draggingCandidateId = null;

// Holds the parsed rows after the user picks a file, ready for the
// user to confirm and POST to /api/candidates/bulk.
let pendingImportRows = null;

// ===== Excel/CSV import =====
// SheetJS is loaded lazily from cdnjs on first use. Returns the
// global XLSX object once ready.
async function loadSheetJs() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX not loaded'));
    s.onerror = () => reject(new Error('כשל בטעינת ספריית האקסל. בדקי חיבור לאינטרנט.'));
    document.head.appendChild(s);
  });
}

// Map header text → candidate field. Loose matching, case-insensitive,
// matches Hebrew and English variations.
function detectColumn(header) {
  const h = String(header || '').toLowerCase().trim();
  if (!h) return null;
  const isAny = (...needles) => needles.some(n => h.includes(n));
  if (isAny('שם') && !isAny('משפחה')) return 'name';
  if (h === 'name' || h === 'full name') return 'name';
  if (isAny('טלפון', 'נייד', 'phone', 'mobile')) return 'phone';
  if (isAny('אימייל', 'מייל', 'email')) return 'email';
  if (isAny('גיל', 'age')) return 'age';
  if (isAny('מגורים', 'עיר', 'כתובת', 'residence', 'city', 'address')) return 'current_residence';
  if (isAny('משרה', 'תפקיד', 'job', 'position')) return 'job_title';
  if (isAny('סיכום', 'הערות', 'תיאור', 'summary', 'notes', 'description')) return 'call_summary';
  if (isAny('מקור', 'source', 'origin')) return 'source';
  if (isAny('דרכון', 'passport', 'ויזה', 'visa')) return 'passport_type';
  if (isAny('זמינות', 'available')) return 'available_from';
  return null;
}

// Convert a passport raw value (free text from Excel) to one of our
// enum slugs, or null if unrecognized.
function normalizePassport(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s || s === '-' || s === '–') return null;
  if (s.includes('אמריק') || s.includes('us') || s.includes('america')) return 'american';
  if (s.includes('גרין') || s.includes('green')) return 'green_card';
  if (s.includes('esta') || s.includes('איסת')) return 'esta_visa';
  if (s.includes('תייר') || s.includes('tourist')) return 'tourist_visa';
  return null;
}

async function openImportModal() {
  // Reset modal state
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-step-pick').style.display = '';
  document.getElementById('import-step-preview').style.display = 'none';
  document.getElementById('import-step-result').style.display = 'none';
  document.getElementById('import-confirm-btn').style.display = 'none';
  document.getElementById('import-back-btn').style.display = 'none';
  pendingImportRows = null;
  openModal('import-modal');
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const XLSX = await loadSheetJs();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('הקובץ ריק');
    const sheet = wb.Sheets[sheetName];
    // Parse with header:1 so we get a 2D array
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (aoa.length < 2) throw new Error('הקובץ חייב להכיל שורת כותרות + לפחות שורת נתונים אחת');

    const headers = aoa[0].map(h => String(h || '').trim());
    const dataRows = aoa.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));

    // Map columns: header index → candidate field
    const colMap = headers.map(detectColumn);

    // Build candidate-shape rows
    const rows = dataRows.map(r => {
      const obj = {};
      colMap.forEach((field, i) => {
        if (!field) return;
        const val = String(r[i] || '').trim();
        if (!val) return;
        if (field === 'passport_type') {
          obj.passport_type = normalizePassport(val);
        } else if (field === 'age') {
          const n = parseInt(val, 10);
          obj.age = isNaN(n) ? null : n;
        } else {
          obj[field] = val;
        }
      });
      return obj;
    });

    pendingImportRows = rows;
    renderImportPreview(headers, colMap, dataRows, rows);
  } catch (err) {
    showToast(err.message || 'שגיאה בקריאת הקובץ', 'error');
  }
}

function renderImportPreview(headers, colMap, rawRows, parsed) {
  document.getElementById('import-step-pick').style.display = 'none';
  document.getElementById('import-step-preview').style.display = '';
  document.getElementById('import-back-btn').style.display = '';
  document.getElementById('import-confirm-btn').style.display = '';

  const total = parsed.length;
  const withName = parsed.filter(r => r.name).length;
  const mapped = colMap.filter(Boolean).length;
  document.getElementById('import-preview-summary').innerHTML = `
    <div style="background:var(--color-bg);padding:12px;border-radius:8px">
      📊 <strong>${total}</strong> שורות מהקובץ ·
      <strong>${withName}</strong> עם שם · זוהו אוטומטית <strong>${mapped}</strong> מתוך ${headers.length} עמודות.
      ${withName < total ? `<div style="color:var(--color-red);margin-top:6px;font-size:12px">⚠️ ${total - withName} שורות בלי שם — ידולגו בייבוא.</div>` : ''}
    </div>
  `;

  // Render the table — show first 10 rows so the user can sanity-check
  const fieldLabels = {
    name: 'שם', phone: 'טלפון', email: 'אימייל', age: 'גיל',
    current_residence: 'מגורים', job_title: 'משרה',
    call_summary: 'סיכום', source: 'מקור',
    passport_type: 'דרכון', available_from: 'זמינות'
  };
  const showRows = parsed.slice(0, 10);
  const tableHtml = `
    <table style="width:100%;font-size:12.5px;border-collapse:collapse">
      <thead style="background:var(--color-accent-soft);position:sticky;top:0">
        <tr>
          ${headers.map((h, i) => {
            const mapped = colMap[i];
            return `<th style="padding:8px;text-align:start;border-bottom:1px solid var(--color-border)">
              ${escapeHtml(h || '(ללא כותרת)')}
              ${mapped
                ? `<div style="font-size:10px;color:var(--color-primary);margin-top:2px">→ ${fieldLabels[mapped] || mapped}</div>`
                : `<div style="font-size:10px;color:var(--color-text-light);margin-top:2px">לא ממופה</div>`}
            </th>`;
          }).join('')}
        </tr>
      </thead>
      <tbody>
        ${rawRows.slice(0, 10).map(r => `
          <tr>
            ${headers.map((_, i) => `<td style="padding:8px;border-bottom:1px solid var(--color-border)">${escapeHtml(String(r[i] || ''))}</td>`).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    ${parsed.length > 10 ? `<div style="padding:10px;text-align:center;font-size:12px;color:var(--color-text-light)">... ועוד ${parsed.length - 10} שורות</div>` : ''}
  `;
  document.getElementById('import-preview-table').innerHTML = tableHtml;
}

async function confirmImport() {
  if (!pendingImportRows || pendingImportRows.length === 0) {
    showToast('אין שורות לייבא', 'error');
    return;
  }
  const stage = document.getElementById('import-default-stage').value;
  const btn = document.getElementById('import-confirm-btn');
  btn.disabled = true;
  btn.textContent = '⏳ מייבא...';
  try {
    const result = await API.request('/candidates/bulk', {
      method: 'POST',
      body: JSON.stringify({ rows: pendingImportRows, default_stage: stage })
    });
    renderImportResult(result);
    loadCandidates(); // Refresh the page so new candidates appear
  } catch (err) {
    showToast(err.message || 'הייבוא נכשל', 'error');
    btn.disabled = false;
    btn.textContent = '✓ ייבא את הלידים';
  }
}

function renderImportResult(result) {
  document.getElementById('import-step-preview').style.display = 'none';
  document.getElementById('import-step-result').style.display = '';
  document.getElementById('import-back-btn').style.display = 'none';
  document.getElementById('import-confirm-btn').style.display = 'none';

  const dupHtml = result.duplicates && result.duplicates.length
    ? `<div style="margin-top:14px;padding:12px;background:rgba(253,171,61,0.1);border-radius:8px;font-size:13px">
        <strong>⚠️ ${result.duplicates.length} כפולים דולגו</strong> (טלפון כבר קיים):
        <ul style="margin:6px 0 0;padding-right:18px;font-size:12px">
          ${result.duplicates.slice(0, 10).map(d => `<li>שורה ${d.row}: ${escapeHtml(d.name)} (${escapeHtml(d.phone)}) — כבר קיים כ-"${escapeHtml(d.existing_name)}"</li>`).join('')}
          ${result.duplicates.length > 10 ? `<li>...ועוד ${result.duplicates.length - 10}</li>` : ''}
        </ul>
      </div>`
    : '';

  const errHtml = result.errors && result.errors.length
    ? `<div style="margin-top:14px;padding:12px;background:rgba(226,68,92,0.08);border-radius:8px;font-size:13px;color:var(--color-red)">
        <strong>❌ ${result.errors.length} שגיאות</strong>:
        <ul style="margin:6px 0 0;padding-right:18px;font-size:12px">
          ${result.errors.slice(0, 10).map(e => `<li>שורה ${e.row}: ${escapeHtml(e.error)}</li>`).join('')}
        </ul>
      </div>`
    : '';

  document.getElementById('import-result-content').innerHTML = `
    <div style="text-align:center;padding:20px">
      <div style="font-size:48px;margin-bottom:10px">✅</div>
      <div style="font-size:18px;font-weight:800;color:var(--color-text);margin-bottom:6px">
        ${result.created} לידים נוספו בהצלחה!
      </div>
      <div style="font-size:13px;color:var(--color-text-secondary)">
        מתוך ${result.total} שורות בקובץ
      </div>
    </div>
    ${dupHtml}
    ${errHtml}
  `;
}

// Wire the kanban-column elements as drop targets — called once per
// renderKanban() so handlers live as long as the DOM nodes do.
function wireStageDropTargets() {
  document.querySelectorAll('.kanban-column').forEach(col => {
    // Each column corresponds to a stage via its data-stage attribute,
    // which we'll set on the column root in renderKanban.
    col.addEventListener('dragover', (e) => {
      if (draggingCandidateId == null) return;
      const targetStage = col.dataset.stage;
      if (!targetStage) return;
      const cand = allCandidates.find(c => c.id === draggingCandidateId);
      if (cand && cand.stage === targetStage) return; // same stage = no-op
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      document.querySelectorAll('.kanban-column').forEach(c => c.classList.remove('is-drop-target'));
      col.classList.add('is-drop-target');
    });
    col.addEventListener('dragleave', (e) => {
      // Only clear if we actually left the column (not just moved over a child)
      if (!col.contains(e.relatedTarget)) col.classList.remove('is-drop-target');
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('is-drop-target');
      if (draggingCandidateId == null) return;
      const targetStage = col.dataset.stage;
      const id = draggingCandidateId;
      draggingCandidateId = null;
      const cand = allCandidates.find(c => c.id === id);
      if (!cand || !targetStage || cand.stage === targetStage) return;
      try {
        await API.candidates.updateStage(id, targetStage);
        showToast(`הליד הועבר ל-"${stageLabel(targetStage)}"`);
        loadCandidates();
      } catch (err) {
        showToast(err.message || 'ההעברה נכשלה', 'error');
      }
    });
  });
}

function stageLabel(stage) {
  return ({
    stage1: 'שלב ראשון',
    stage2: 'שלב שני',
    no_response: 'אין מענה',
    accepted: 'התקבלו',
    rejected: 'לא רלוונטים'
  })[stage] || stage;
}

// Returns the <thead> for a given stage's table
function renderTableHeader(stage) {
  if (stage === 'stage1') {
    return `
      <thead>
        <tr>
          <th>תאריך הוספה</th>
          <th>טלפון</th>
          <th>שם</th>
          <th>גיל</th>
          <th>מגורים</th>
          <th>משרה</th>
          <th>סוג דרכון</th>
          <th>זמינות</th>
          <th>כרטיס</th>
          <th>סיכום שיחה</th>
          <th class="cand-table-actions-col"></th>
        </tr>
      </thead>`;
  }
  if (stage === 'stage2') {
    return `
      <thead>
        <tr>
          <th>תאריך</th>
          <th>טלפון</th>
          <th>שם</th>
          <th>משרה</th>
          <th>סיכום שיחה (מהצד שלי)</th>
          <th>סיכום שיחה (מהצד של המעסיק)</th>
          <th class="cand-table-actions-col"></th>
        </tr>
      </thead>`;
  }
  // no_response / rejected / delayed
  return `
    <thead>
      <tr>
        <th>תאריך</th>
        <th>טלפון</th>
        <th>שם</th>
        <th>משרה</th>
        <th>סיכום שיחה</th>
        <th class="cand-table-actions-col"></th>
      </tr>
    </thead>`;
}

// Build the WhatsApp icon link for a phone (returns '' if no valid number)
function waCell(phone) {
  if (!phone) return '–';
  const link = buildWhatsAppLink(phone);
  const phoneDisplay = `<span class="cand-phone-num" dir="ltr">${escapeHtml(phone)}</span>`;
  if (!link) return phoneDisplay;
  return `
    <a href="${link}" target="_blank" rel="noopener" class="cand-wa-icon" title="WhatsApp" aria-label="WhatsApp" onclick="event.stopPropagation()">
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
      </svg>
    </a>
    ${phoneDisplay}`;
}

// Card cell for stage1 table: shows ✅ + date + destination if has_card,
// otherwise a dash. Uses a tooltip for the full date/destination when
// they're truncated in the cell.
function cardCell(c) {
  if (!c.has_card) return '<span class="cand-empty-cell">–</span>';
  const parts = [];
  if (c.card_date) parts.push(formatDateShort(c.card_date));
  if (c.card_destination) parts.push(escapeHtml(c.card_destination));
  if (parts.length === 0) return '✅';
  return `<span title="${escapeHtml(parts.join(' · '))}">✅ ${parts.join(' · ')}</span>`;
}

function summaryCell(text, max = 80) {
  if (!text) return '<span class="cand-empty-cell">–</span>';
  const t = String(text).trim();
  if (t.length <= max) return escapeHtml(t);
  return `<span title="${escapeHtml(t)}">${escapeHtml(t.slice(0, max))}…</span>`;
}

function renderCandidateRow(c, stage) {
  const created = c.created_at ? formatDateShort(c.created_at) : '–';
  const jobLabel = c.job_title
    ? escapeHtml(c.job_title) + (c.job_company ? ' · ' + escapeHtml(c.job_company) : '')
    : '<span class="cand-empty-cell">–</span>';

  if (stage === 'stage1') {
    return `
      <tr class="cand-row" data-id="${c.id}" draggable="true" title="גררי לשלב אחר">
        <td>${escapeHtml(created)}</td>
        <td class="cand-phone-cell">${waCell(c.phone)}</td>
        <td><strong>${escapeHtml(c.name || '')}</strong></td>
        <td>${c.age != null ? c.age : '<span class="cand-empty-cell">–</span>'}</td>
        <td>${c.current_residence ? escapeHtml(c.current_residence) : '<span class="cand-empty-cell">–</span>'}</td>
        <td>${jobLabel}</td>
        <td>${escapeHtml(passportLabel(c.passport_type))}</td>
        <td>${c.available_from ? escapeHtml(c.available_from) : '<span class="cand-empty-cell">–</span>'}</td>
        <td>${cardCell(c)}</td>
        <td>${summaryCell(c.call_summary)}</td>
        <td class="cand-row-actions">
          <button class="cand-move-btn" data-id="${c.id}" data-stage="stage2" title="העברה לשלב 2">←</button>
        </td>
      </tr>`;
  }
  if (stage === 'stage2') {
    return `
      <tr class="cand-row" data-id="${c.id}" draggable="true" title="גררי לשלב אחר">
        <td>${escapeHtml(created)}</td>
        <td class="cand-phone-cell">${waCell(c.phone)}</td>
        <td><strong>${escapeHtml(c.name || '')}</strong></td>
        <td>${jobLabel}</td>
        <td>${summaryCell(c.call_summary, 120)}</td>
        <td>${summaryCell(c.call_summary_employer, 120)}</td>
        <td class="cand-row-actions">
          <button class="cand-move-btn" data-id="${c.id}" data-stage="stage1" title="חזרה לשלב 1">→</button>
        </td>
      </tr>`;
  }
  // no_response / rejected / delayed (simpler layout)
  return `
    <tr class="cand-row" data-id="${c.id}" draggable="true" title="גררי לשלב אחר">
      <td>${escapeHtml(created)}</td>
      <td class="cand-phone-cell">${waCell(c.phone)}</td>
      <td><strong>${escapeHtml(c.name || '')}</strong></td>
      <td>${jobLabel}</td>
      <td>${summaryCell(c.call_summary)}</td>
      <td class="cand-row-actions">
        <button class="cand-move-btn" data-id="${c.id}" data-stage="stage1" title="החזרה לשלב 1">↺</button>
      </td>
    </tr>`;
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
  const stageOrder = ['stage1', 'stage2', 'no_response', 'accepted', 'rejected', 'delayed'];
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
    const fuDate = new Date(candidate.follow_up_at);
    const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
    const dayName = dayNames[fuDate.getDay()];
    const today = new Date();
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const isToday = fuDate.toDateString() === today.toDateString();
    const isTomorrow = fuDate.toDateString() === tomorrow.toDateString();

    let fuLabel;
    if (followUpStatus === 'overdue') {
      fuLabel = `פולואפ באיחור! (יום ${dayName})`;
    } else if (isToday) {
      fuLabel = `פולואפ היום!`;
    } else if (isTomorrow) {
      fuLabel = `פולואפ מחר`;
    } else {
      fuLabel = `פולואפ ביום ${dayName} ${formatDateShort(candidate.follow_up_at)}`;
    }

    followUpBadgeHtml = `
      <div class="followup-row">
        <div class="follow-up-badge ${followUpStatus}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          ${fuLabel}
        </div>
        <button class="followup-done-btn" data-followup-id="${candidate.id}" title="סמן פולואפ כבוצע + הוסף סיכום">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          סמן כבוצע
        </button>
      </div>
    `;
  }

  const waLink = buildWhatsAppLink(candidate.phone);

  return `
    <div class="candidate-card ${followUpClass}" data-id="${candidate.id}">
      <div class="candidate-card-top">
        <div class="candidate-card-name-row">
          <div class="candidate-card-name">${escapeHtml(candidate.name)}</div>
          ${candidate.phone && waLink ? `
            <a href="${waLink}" target="_blank" rel="noopener" class="whatsapp-btn" data-stop title="WhatsApp" aria-label="WhatsApp">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </a>
          ` : ''}
        </div>
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
      ${candidate.available_from ? `
        <div style="margin-top:8px">
          <span class="delayed-badge">⏳ זמין מ-${candidate.available_from}</span>
        </div>
      ` : ''}
      ${followUpBadgeHtml}
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
    // Format follow-up date + show preview
    document.querySelectorAll('.followup-btn').forEach(b => b.classList.remove('active'));
    if (candidate.follow_up_at) {
      const f = new Date(candidate.follow_up_at);
      if (!isNaN(f)) {
        const pad = n => String(n).padStart(2, '0');
        document.getElementById('candidate-follow-up').value =
          `${f.getFullYear()}-${pad(f.getMonth() + 1)}-${pad(f.getDate())}T${pad(f.getHours())}:${pad(f.getMinutes())}`;
        // Show preview
        const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
        const preview = document.getElementById('followup-preview');
        preview.textContent = `📅 פולואפ ביום ${dayNames[f.getDay()]}, ${f.toLocaleDateString('he-IL')}`;
        preview.classList.add('visible');
        document.getElementById('followup-date-row').style.display = 'none';
      } else {
        document.getElementById('candidate-follow-up').value = '';
        document.getElementById('followup-preview').classList.remove('visible');
      }
    } else {
      document.getElementById('candidate-follow-up').value = '';
      document.getElementById('followup-preview').classList.remove('visible');
      document.getElementById('followup-date-row').style.display = 'none';
    }
    document.getElementById('candidate-summary').value = candidate.call_summary || '';
    document.getElementById('candidate-summary-employer').value = candidate.call_summary_employer || '';
    document.getElementById('candidate-age').value = candidate.age != null ? candidate.age : '';
    document.getElementById('candidate-residence').value = candidate.current_residence || '';
    document.getElementById('candidate-passport-type').value = candidate.passport_type || '';
    document.getElementById('candidate-has-card').checked = !!candidate.has_card;
    document.getElementById('candidate-card-date').value = candidate.card_date || '';
    document.getElementById('candidate-card-destination').value = candidate.card_destination || '';
    toggleCardDetails();
    document.getElementById('candidate-notes').value = candidate.notes || '';
    document.getElementById('candidate-start-date').value = candidate.start_date || '';
    document.getElementById('candidate-payment-date').value = candidate.payment_date || '';
    document.getElementById('candidate-payment-amount').value = candidate.payment_amount != null ? candidate.payment_amount : '';
    document.getElementById('candidate-available-from').value = candidate.available_from || '';
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
    document.getElementById('followup-date-row').style.display = 'none';
    document.getElementById('followup-preview').classList.remove('visible');
    document.querySelectorAll('.followup-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('candidate-start-date').value = '';
    document.getElementById('candidate-payment-date').value = '';
    document.getElementById('candidate-payment-amount').value = '';
    document.getElementById('candidate-payment-plan').value = '';
    document.getElementById('candidate-available-from').value = '';
    document.querySelectorAll('#payment-plan-options .plan-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('payment-schedule-section').style.display = 'none';
    // Reset the card-details row to closed state for a fresh candidate
    document.getElementById('candidate-card-date').value = '';
    document.getElementById('candidate-card-destination').value = '';
    toggleCardDetails();
    deleteBtn.style.display = 'none';
  }

  // Update WhatsApp button visibility based on phone
  updatePhoneWaBtn();

  // Show/hide payment fields based on stage
  togglePaymentFields();

  openModal('candidate-modal');
}

// Show or hide the card-detail row (date + destination) based on
// whether the "יש למועמד כרטיס" checkbox is ticked.
function toggleCardDetails() {
  const checked = document.getElementById('candidate-has-card').checked;
  const row = document.getElementById('card-details-row');
  if (row) row.style.display = checked ? 'block' : 'none';
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
    call_summary_employer: document.getElementById('candidate-summary-employer').value.trim() || null,
    age: document.getElementById('candidate-age').value || null,
    current_residence: document.getElementById('candidate-residence').value.trim() || null,
    passport_type: document.getElementById('candidate-passport-type').value || null,
    has_card: document.getElementById('candidate-has-card').checked,
    card_date: document.getElementById('candidate-has-card').checked
      ? (document.getElementById('candidate-card-date').value || null)
      : null,
    card_destination: document.getElementById('candidate-has-card').checked
      ? (document.getElementById('candidate-card-destination').value.trim() || null)
      : null,
    notes: document.getElementById('candidate-notes').value.trim(),
    start_date: document.getElementById('candidate-start-date').value || null,
    payment_date: document.getElementById('candidate-payment-date').value || null,
    payment_amount: document.getElementById('candidate-payment-amount').value || null,
    payment_plan: document.getElementById('candidate-payment-plan').value || null,
    available_from: document.getElementById('candidate-available-from').value || null
  };

  if (!data.name) {
    showToast(I18n.t('required'), 'error');
    return;
  }

  try {
    if (id) {
      await API.candidates.update(id, data);
    } else {
      const result = await API.candidates.create(data);
    }
    showToast(I18n.t('saved'));
    closeModal('candidate-modal');
    loadCandidates();
  } catch (err) {
    // Handle duplicate phone
    if (err.message && err.message.includes('duplicate_phone')) {
      try {
        const errData = JSON.parse(err.message.replace('duplicate_phone: ', ''));
        showDuplicateAlert(errData);
      } catch(e) {
        showToast('הליד כבר קיים במערכת!', 'error');
      }
      return;
    }
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

// Follow-up quick buttons
document.querySelectorAll('.followup-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = parseInt(btn.dataset.days);
    const input = document.getElementById('candidate-follow-up');
    const dateRow = document.getElementById('followup-date-row');
    const preview = document.getElementById('followup-preview');

    // Toggle active
    document.querySelectorAll('.followup-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (days === 0) {
      // Manual - show date input
      dateRow.style.display = 'flex';
      input.focus();
      preview.classList.remove('visible');
    } else {
      // Auto-calculate
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(10, 0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      input.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      dateRow.style.display = 'none';

      const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
      preview.textContent = `📅 פולואפ ביום ${dayNames[d.getDay()]}, ${d.toLocaleDateString('he-IL')}`;
      preview.classList.add('visible');
    }
  });
});

// Clear follow-up
document.getElementById('followup-clear').addEventListener('click', () => {
  document.getElementById('candidate-follow-up').value = '';
  document.getElementById('followup-date-row').style.display = 'none';
  document.getElementById('followup-preview').classList.remove('visible');
  document.querySelectorAll('.followup-btn').forEach(b => b.classList.remove('active'));
});

// Update preview when manual date changes
document.getElementById('candidate-follow-up').addEventListener('change', () => {
  const val = document.getElementById('candidate-follow-up').value;
  const preview = document.getElementById('followup-preview');
  if (val) {
    const d = new Date(val);
    const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
    preview.textContent = `📅 פולואפ ביום ${dayNames[d.getDay()]}, ${d.toLocaleDateString('he-IL')}`;
    preview.classList.add('visible');
  } else {
    preview.classList.remove('visible');
  }
});

// WhatsApp button in modal - update href as user types phone number
// Show/hide payment fields when stage changes
document.getElementById('candidate-stage').addEventListener('change', togglePaymentFields);
document.getElementById('candidate-has-card').addEventListener('change', toggleCardDetails);

// ===== Import-from-Excel wiring =====
document.getElementById('btn-import-excel').addEventListener('click', openImportModal);
document.getElementById('import-file-input').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleImportFile(file);
});
document.getElementById('import-back-btn').addEventListener('click', () => {
  document.getElementById('import-step-preview').style.display = 'none';
  document.getElementById('import-step-pick').style.display = '';
  document.getElementById('import-back-btn').style.display = 'none';
  document.getElementById('import-confirm-btn').style.display = 'none';
  document.getElementById('import-file-input').value = '';
  pendingImportRows = null;
});
document.getElementById('import-confirm-btn').addEventListener('click', confirmImport);

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
function renderAcceptedTable(accepted) {
  const section = document.getElementById('accepted-section');
  const container = document.getElementById('accepted-table');
  const subtitle = document.getElementById('accepted-subtitle');
  if (!section || !container) return;

  if (!accepted || accepted.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  subtitle.textContent = accepted.length + ' מועמדים';

  const planLabels = { '45days': '45 יום', '2weeks': 'שבועיים', '5050': '50/50', 'custom': 'ידני' };
  const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  const fmt = d => d ? new Date(d).toLocaleDateString('he-IL', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Jerusalem' }) : '—';

  // Group by payment month (the month when payment is expected)
  const byMonth = {};
  const noDate = [];
  accepted.forEach(c => {
    if (c.payment_date) {
      const d = new Date(c.payment_date);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!byMonth[key]) byMonth[key] = { year: d.getFullYear(), month: d.getMonth(), candidates: [], total: 0 };
      byMonth[key].candidates.push(c);
      byMonth[key].total += Number(c.payment_amount || 0);
    } else {
      noDate.push(c);
    }
  });

  const sortedKeys = Object.keys(byMonth).sort();
  const now = new Date();
  const curKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  let html = '';

  const waIcon = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>';

  // Calculate payment reminder status
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const getPaymentStatus = (payDate) => {
    if (!payDate) return null;
    const d = new Date(payDate);
    d.setHours(0, 0, 0, 0);
    if (d < today) return 'overdue';
    if (d.getTime() === today.getTime()) return 'today';
    if (d.getTime() === tomorrow.getTime()) return 'tomorrow';
    return null;
  };

  for (const key of sortedKeys) {
    const g = byMonth[key];
    const isCurrent = key === curKey;
    const isPast = key < curKey;
    const label = monthNames[g.month] + ' ' + g.year;

    html += `
      <div class="accepted-month-group">
        <div class="accepted-month-header ${isCurrent ? 'current' : isPast ? 'past' : 'future'}">
          <div class="accepted-month-title">
            <span class="accepted-month-icon">${isCurrent ? '🔥' : isPast ? '✅' : '📅'}</span>
            <div>
              <div class="accepted-month-label">${label}</div>
              <div class="accepted-month-count">${g.candidates.length} מועמדים</div>
            </div>
          </div>
          <div class="accepted-month-summary">
            <span class="accepted-month-summary-num">$${g.total.toLocaleString()}</span>
          </div>
        </div>
        <table class="accepted-table-inner">
          <thead>
            <tr>
              <th>שם</th>
              <th>משרה</th>
              <th>תאריך הגעה</th>
              <th>תאריך תשלום</th>
              <th>סכום</th>
              <th>WhatsApp</th>
            </tr>
          </thead>
          <tbody>
            ${g.candidates.map(c => {
              const wa = buildWhatsAppLink(c.phone);
              const payStatus = getPaymentStatus(c.payment_date);
              const payBadge = payStatus === 'today' ? '<span class="pay-reminder today">⚡ היום!</span>' :
                               payStatus === 'tomorrow' ? '<span class="pay-reminder tomorrow">🔔 מחר</span>' :
                               payStatus === 'overdue' ? '<span class="pay-reminder overdue">⚠️ באיחור</span>' : '';
              return `
                <tr data-id="${c.id}">
                  <td><span class="accepted-name">${escapeHtml(c.name)}</span></td>
                  <td><span class="accepted-job">${escapeHtml(c.job_title || '—')}</span></td>
                  <td>${fmt(c.start_date)}</td>
                  <td>${fmt(c.payment_date)} ${payBadge}</td>
                  <td>${c.payment_amount ? '<span class="accepted-amount">$' + Number(c.payment_amount).toLocaleString() + '</span>' : '—'}</td>
                  <td>${wa ? '<a href="' + wa + '" target="_blank" data-stop class="whatsapp-btn" title="WhatsApp">' + waIcon + '</a>' : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // No payment date group
  if (noDate.length > 0) {
    html += `
      <div class="accepted-month-group">
        <div class="accepted-month-header no-date">
          <div class="accepted-month-title">
            <span class="accepted-month-icon">❓</span>
            <div>
              <div class="accepted-month-label">ללא תאריך תשלום</div>
              <div class="accepted-month-count">${noDate.length} מועמדים</div>
            </div>
          </div>
        </div>
        <table class="accepted-table-inner">
          <thead>
            <tr>
              <th>שם</th>
              <th>משרה</th>
              <th>תאריך הגעה</th>
              <th>סכום</th>
              <th>WhatsApp</th>
            </tr>
          </thead>
          <tbody>
            ${noDate.map(c => {
              const wa = buildWhatsAppLink(c.phone);
              return `
                <tr data-id="${c.id}">
                  <td><span class="accepted-name">${escapeHtml(c.name)}</span></td>
                  <td><span class="accepted-job">${escapeHtml(c.job_title || '—')}</span></td>
                  <td>${fmt(c.start_date)}</td>
                  <td>${c.payment_amount ? '<span class="accepted-amount">$' + Number(c.payment_amount).toLocaleString() + '</span>' : '—'}</td>
                  <td>${wa ? '<a href="' + wa + '" target="_blank" data-stop class="whatsapp-btn" title="WhatsApp">' + waIcon + '</a>' : '—'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  container.outerHTML = '<div id="accepted-table">' + html + '</div>';

  // Re-attach click handlers
  document.querySelectorAll('#accepted-table tbody tr').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.id);
      const c = allCandidates.find(x => x.id === id);
      if (c) openCandidateModal(c);
    });
  });
}

// Export button (moved into the accepted-section header)
document.addEventListener('DOMContentLoaded', () => {
  const exportBtn = document.getElementById('btn-accepted-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const token = API.getToken();
      window.open('/api/candidates/export/accepted?token=' + token, '_blank');
    });
  }
});

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

// ============================================================
// Tabs: Active / Delayed
// ============================================================
document.querySelectorAll('.page-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.page-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    document.getElementById('tab-content-active').style.display = tabName === 'active' ? '' : 'none';
    document.getElementById('tab-content-delayed').style.display = tabName === 'delayed' ? '' : 'none';
    if (tabName === 'delayed') loadDelayedAvailability();
  });
});

document.getElementById('btn-new-delayed').addEventListener('click', () => {
  openCandidateModal();
  setTimeout(() => {
    document.getElementById('candidate-stage').value = 'delayed';
    togglePaymentFields();
  }, 100);
});

// Delete candidate from delayed availability list (called from inline onclick)
async function deleteDelayedCandidate(id) {
  if (!confirm('האם למחוק את המועמד?')) return;
  try {
    await API.candidates.delete(id);
    showToast(I18n.t('deleted'));
    loadDelayedAvailability();
    // Also refresh main candidates list count
    try {
      const d = await API.candidates.list({ stage: 'delayed' });
      const el = document.getElementById('tab-delayed-count');
      if (el) {
        el.textContent = d.length;
        el.style.display = d.length > 0 ? '' : 'none';
      }
    } catch(e) {}
  } catch (err) {
    console.error('Delete delayed candidate error:', err);
    showToast(I18n.t('error'), 'error');
  }
}
// Expose globally for inline onclick handlers
window.deleteDelayedCandidate = deleteDelayedCandidate;
window.openCandidateModal = openCandidateModal;

async function loadDelayedAvailability() {
  try {
    const candidates = await API.candidates.list({ stage: 'delayed' });
    // Cache delayed candidates globally so inline onclick handlers can find them
    window.__delayedCandidates = candidates;
    const withDate = candidates.filter(c => c.available_from);
    const withoutDate = candidates.filter(c => !c.available_from);

    const countEl = document.getElementById('tab-delayed-count');
    if (countEl) {
      countEl.textContent = candidates.length;
      countEl.style.display = candidates.length > 0 ? '' : 'none';
    }

    const container = document.getElementById('delayed-availability-container');
    if (candidates.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--color-text-light)"><div style="font-size:48px;margin-bottom:12px">⏳</div><div style="font-size:16px;font-weight:700;color:var(--color-text)">אין מועמדים עם זמינות מאוחרת</div></div>';
      return;
    }

    const monthNames = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const byMonth = {};
    withDate.forEach(c => { const k = c.available_from; if (!byMonth[k]) byMonth[k] = []; byMonth[k].push(c); });

    const now = new Date();
    const curKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

    let html = Object.keys(byMonth).sort().map(key => {
      const [yr, mo] = key.split('-');
      const mName = monthNames[parseInt(mo)-1];
      const isPast = key < curKey, isCur = key === curKey;
      const bg = '#1a1d2e,#2d3142';
      const icon = isCur ? '🔥' : isPast ? '⏰' : '📅';
      const items = byMonth[key];
      return `<div class="panel" style="margin-bottom:20px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;background:linear-gradient(135deg,${bg});color:white;font-weight:700;font-size:16px">
          <span style="font-size:20px">${icon}</span>${mName} ${yr}
          <span style="background:rgba(255,255,255,0.25);padding:3px 12px;border-radius:20px;font-size:12px;margin-right:auto">${items.length}</span>
        </div>
        <div style="padding:0">${items.map(c => {
          const wa = buildWhatsAppLink(c.phone);
          return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--color-border);cursor:pointer" data-action="open-delayed-candidate" data-candidate-id="${c.id}">
            <div><strong>${escapeHtml(c.name)}</strong><div style="font-size:12px;color:var(--color-text-secondary)">${escapeHtml(c.job_title||'—')}</div></div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:12px;color:var(--color-text-light)">${escapeHtml(c.call_summary||'').substring(0,40)}</span>
              ${wa ? '<a href="'+wa+'" target="_blank" data-stop class="whatsapp-btn"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>' : ''}
              <button class="delayed-delete-btn" data-action="delete-delayed-candidate" data-candidate-id="${c.id}" title="מחק">🗑</button>
            </div>
          </div>`;
        }).join('')}</div>
      </div>`;
    }).join('');

    if (withoutDate.length > 0) {
      html += `<div class="panel" style="margin-bottom:20px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:12px;padding:14px 20px;background:linear-gradient(135deg,#1a1d2e,#2d3142);color:white;font-weight:700;font-size:16px">
          <span style="font-size:20px">❓</span>ללא תאריך זמינות
          <span style="background:rgba(255,255,255,0.25);padding:3px 12px;border-radius:20px;font-size:12px;margin-right:auto">${withoutDate.length}</span>
        </div>
        <div style="padding:0">${withoutDate.map(c => `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--color-border)"><strong>${escapeHtml(c.name)}</strong><span style="font-size:12px;color:var(--color-text-secondary)">${escapeHtml(c.job_title||'—')}</span></div>`).join('')}</div>
      </div>`;
    }
    container.innerHTML = html;
  } catch(err) { console.error('Delayed load failed:', err); }
}

// Load delayed count on page init
(async function loadDelayedCount() {
  try {
    const d = await API.candidates.list({ stage: 'delayed' });
    const el = document.getElementById('tab-delayed-count');
    if (el && d.length > 0) { el.textContent = d.length; el.style.display = ''; }
  } catch(e) {}
})();

// ============================================================
// Follow-up Completion Modal
// ============================================================
let currentFollowUpCandidate = null;

function openFollowUpCompleteModal(candidate) {
  currentFollowUpCandidate = candidate;

  // Populate candidate info
  const info = document.getElementById('fuc-candidate-info');
  const dueDate = candidate.follow_up_at ? new Date(candidate.follow_up_at) : null;
  const dueStr = dueDate ? dueDate.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' }) : '';
  info.innerHTML = `
    <div style="font-weight:700;font-size:15px;color:var(--color-text)">${escapeHtml(candidate.name)}</div>
    ${candidate.job_title ? `<div style="color:var(--color-text-secondary);margin-top:2px">💼 ${escapeHtml(candidate.job_title)}${candidate.job_company ? ' · ' + escapeHtml(candidate.job_company) : ''}</div>` : ''}
    ${dueStr ? `<div style="color:var(--color-text-light);margin-top:4px;font-size:12px">⏰ פולואפ נקבע ל: ${dueStr}</div>` : ''}
  `;

  // Reset form
  document.getElementById('fuc-summary').value = '';
  document.getElementById('fuc-next-date').value = '';
  document.getElementById('fuc-next-date-row').style.display = 'none';
  document.getElementById('fuc-next-preview').style.display = 'none';
  document.querySelectorAll('#fuc-next-options .fuc-next-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#fuc-next-options .fuc-next-btn[data-days="-1"]').classList.add('active');

  // Reset outcome to default "spoke"
  document.querySelectorAll('#fuc-outcome-options .fuc-outcome-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('#fuc-outcome-options .fuc-outcome-btn[data-outcome="spoke"]').classList.add('active');

  // Render history
  const histSection = document.getElementById('fuc-history-section');
  const histList = document.getElementById('fuc-history-list');
  const history = Array.isArray(candidate.follow_up_history) ? candidate.follow_up_history : [];
  if (history.length > 0) {
    histSection.style.display = 'block';
    histList.innerHTML = history.slice().reverse().map(h => {
      const d = new Date(h.completed_at);
      const dStr = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
      return `
        <div class="fuc-history-item">
          <div class="fuc-history-date">📅 ${dStr}</div>
          <div class="fuc-history-summary">${escapeHtml(h.summary || '')}</div>
        </div>
      `;
    }).join('');
  } else {
    histSection.style.display = 'none';
  }

  openModal('followup-complete-modal');
  setTimeout(() => document.getElementById('fuc-summary').focus(), 100);
}

// Outcome button clicks (spoke / no_answer / left_message)
document.querySelectorAll('#fuc-outcome-options .fuc-outcome-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const outcome = btn.dataset.outcome;
    document.querySelectorAll('#fuc-outcome-options .fuc-outcome-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const summaryInput = document.getElementById('fuc-summary');

    // Smart defaults based on outcome
    if (outcome === 'no_answer') {
      // Pre-fill summary if empty
      if (!summaryInput.value.trim()) {
        summaryInput.value = '📵 לא ענה - ניסיתי להתקשר';
      }
      // Auto-select "tomorrow" as default next follow-up (user usually wants to retry soon)
      const tomorrowBtn = document.querySelector('#fuc-next-options .fuc-next-btn[data-days="1"]');
      if (tomorrowBtn && !document.querySelector('#fuc-next-options .fuc-next-btn.active[data-days="1"]')) {
        tomorrowBtn.click();
      }
    } else if (outcome === 'left_message') {
      if (!summaryInput.value.trim()) {
        summaryInput.value = '💬 השארתי הודעה - ממתין לחזרה';
      }
      // Auto-select "3 days" as default next follow-up
      const threeDaysBtn = document.querySelector('#fuc-next-options .fuc-next-btn[data-days="3"]');
      if (threeDaysBtn && !document.querySelector('#fuc-next-options .fuc-next-btn.active[data-days="3"]')) {
        threeDaysBtn.click();
      }
    }
    // For 'spoke' - don't auto-fill anything, let user type
  });
});

// Next-step button clicks
document.querySelectorAll('#fuc-next-options .fuc-next-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const days = parseInt(btn.dataset.days);
    const dateRow = document.getElementById('fuc-next-date-row');
    const preview = document.getElementById('fuc-next-preview');
    const dateInput = document.getElementById('fuc-next-date');

    document.querySelectorAll('#fuc-next-options .fuc-next-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (days === -1) {
      // No new follow-up
      dateRow.style.display = 'none';
      preview.style.display = 'none';
      dateInput.value = '';
    } else if (days === 0) {
      // Manual date
      dateRow.style.display = 'block';
      preview.style.display = 'none';
      dateInput.focus();
    } else {
      // Quick preset
      const d = new Date();
      d.setDate(d.getDate() + days);
      d.setHours(10, 0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      dateInput.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      dateRow.style.display = 'none';
      const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
      preview.textContent = `📅 פולואפ הבא ביום ${dayNames[d.getDay()]}, ${d.toLocaleDateString('he-IL')}`;
      preview.style.display = 'block';
    }
  });
});

// Update preview when manual date changes
document.getElementById('fuc-next-date').addEventListener('change', () => {
  const val = document.getElementById('fuc-next-date').value;
  const preview = document.getElementById('fuc-next-preview');
  if (val) {
    const d = new Date(val);
    const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
    preview.textContent = `📅 פולואפ הבא ביום ${dayNames[d.getDay()]}, ${d.toLocaleDateString('he-IL')}`;
    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
});

// Save button
document.getElementById('fuc-save-btn').addEventListener('click', async () => {
  if (!currentFollowUpCandidate) return;
  const summary = document.getElementById('fuc-summary').value.trim();
  const activeNextBtn = document.querySelector('#fuc-next-options .fuc-next-btn.active');
  const days = activeNextBtn ? parseInt(activeNextBtn.dataset.days) : -1;
  const nextDate = days === -1 ? null : document.getElementById('fuc-next-date').value || null;

  // Get selected outcome
  const activeOutcomeBtn = document.querySelector('#fuc-outcome-options .fuc-outcome-btn.active');
  const outcome = activeOutcomeBtn ? activeOutcomeBtn.dataset.outcome : 'spoke';
  const outcomeEmoji = { spoke: '✓', no_answer: '📵', left_message: '💬' }[outcome] || '';
  const outcomeLabel = { spoke: 'דיברנו', no_answer: 'לא ענה', left_message: 'השארתי הודעה' }[outcome] || '';

  // Build full summary: outcome tag + summary text
  let fullSummary = `${outcomeEmoji} ${outcomeLabel}`;
  if (summary && !summary.startsWith(outcomeEmoji)) {
    fullSummary += `\n${summary}`;
  } else if (summary) {
    fullSummary = summary;
  }

  // For "no answer" without summary text, don't force confirm - it's a valid entry on its own
  if (outcome === 'spoke' && !summary) {
    if (!confirm('לא הוספת סיכום לשיחה. להמשיך בכל זאת?')) return;
  }

  try {
    await API.candidates.completeFollowUp(currentFollowUpCandidate.id, {
      summary: fullSummary,
      next_follow_up_at: nextDate
    });
    const msg = outcome === 'no_answer' ? '📵 תועד - לא ענה'
              : outcome === 'left_message' ? '💬 תועד - הודעה נשארה'
              : '✓ פולואפ נסגר';
    showToast(nextDate ? `${msg} - נקבע פולואפ חדש` : msg);
    closeModal('followup-complete-modal');
    currentFollowUpCandidate = null;
    loadCandidates();
  } catch (err) {
    console.error('Complete follow-up error:', err);
    showToast(I18n.t('error'), 'error');
  }
});

// Expose for inline onclick
window.openFollowUpCompleteModal = openFollowUpCompleteModal;

// CSP-safe action handlers (replace former inline onclick attributes on
// dynamically-rendered candidate rows / delete buttons in the delayed list).
window.__uiActions = window.__uiActions || {};
window.__uiActions['open-delayed-candidate'] = (el) => {
  const id = Number(el.getAttribute('data-candidate-id'));
  const list = window.__delayedCandidates || [];
  const c = list.find(x => x.id === id);
  if (c && typeof openCandidateModal === 'function') openCandidateModal(c);
};
window.__uiActions['delete-delayed-candidate'] = (el) => {
  const id = Number(el.getAttribute('data-candidate-id'));
  if (typeof deleteDelayedCandidate === 'function') deleteDelayedCandidate(id);
};

// ---------- Initial load ----------
(async function init() {
  await loadJobs();
  await loadCandidates();
})();
