/**
 * i18n - Internationalization
 * Hebrew + English translations
 */

const translations = {
  he: {
    // Navigation
    app_name: "RePro",
    app_tagline: "Your Job Abroad",
    dashboard: "דשבורד",
    jobs: "משרות",
    candidates: "מועמדים",
    settings: "הגדרות",

    // Dashboard
    welcome: "ברוכה הבאה",
    dashboard_subtitle: "סקירה כללית של הפעילות שלך",
    open_jobs: "משרות פתוחות",
    total_candidates: "סה״כ מועמדים",
    in_stage1: "בשלב ראשון",
    in_stage2: "בשלב שני",
    accepted_month: "התקבלו החודש",
    by_category: "מועמדים לפי קטגוריה",
    recent_activity: "פעילות אחרונה",
    no_activity: "אין פעילות להצגה",
    quick_add: "הוספה מהירה",
    add_job: "משרה חדשה",
    add_candidate: "מועמד חדש",

    // Jobs page
    jobs_title: "משרות",
    jobs_subtitle: "ניהול כל המשרות שלך",
    search_jobs: "חיפוש משרה...",
    all_categories: "כל הקטגוריות",
    all_statuses: "כל הסטטוסים",
    new_job: "משרה חדשה",
    edit_job: "עריכת משרה",
    no_jobs: "אין משרות עדיין",
    no_jobs_desc: "לחצי על 'משרה חדשה' כדי להתחיל",

    // Candidates page
    candidates_title: "מועמדים",
    candidates_subtitle: "ניהול פייפליין המועמדים",
    search_candidates: "חיפוש מועמד...",
    all_jobs: "כל המשרות",
    new_candidate: "מועמד חדש",
    edit_candidate: "עריכת מועמד",
    stage1: "שלב ראשון - שיחה איתי",
    stage2: "שלב שני - אצל המעסיק",
    no_response: "אין מענה",
    accepted: "התקבלו",
    rejected: "נדחו",
    no_candidates_stage1: "אין מועמדים בשלב זה",
    no_candidates_stage2: "אין מועמדים בשלב זה",
    no_candidates_no_response: "אין מועמדים שלא ענו",
    no_candidates_accepted: "אין מועמדים בשלב זה",

    // Form fields
    name: "שם",
    phone: "טלפון",
    email: "אימייל",
    title: "כותרת",
    company: "חברה",
    location: "מיקום",
    category: "קטגוריה",
    status: "סטטוס",
    salary: "טווח שכר",
    description: "תיאור",
    notes: "הערות",
    job: "משרה",
    stage: "שלב",
    call_date: "תאריך שיחה",
    call_summary: "סיכום שיחה",
    source: "מקור",
    select_job: "בחרי משרה",
    select_category: "בחרי קטגוריה",

    // Categories
    chimney: "ארובות (Chimney)",
    air_duct: "ניקוי אוורור (Air Duct)",
    garage_door: "דלתות חניה (Garage Door)",
    construction: "בנייה (Construction)",
    cosmetics: "קוסמטיקה ומוצרי שיער",

    // Status
    status_open: "פתוחה",
    status_filled: "אוישה",
    status_paused: "בהמתנה",
    status_closed: "סגורה",

    // Actions
    save: "שמירה",
    cancel: "ביטול",
    delete: "מחיקה",
    edit: "עריכה",
    confirm_delete: "האם את בטוחה שברצונך למחוק?",
    close: "סגירה",
    next_stage: "השלב הבא",
    prev_stage: "שלב קודם",

    // Messages
    saved: "נשמר בהצלחה",
    deleted: "נמחק בהצלחה",
    error: "אירעה שגיאה",
    loading: "טוען...",
    required: "שדה חובה",

    // Activity
    moved_to: "הועבר ל",
    created: "נוצר",
    just_now: "עכשיו",
    minutes_ago: "לפני דקות",
    hours_ago: "לפני שעות",
    days_ago: "לפני ימים",

    // Stats labels
    active_candidates: "מועמדים פעילים",
    open_positions: "משרות פתוחות",
    first_stage: "שלב ראשון",
    second_stage: "שלב שני",
    hired: "התקבלו",

    // Job details
    job_details: "פרטים על המשרה",
    locations_list: "מיקומים",
    location_name: "שם המיקום",
    pressure: "רמת לחץ",
    pressure_high: "גבוה",
    pressure_medium: "בינוני",
    pressure_low: "נמוך",
    candidates_needed: "מועמדים נדרשים",
    candidates_needed_short: "נדרשים",
    add_location: "הוסף מיקום",
    no_locations: "לא הוגדרו מיקומים",
    view_candidates: "צפי במועמדים",
    view_details: "פרטי משרה",
    placeholder_location: "לדוגמה: Philadelphia",
    placeholder_needed: "לדוגמה: 2-3",

    // Urgent / Priority
    urgent: "דחוף",
    mark_urgent: "סמני כדחוף",
    unmark_urgent: "הסירי דחיפות",
    urgent_job: "משרה דחופה",
    no_data: "אין נתונים",

    // Follow-ups & New Jobs
    follow_up_at: "תזכורת מעקב",
    follow_up: "מעקב",
    follow_up_label: "תאריך ושעה לפולואפ",
    follow_up_done: "סומן כבוצע",
    mark_done: "סמן כבוצע",
    follow_up_overdue: "פולואפ באיחור",
    follow_up_due_soon: "פולואפ בקרוב",
    follow_up_upcoming: "פולואפ מתוכנן",
    new_jobs: "משרות חדשות",
    new_jobs_this_week: "משרות חדשות השבוע",
    no_new_jobs: "אין משרות חדשות השבוע",
    follow_ups_pending: "פולואפים ממתינים",
    reminder_overdue_title: "יש לך פולואפים באיחור!",
    reminder_overdue_desc: "מועמדים שצריך לעשות להם פולואפ - לחצי לצפייה",
    reminder_due_soon_title: "פולואפים מתוכננים להיום",
    reminder_due_soon_desc: "לחצי לצפייה במועמדים",
    pending_followups: "פולואפים ממתינים",

    // Tooltip
    tooltip_locations_title: "מיקומים נדרשים",
    tooltip_no_locations: "לא הוגדרו מיקומים",
    tooltip_click_for_details: "לחצי לפרטים נוספים",

    // Auth / Login
    username: "שם משתמש",
    password: "סיסמה",
    login_button: "התחברות",
    login_welcome: "ברוכים הבאים - התחברו כדי להמשיך",
    login_invalid: "שם משתמש או סיסמה שגויים",
    login_help: "משתמשי ברירת מחדל:",
    logout: "התנתקות",
    logged_in_as: "מחוברת כ",
    signup_title: "הרשמה למערכת",
    signup_button: "הרשמה",
    signup_note: "ההרשמה דורשת אישור מנהל. לאחר ההרשמה תקבלו מייל כשהחשבון יאושר.",
    signup_success: "ההרשמה נשלחה בהצלחה! המנהל יאשר את הבקשה בהקדם. תקבלו מייל כשההרשמה תאושר.",
    already_have_account: "כבר יש לך חשבון?",
    no_account: "אין לך חשבון?",
    forgot_password: "שכחתי סיסמה"
  },

  en: {
    // Navigation
    app_name: "RePro",
    app_tagline: "Your Job Abroad",
    dashboard: "Dashboard",
    jobs: "Jobs",
    candidates: "Candidates",
    settings: "Settings",

    // Dashboard
    welcome: "Welcome",
    dashboard_subtitle: "Overview of your activity",
    open_jobs: "Open Jobs",
    total_candidates: "Total Candidates",
    in_stage1: "In Stage 1",
    in_stage2: "In Stage 2",
    accepted_month: "Hired This Month",
    by_category: "Candidates by Category",
    recent_activity: "Recent Activity",
    no_activity: "No activity to show",
    quick_add: "Quick Add",
    add_job: "New Job",
    add_candidate: "New Candidate",

    // Jobs page
    jobs_title: "Jobs",
    jobs_subtitle: "Manage all your jobs",
    search_jobs: "Search jobs...",
    all_categories: "All Categories",
    all_statuses: "All Statuses",
    new_job: "New Job",
    edit_job: "Edit Job",
    no_jobs: "No jobs yet",
    no_jobs_desc: "Click 'New Job' to get started",

    // Candidates page
    candidates_title: "Candidates",
    candidates_subtitle: "Manage your candidate pipeline",
    search_candidates: "Search candidates...",
    all_jobs: "All Jobs",
    new_candidate: "New Candidate",
    edit_candidate: "Edit Candidate",
    stage1: "Stage 1 - With Me",
    stage2: "Stage 2 - With Employer",
    no_response: "No Response",
    accepted: "Hired",
    rejected: "Rejected",
    no_candidates_stage1: "No candidates in this stage",
    no_candidates_stage2: "No candidates in this stage",
    no_candidates_no_response: "No unresponsive candidates",
    no_candidates_accepted: "No candidates in this stage",

    // Form fields
    name: "Name",
    phone: "Phone",
    email: "Email",
    title: "Title",
    company: "Company",
    location: "Location",
    category: "Category",
    status: "Status",
    salary: "Salary Range",
    description: "Description",
    notes: "Notes",
    job: "Job",
    stage: "Stage",
    call_date: "Call Date",
    call_summary: "Call Summary",
    source: "Source",
    select_job: "Select a job",
    select_category: "Select a category",

    // Categories
    chimney: "Chimney",
    air_duct: "Air Duct",
    garage_door: "Garage Door",
    construction: "Construction",
    cosmetics: "Cosmetics & Hair Products",

    // Status
    status_open: "Open",
    status_filled: "Filled",
    status_paused: "Paused",
    status_closed: "Closed",

    // Actions
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    edit: "Edit",
    confirm_delete: "Are you sure you want to delete?",
    close: "Close",
    next_stage: "Next Stage",
    prev_stage: "Previous Stage",

    // Messages
    saved: "Saved successfully",
    deleted: "Deleted successfully",
    error: "An error occurred",
    loading: "Loading...",
    required: "Required field",

    // Activity
    moved_to: "moved to",
    created: "created",
    just_now: "just now",
    minutes_ago: "minutes ago",
    hours_ago: "hours ago",
    days_ago: "days ago",

    // Stats labels
    active_candidates: "Active Candidates",
    open_positions: "Open Positions",
    first_stage: "Stage 1",
    second_stage: "Stage 2",
    hired: "Hired",

    // Job details
    job_details: "Job Details",
    locations_list: "Locations",
    location_name: "Location Name",
    pressure: "Pressure",
    pressure_high: "High",
    pressure_medium: "Medium",
    pressure_low: "Low",
    candidates_needed: "Candidates Needed",
    candidates_needed_short: "needed",
    add_location: "Add Location",
    no_locations: "No locations defined",
    view_candidates: "View Candidates",
    view_details: "Job Details",
    placeholder_location: "e.g. Philadelphia",
    placeholder_needed: "e.g. 2-3",

    // Urgent / Priority
    urgent: "Urgent",
    mark_urgent: "Mark as urgent",
    unmark_urgent: "Remove urgent",
    urgent_job: "Urgent Job",
    no_data: "No data",

    // Follow-ups & New Jobs
    follow_up_at: "Follow-up Reminder",
    follow_up: "Follow-up",
    follow_up_label: "Follow-up date & time",
    follow_up_done: "Marked as done",
    mark_done: "Mark as done",
    follow_up_overdue: "Follow-up overdue",
    follow_up_due_soon: "Follow-up due soon",
    follow_up_upcoming: "Follow-up scheduled",
    new_jobs: "New Jobs",
    new_jobs_this_week: "New Jobs This Week",
    no_new_jobs: "No new jobs this week",
    follow_ups_pending: "Pending follow-ups",
    reminder_overdue_title: "You have overdue follow-ups!",
    reminder_overdue_desc: "Candidates waiting for follow-up - click to view",
    reminder_due_soon_title: "Follow-ups scheduled for today",
    reminder_due_soon_desc: "Click to view candidates",
    pending_followups: "Pending follow-ups",

    // Tooltip
    tooltip_locations_title: "Required Locations",
    tooltip_no_locations: "No locations defined",
    tooltip_click_for_details: "Click for more details",

    // Auth / Login
    username: "Username",
    password: "Password",
    login_button: "Sign In",
    login_welcome: "Welcome - sign in to continue",
    login_invalid: "Invalid username or password",
    login_help: "Default users:",
    logout: "Sign Out",
    logged_in_as: "Logged in as",
    signup_title: "Sign Up",
    signup_button: "Sign Up",
    signup_note: "Registration requires admin approval. You'll receive an email when your account is approved.",
    signup_success: "Registration submitted! The admin will review your request shortly. You'll receive an email when approved.",
    already_have_account: "Already have an account?",
    no_account: "Don't have an account?",
    forgot_password: "Forgot password?"
  }
};

// i18n manager
const I18n = {
  current: localStorage.getItem('lang') || 'he',

  t(key) {
    return translations[this.current][key] || key;
  },

  setLang(lang) {
    this.current = lang;
    localStorage.setItem('lang', lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    this.applyToPage();
  },

  toggle() {
    this.setLang(this.current === 'he' ? 'en' : 'he');
  },

  applyToPage() {
    // Update all elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = this.t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      el.placeholder = this.t(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      el.title = this.t(key);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria-label');
      el.setAttribute('aria-label', this.t(key));
    });

    // Update language button text (preserve icon)
    const langBtn = document.getElementById('lang-switch');
    if (langBtn) {
      const icon = langBtn.querySelector('svg');
      const label = this.current === 'he' ? 'English' : 'עברית';
      if (icon) {
        langBtn.innerHTML = '';
        langBtn.appendChild(icon);
        langBtn.appendChild(document.createTextNode(label));
      } else {
        langBtn.textContent = label;
      }
    }

    // Re-render dynamic content if available
    if (typeof onLangChange === 'function') onLangChange();
  },

  init() {
    document.documentElement.lang = this.current;
    document.documentElement.dir = this.current === 'he' ? 'rtl' : 'ltr';
    // Apply after DOM ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.applyToPage());
    } else {
      this.applyToPage();
    }
  }
};

// Category utilities
// Dynamic categories - loaded from server, with fallback
let CATEGORIES = ['chimney', 'air_duct', 'garage_door', 'construction', 'cosmetics'];
let CATEGORIES_DATA = [];
const STATUSES = ['open', 'filled', 'paused', 'closed'];
const STAGES = ['stage1', 'stage2', 'accepted', 'rejected'];

async function loadCategories() {
  try {
    const token = localStorage.getItem('auth_token');
    const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
    const res = await fetch('/api/categories', { headers });
    if (res.ok) {
      CATEGORIES_DATA = await res.json();
      CATEGORIES = CATEGORIES_DATA.map(c => c.id);
    }
  } catch (e) { /* use defaults */ }
}

function getCategoryLabel(cat) {
  if (CATEGORIES_DATA.length > 0) {
    const found = CATEGORIES_DATA.find(c => c.id === cat);
    if (found) return I18n.current === 'he' ? found.label_he : found.label_en;
  }
  return I18n.t(cat);
}

function getCategoryColor(cat) {
  if (CATEGORIES_DATA.length > 0) {
    const found = CATEGORIES_DATA.find(c => c.id === cat);
    if (found) return found.color;
  }
  const defaults = { chimney: '#fdab3d', air_duct: '#0073ea', garage_door: '#a358df', construction: '#00c875', cosmetics: '#ff158a' };
  return defaults[cat] || '#6c757d';
}

function getStatusLabel(status) {
  return I18n.t('status_' + status);
}

// Initialize on load
I18n.init();
