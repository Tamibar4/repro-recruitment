# Recruitment Manager / מערכת ניהול גיוס

מערכת ניהול גיוס והשמה בסגנון Monday.com - לניהול משרות ומועמדים בצורה מקצועית ופשוטה.

A Monday.com-style recruitment management system for managing jobs and candidates professionally and simply.

---

## עברית

### מה המערכת עושה?

מערכת לניהול פייפליין גיוס מלא:
- **משרות**: ניהול כל המשרות לפי תחומים (Chimney, Air Duct, Garage Door, Construction, Cosmetics)
- **מועמדים**: מעקב מועמדים בשלושה שלבים (שיחה איתי → אצל מעסיק → התקבלו)
- **דשבורד**: סטטיסטיקות ותובנות בזמן אמת
- **חיפוש וסינון**: חיפוש מהיר לפי שם, טלפון, משרה, ועוד
- **דו-לשוני**: עברית ואנגלית עם החלפה בלחיצה

### התקנה ראשונית

1. **התקנת Node.js** (חד פעמי): הורידי מ-[nodejs.org](https://nodejs.org/) את הגרסה "LTS"
2. **פתחי Terminal / CMD** בתיקיית הפרויקט
3. **הריצי את הפקודה**:
   ```bash
   npm install
   ```

### הפעלה

```bash
npm start
```

לאחר ההרצה פתחי את הדפדפן ב: **http://localhost:3000**

### גיבוי נתונים

כל הנתונים נשמרים בקובץ `database.json` בתיקיית הפרויקט.
כדי לגבות - העתיקי את הקובץ הזה למקום בטוח.
הקובץ קריא על ידי בני אדם ואפשר לערוך אותו ידנית אם צריך.

### קיצורי מקלדת

- `Ctrl/Cmd + K` - חיפוש מהיר
- `Esc` - סגירת חלונות

---

## English

### What does it do?

A complete recruitment pipeline management system:
- **Jobs**: Manage all jobs by category (Chimney, Air Duct, Garage Door, Construction, Cosmetics)
- **Candidates**: Track candidates through three stages (Stage 1 with me → Stage 2 with employer → Accepted)
- **Dashboard**: Real-time statistics and insights
- **Search & Filter**: Quick search by name, phone, job, and more
- **Bilingual**: Hebrew and English with one-click switching

### Installation

1. **Install Node.js** (one-time): Download "LTS" version from [nodejs.org](https://nodejs.org/)
2. **Open Terminal / CMD** in the project directory
3. **Run the command**:
   ```bash
   npm install
   ```

### Run

```bash
npm start
```

After running, open your browser at: **http://localhost:3000**

### Data Backup

All data is stored in `database.json` in the project directory.
To backup - copy this file to a safe location.
The file is human-readable JSON, so you can inspect or edit it manually if needed.

### Keyboard Shortcuts

- `Ctrl/Cmd + K` - Quick search
- `Esc` - Close dialogs

---

## Tech Stack

- **Backend**: Node.js + Express
- **Database**: JSON file (zero dependencies, easy to backup)
- **Frontend**: Vanilla HTML/CSS/JavaScript (no build step)
- **Style**: Monday.com inspired

## License

MIT
