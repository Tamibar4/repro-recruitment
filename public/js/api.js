/**
 * API Client
 * Handles all HTTP requests to the backend
 */

const API = {
  baseUrl: '/api',

  getToken() {
    return localStorage.getItem('auth_token');
  },

  getCurrentUser() {
    const raw = localStorage.getItem('auth_user');
    return raw ? JSON.parse(raw) : null;
  },

  logout() {
    const token = this.getToken();
    if (token) {
      fetch(this.baseUrl + '/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(() => {});
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.location.href = '/login.html';
  },

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    const token = this.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(this.baseUrl + path, { ...options, headers });

    if (res.status === 401) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('auth_user');
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    if (res.status === 409) {
      const err = await res.json().catch(() => ({ error: 'Conflict' }));
      if (err.error === 'duplicate_phone' && err.existing) {
        showDuplicateAlert(err.existing);
        throw new Error('duplicate');
      }
      throw new Error(err.error || 'Conflict');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || 'Request failed');
    }
    if (res.status === 204) return null;
    return res.json();
  },

  // ---------- Jobs ----------
  jobs: {
    list(filters = {}) {
      const params = new URLSearchParams(filters).toString();
      return API.request('/jobs' + (params ? '?' + params : ''));
    },
    get(id) {
      return API.request('/jobs/' + id);
    },
    create(data) {
      return API.request('/jobs', { method: 'POST', body: JSON.stringify(data) });
    },
    update(id, data) {
      return API.request('/jobs/' + id, { method: 'PUT', body: JSON.stringify(data) });
    },
    delete(id) {
      return API.request('/jobs/' + id, { method: 'DELETE' });
    }
  },

  // ---------- Candidates ----------
  candidates: {
    list(filters = {}) {
      const params = new URLSearchParams(filters).toString();
      return API.request('/candidates' + (params ? '?' + params : ''));
    },
    get(id) {
      return API.request('/candidates/' + id);
    },
    create(data) {
      return API.request('/candidates', { method: 'POST', body: JSON.stringify(data) });
    },
    update(id, data) {
      return API.request('/candidates/' + id, { method: 'PUT', body: JSON.stringify(data) });
    },
    updateStage(id, stage) {
      return API.request('/candidates/' + id + '/stage', {
        method: 'PATCH',
        body: JSON.stringify({ stage })
      });
    },
    delete(id) {
      return API.request('/candidates/' + id, { method: 'DELETE' });
    }
  },

  // ---------- Stats ----------
  stats() {
    return API.request('/stats');
  }
};

// ============================================================
// Toast notifications (with accessibility)
// ============================================================
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ============================================================
// Utility helpers
// ============================================================
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date)) return '';
  const lang = I18n.current;
  return date.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatDateShort(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date)) return '';
  const lang = I18n.current;
  return date.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-US', {
    month: 'short',
    day: 'numeric'
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return I18n.t('just_now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' ' + I18n.t('minutes_ago');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' ' + I18n.t('hours_ago');
  const days = Math.floor(hours / 24);
  return days + ' ' + I18n.t('days_ago');
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build a WhatsApp deep link from a phone number.
// Removes all non-digit characters. If number doesn't start with a country code,
// assumes US (1) for phones starting with 10 digits, or Israel (972) otherwise.
function buildWhatsAppLink(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  // If it starts with 0, assume Israeli local format and replace with 972
  if (digits.startsWith('0')) {
    digits = '972' + digits.substring(1);
  }
  // If it has exactly 10 digits and doesn't start with a country code, assume US
  else if (digits.length === 10) {
    digits = '1' + digits;
  }
  return 'https://wa.me/' + digits;
}

function getCategoryTag(category) {
  if (!category) return '';
  const color = getCategoryColor(category);
  return `<span class="tag" style="background:${color}">${getCategoryLabel(category)}</span>`;
}

function getStatusPill(status) {
  return `<span class="status-pill status-${status}">${getStatusLabel(status)}</span>`;
}

// ============================================================
// Modal helpers (with accessibility)
// ============================================================
let lastFocusedElement = null;

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  lastFocusedElement = document.activeElement;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  // Focus first focusable element inside modal
  setTimeout(() => {
    const focusable = modal.querySelector('input, select, textarea, button');
    if (focusable) focusable.focus();
  }, 50);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  // Return focus to the element that opened the modal
  if (lastFocusedElement) {
    lastFocusedElement.focus();
    lastFocusedElement = null;
  }
}

// Close modal on overlay click
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
    if (lastFocusedElement) {
      lastFocusedElement.focus();
      lastFocusedElement = null;
    }
  }
});

// Close modal on escape + focus trap
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      m.classList.remove('active');
      if (lastFocusedElement) {
        lastFocusedElement.focus();
        lastFocusedElement = null;
      }
    });
  }

  // Focus trap inside open modal
  if (e.key === 'Tab') {
    const activeModal = document.querySelector('.modal-overlay.active .modal');
    if (!activeModal) return;
    const focusable = activeModal.querySelectorAll(
      'input:not([type="hidden"]), select, textarea, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

// ============================================================
// Language switch setup
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const langBtn = document.getElementById('lang-switch');
  if (langBtn) {
    langBtn.addEventListener('click', () => I18n.toggle());
  }

  // Render current user in sidebar (if logged in)
  renderUserBadge();

  // Show admin nav link only for admins
  const user = API.getCurrentUser();
  if (user && user.role === 'admin') {
    document.querySelectorAll('.admin-only-nav').forEach(el => {
      el.style.display = '';
    });
  }
});

// ============================================================
// Login enforcement + user badge
// ============================================================
// Duplicate candidate alert
function showDuplicateAlert(existing) {
  const stageLabels = { stage1: 'שלב ראשון', stage2: 'שלב שני', accepted: 'התקבלו', rejected: 'נדחו' };
  const stageName = stageLabels[existing.stage] || existing.stage;

  // Remove any existing alert
  document.querySelectorAll('.duplicate-alert-overlay').forEach(el => el.remove());

  const overlay = document.createElement('div');
  overlay.className = 'duplicate-alert-overlay';
  overlay.innerHTML = `
    <div class="duplicate-alert">
      <div class="duplicate-alert-icon">⚠️</div>
      <div class="duplicate-alert-title">ליד כפול!</div>
      <div class="duplicate-alert-body">
        <p>מועמד עם אותו מספר טלפון כבר קיים במערכת:</p>
        <div class="duplicate-alert-details">
          <div class="dup-row"><span>👤 שם:</span><strong>${escapeHtml(existing.name)}</strong></div>
          <div class="dup-row"><span>📞 טלפון:</span><strong dir="ltr">${escapeHtml(existing.phone)}</strong></div>
          <div class="dup-row"><span>📋 שלב:</span><strong>${stageName}</strong></div>
          ${existing.job_title ? `<div class="dup-row"><span>💼 משרה:</span><strong>${escapeHtml(existing.job_title)}</strong></div>` : ''}
          <div class="dup-row"><span>👥 בטיפול של:</span><strong>${escapeHtml(existing.created_by || 'לא ידוע')}</strong></div>
        </div>
      </div>
      <button class="duplicate-alert-close" onclick="this.closest('.duplicate-alert-overlay').remove()">הבנתי</button>
    </div>
  `;
  document.body.appendChild(overlay);
}

function checkAuth() {
  // Skip on login page
  if (window.location.pathname.endsWith('/login.html')) return;
  const token = API.getToken();
  if (!token) {
    window.location.href = '/login.html';
    return false;
  }
  return true;
}

function renderMobileUserMenu() {
  const user = API.getCurrentUser();
  if (!user) return;
  // Only add if not already present
  if (document.getElementById('mobile-user-menu')) return;
  const initial = (user.display_name || user.username || '?').charAt(0).toUpperCase();
  const menu = document.createElement('div');
  menu.id = 'mobile-user-menu';
  menu.className = 'mobile-user-menu';
  menu.innerHTML = `
    <button class="mobile-user-btn" id="mobile-user-btn">${escapeHtml(initial)}</button>
    <div class="mobile-user-dropdown" id="mobile-user-dropdown">
      <a href="profile.html" class="mobile-user-dropdown-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
        ${escapeHtml(user.display_name || user.username)}
      </a>
      <div class="mobile-user-dropdown-divider"></div>
      <button class="mobile-user-dropdown-item danger" id="mobile-logout-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        התנתקות
      </button>
    </div>
  `;
  document.body.appendChild(menu);

  document.getElementById('mobile-user-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('mobile-user-dropdown').classList.toggle('show');
  });
  document.getElementById('mobile-logout-btn').addEventListener('click', () => API.logout());
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('mobile-user-dropdown');
    if (dd && !e.target.closest('#mobile-user-menu')) dd.classList.remove('show');
  });
}

function renderUserBadge() {
  const user = API.getCurrentUser();
  if (!user) return;

  // Always render mobile menu (visible only on mobile via CSS)
  renderMobileUserMenu();

  const container = document.getElementById('user-badge-container');
  if (!container) return;
  const initial = (user.display_name || user.username || '?').charAt(0).toUpperCase();
  container.innerHTML = `
    <div class="user-badge">
      <a href="profile.html" class="user-badge-avatar" title="הגדרות פרופיל">${escapeHtml(initial)}</a>
      <a href="profile.html" class="user-badge-info" style="text-decoration:none;color:inherit">
        <div class="user-badge-name">${escapeHtml(user.display_name || user.username)}</div>
        <div class="user-badge-role">${user.role === 'admin' ? '👑 מנהלת' : '👤 משתמש/ת'}</div>
      </a>
      <button class="user-badge-logout" id="btn-logout" title="${I18n.t('logout')}" aria-label="${I18n.t('logout')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    </div>
  `;
  document.getElementById('btn-logout').addEventListener('click', () => API.logout());
}

// Run auth check immediately on script load (before any other code)
checkAuth();
