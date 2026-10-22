# Karta ERP — System Runbook

**Version:** 1.0.0  
**Last Updated:** 2026-07-16  
**Production Path:** `C:\xampp\htdocs\system52\karta\`

---

## 1. Project Overview

### Purpose

Karta ERP is an Arabic-language financial ERP system built for managing transportation logistics operations. It handles receipt management (كارتات), bolsa discharge forms (تفريغ البوالص), treasury operations, client accounts, and office/company tracking.

The system is designed for LAN deployment across 5 devices using XAMPP.

### Architecture

| Layer | Technology | Description |
|---|---|---|
| Frontend | Vanilla JavaScript (ES Modules) | SPA with page-section routing |
| Backend | PHP 8.x | REST API with JSON responses |
| Database | MySQL 5.7+ / MariaDB 10.3+ | All money stored as integer cents (BIGINT) |
| Web Server | Apache (XAMPP) | Serves both static files and PHP API |
| Authentication | PHP Sessions | `KARTA_SESSION` cookie, 8-hour lifetime |
| Real-time Sync | Polling | `syncService.js` polls `/api/sync/versions.php` every 4 seconds |

### Main Modules

| Module | File(s) | Purpose |
|---|---|---|
| Authentication | `auth.js`, `api/auth/*.php` | Login, logout, session management |
| Receipts Form | `receipts.js` | Create/edit individual receipt forms |
| All Receipts | `allReceipts.js` | List, filter, print, export all receipts |
| Bolsa Form | `bolsas.js` | Create/edit bolsa discharge forms |
| All Bolsas | `allBolsas.js` | List, filter, print all bolsa forms |
| Entities | `entities.js` | Vehicle owners, agents, client accounts |
| Offices | `offices.js` | Companies and office management |
| Treasury | `treasury.js` | Financial treasury operations |
| Dashboard | `dashboard.js` | Admin-only financial dashboard |
| Archive | `archive.js`, `archiveViewer.js` | Batch archiving of historical data |
| Financial Service | `financial.js` | All financial operations (create/delete/update with balance tracking) |
| Money | `money.js` | Cents ↔ decimal conversion (single source of truth) |
| Sync Service | `services/syncService.js` | Real-time data version polling |
| Print Engine | `printEngine.js` | Iframe-based print system |
| Excel Export | `excelService.js` | Receipt data export to .xlsx |

### Folder Structure

```
karta/
├── api/                    # PHP REST API endpoints
│   ├── auth/               # Login, logout, session
│   ├── entities/           # CRUD for all entity types
│   ├── financial/          # Financial operations (receipt/bolsa create/delete)
│   ├── health/             # System health check
│   ├── middleware/         # Auth & role middleware
│   ├── stats/              # Statistical queries
│   ├── sync/               # Data version tracking
│   ├── archive/            # Archive operations
│   └── backup/             # Backup create/restore
├── components/             # Reusable UI components
│   └── multiSelectFilter.js
├── config/                 # PHP configuration
│   ├── app.php             # App name, timezone, debug mode
│   ├── database.php        # MySQL connection settings
│   └── session.php         # Session configuration
├── constants/              # Shared constants
│   └── payoutStatus.js
├── core/                   # PHP core infrastructure
│   ├── bootstrap.php       # System initialization (required by every API endpoint)
│   ├── helpers.php         # Utility functions (getSessionUser, nowEgypt, etc.)
│   ├── json.php            # JSON response helpers
│   ├── response.php        # HTTP response helpers
│   ├── security.php        # Input sanitization
│   ├── validator.php       # Request validation
│   ├── versionTracker.php  # Data version tracking for sync
│   ├── errorMapper.php     # Error code mapping
│   └── permissions.php     # Role-based access
├── docs/                   # Documentation
├── logs/                   # Application logs (app.log)
├── public/                 # Public assets (placeholder)
├── repositories/           # PHP data access layer
│   ├── ReceiptRepository.php
│   ├── BolsaFormRepository.php
│   ├── AgentRepository.php
│   ├── TreasuryRepository2.php
│   └── ... (14 total)
├── scripts/                # Windows batch scripts for backup
├── services/               # Frontend service layer
│   ├── apiClient.js        # HTTP transport
│   ├── apiConfig.js        # API base URL detection
│   ├── syncService.js      # Polling sync
│   ├── clientRepository.js # Client-side data access
│   ├── receiptRepository.js
│   ├── financialCalculator.js  # ⚠ DO NOT MODIFY
│   └── ... (17 total)
├── storage/                # File storage (placeholder)
├── uploads/                # Upload directory (placeholder)
├── utils/                  # Shared utilities
│   └── idGenerator.js
├── database*.sql           # 16 SQL schema files
├── index.html              # Main SPA entry point
├── login.html              # Login page
├── index.php               # API root info
├── setup.php               # First-time setup (DELETE after use)
├── app.js                  # SPA router and bootstrap
├── styles.css              # All application CSS
└── .htaccess               # Apache configuration
```

### Important Entry Points

| Entry Point | Type | URL |
|---|---|---|
| Login Page | HTML | `http://<host>/system52/karta/login.html` |
| Main Application | HTML | `http://<host>/system52/karta/index.html` |
| API Root | PHP | `http://<host>/system52/karta/index.php` |
| Health Check | PHP | `http://<host>/system52/karta/api/health/ping.php` |
| Setup (one-time) | PHP | `http://<host>/system52/karta/setup.php` |

---

## 2. Requirements

### Server

| Requirement | Version | Notes |
|---|---|---|
| XAMPP | 8.x recommended | Includes Apache + PHP + MySQL |
| PHP | 8.0+ | Required: PDO, pdo_mysql, json, mbstring, session |
| MySQL | 5.7+ or MariaDB 10.3+ | `utf8mb4` charset, `DATETIME(3)` support |
| Apache | 2.4+ | `mod_rewrite` must be enabled |

### Client

| Requirement | Notes |
|---|---|
| Browser | Chrome, Edge, or Firefox (modern ES Module support required) |
| JavaScript | ES2020+ (uses optional chaining `?.`, nullish coalescing `??`, `queueMicrotask`) |
| Network | LAN access to the XAMPP server |

### PHP Extensions Required

- `pdo` — Database access
- `pdo_mysql` — MySQL driver
- `json` — JSON encoding/decoding
- `mbstring` — Multibyte string support (Arabic text)
- `session` — PHP sessions

### Database

- Name: `karta_erp`
- Charset: `utf8mb4`
- Collation: `utf8mb4_unicode_ci`
- Tables: 18 (see Section 10)
- Money storage: All monetary values stored as **integer cents** (BIGINT)
- Dates: `Africa/Cairo` timezone, `DATETIME(3)` millisecond precision

---

## 3. Fresh Installation

### Step 1: Install XAMPP

Download and install XAMPP from [apachefriends.org](https://www.apachefriends.org/).

Start **Apache** and **MySQL** from the XAMPP Control Panel.

### Step 2: Deploy Application Files

Copy the entire `karta/` directory to:

```
C:\xampp\htdocs\system52\karta\
```

Ensure the following directories exist and are writable by Apache:

```
karta/logs/
karta/storage/
karta/uploads/
```

### Step 3: Enable Apache mod_rewrite

Open `C:\xampp\apache\conf\httpd.conf` and verify this line is uncommented:

```
LoadModule rewrite_module modules/mod_rewrite.so
```

Also verify `AllowOverride All` is set for the htdocs directory.

### Step 4: Create the Database

Open phpMyAdmin at `http://localhost/phpmyadmin`.

Import SQL files **in this order**:

1. `database.sql` — Creates database and users table
2. `database_vehicle_owners.sql`
3. `database_vehicles.sql`
4. `database_agents.sql`
5. `database_drivers.sql`
6. `database_offices.sql`
7. `database_notes.sql`
8. `database_receipts.sql`
9. `database_treasury.sql`
10. `database_vehicle_ledger.sql`
11. `database_bolsa_forms.sql`
12. `database_main_capital.sql`
13. `database_archive.sql`
14. `database_sync.sql`
15. `database_backup_metadata.sql`
16. `database_hamola_details.sql`

### Step 5: Configure Database Connection

Edit `config/database.php` if your MySQL credentials differ from defaults:

```php
return [
    'host'     => '127.0.0.1',
    'port'     => 3306,
    'dbname'   => 'karta_erp',
    'username' => 'root',       // Change if needed
    'password' => '',           // Change if needed
    'charset'  => 'utf8mb4',
];
```

### Step 6: Run First-Time Setup

Navigate to:

```
http://localhost/system52/karta/setup.php
```

This script:
- Verifies all required tables exist
- Creates properly hashed passwords for default users
- Reports setup status

**Expected output:** All green checkmarks (✅).

### Step 7: Delete setup.php

After successful setup, **delete `setup.php`** for security:

```
del C:\xampp\htdocs\system52\karta\setup.php
```

### Step 8: Verify Health

Navigate to:

```
http://localhost/system52/karta/api/health/ping.php
```

**Expected response:**

```json
{
  "success": true,
  "message": "Karta ERP Health Check",
  "data": {
    "status": "ok",
    "php": "8.x.x",
    "mysql": "connected",
    "users_table": "exists",
    "session": "active"
  }
}
```

---

## 4. Starting the System

### Start Services

1. Open **XAMPP Control Panel**
2. Start **Apache** — click "Start" (should show green)
3. Start **MySQL** — click "Start" (should show green)

### Access the Application

| Purpose | URL |
|---|---|
| Login | `http://localhost/system52/karta/login.html` |
| LAN Access | `http://192.168.x.x/system52/karta/login.html` |

Replace `192.168.x.x` with the server's LAN IP address.

### Default Credentials

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Accountant | `accountant` | `accountant123` |

**Note:** Admin role has access to the Dashboard page. Accountant role does not.

---

## 5. First Startup Verification

After logging in, you should see:

1. **Header bar** — with system name "النظام المالي", backup buttons, and logout button
2. **Sidebar** — navigation with 10 page links (icons with Arabic labels)
3. **Home page** — the default landing page after login
4. **Browser console** — should show `[SyncService] ▶ بدء مراقبة التغييرات — كل 4000 ms`

### Expected Behavior

- Sidebar is collapsible (hamburger menu in header)
- Sidebar links highlight on click
- Pages transition smoothly (SPA — no page reload)
- No JavaScript errors in browser console
- Network tab shows periodic requests to `/api/sync/versions.php` every 4 seconds

---

## 6. Full Functional Verification Checklist

### Authentication

- [ ] Login with admin credentials
- [ ] Login with accountant credentials
- [ ] Incorrect password shows error
- [ ] Logout works (redirects to login)
- [ ] Session persists across page refresh
- [ ] Session expires after 8 hours of inactivity

### Home Page

- [ ] Home page loads without errors
- [ ] Treasury summary cards display

### Receipt Form (نموذج الصرف)

- [ ] Open receipt form page
- [ ] Fill all required fields
- [ ] Add rows to the receipt
- [ ] Save receipt (✅ success message)
- [ ] Edit existing receipt
- [ ] Vehicle separator rows appear correctly
- [ ] Financial calculations are correct
- [ ] Cancel edit returns to clean form

### All Receipts (جميع الكارتات)

- [ ] Page loads with receipt cards
- [ ] Date range filter works (from/to)
- [ ] Quick range buttons work (day/week/month)
- [ ] Multi-select filters work (owner, company, vehicle, karta, type)
- [ ] Apply button triggers search
- [ ] Status filter works (all/paid/unpaid)
- [ ] Sort by payout date toggle works
- [ ] Summary cards show correct totals
- [ ] Edit button navigates to receipt form with data loaded
- [ ] Delete button shows confirmation dialog
- [ ] Delete actually removes the receipt
- [ ] Print single receipt produces correct layout
- [ ] Print all (PDF export) produces correct document
- [ ] Excel export downloads .xlsx file
- [ ] Payout status dropdown changes receipt status
- [ ] Receipt notes save correctly

### Bolsa Form (تفريغ البوالص)

- [ ] Open bolsa form page
- [ ] Fill agent, date, and rows
- [ ] Save bolsa form
- [ ] Edit existing bolsa form
- [ ] Delete bolsa form

### All Bolsas (جميع البوالص)

- [ ] Page loads with bolsa cards
- [ ] Date range filter works
- [ ] Quick range buttons work
- [ ] Text filters work (agent, owner, company, vehicle, karta)
- [ ] Global search works
- [ ] Apply button re-renders
- [ ] Summary cards show correct totals (weight, ohda, dokhan, solar, grand total)
- [ ] Edit button navigates to bolsa form with data loaded
- [ ] Delete button shows confirmation and deletes
- [ ] Print single bolsa produces correct layout
- [ ] PDF export produces correct document
- [ ] Navigation away and back does not accumulate listeners
- [ ] Page re-initializes cleanly after navigation

### Client Accounts (كشف حساب العملاء)

- [ ] Page loads with owner list
- [ ] Add new vehicle owner
- [ ] Search by name
- [ ] Click owner shows detail page
- [ ] Balance displays correctly
- [ ] Transaction history loads

### Treasury (الخزنة)

- [ ] Page loads
- [ ] Add treasury entry
- [ ] Delete treasury entry
- [ ] Balance updates correctly
- [ ] Print treasury report

### Offices/Companies (الشركات)

- [ ] Page loads with office list
- [ ] Add new office
- [ ] Edit office
- [ ] Delete office
- [ ] Office detail page shows transactions
- [ ] Print office report

### Archive (الأرشيف)

- [ ] Create archive batch
- [ ] View archived data
- [ ] Restore archived data
- [ ] Print archived receipts

### Dashboard (لوحة التحكم — Admin Only)

- [ ] Dashboard loads for admin user
- [ ] Dashboard is blocked for accountant user
- [ ] Summary cards show correct values
- [ ] Financial charts render
- [ ] Print dashboard report

### Backup & Restore

- [ ] Backup button downloads SQL dump
- [ ] Restore button uploads and restores backup

---

## 7. Page-by-Page Manual Test

### Login Page (`login.html`)

**Purpose:** User authentication.

**How to open:** Navigate to `http://<host>/system52/karta/login.html`

**Expected UI:**
- Arabic text (RTL layout)
- Username input field
- Password input field
- Login button (تسجيل الدخول)

**Actions:**
- Enter credentials → click login
- Success → redirects to `index.html`
- Failure → error message appears below form

### Home Page (`homePage`)

**Purpose:** Landing page with treasury overview.

**Sidebar link:** الرئيسية (first link, house icon)

**Expected:** Treasury balance display, quick navigation cards.

### Receipt Form (`receiptPage`)

**Purpose:** Create or edit individual receipt (كارتة).

**Sidebar link:** نموذج الصرف

**Expected:**
- Header with client name, receipt number, date fields
- Dynamic row table for vehicle entries
- Vehicle separator rows between different vehicles
- Financial summary at bottom
- Save button, Clear button

**Key behavior:** Adding rows auto-calculates totals. Vehicle changes insert separator rows.

### All Receipts (`allReceiptsPage`)

**Purpose:** Central view of all receipts with filtering, printing, and export.

**Sidebar link:** جميع النماذج

**Expected:**
- Title: "جميع الكارتات"
- Filter toolbar with multi-select dropdowns
- Date range with from/to inputs
- Quick range buttons (day, week, month)
- Status filter (all/paid/unpaid)
- Summary cards (7 cards: net due, net total, paid, count, weight, noloon, ohda)
- Receipt cards with expand/collapse
- Action buttons per card: edit, print, delete, payout status

### Bolsa Form (`bolsaPage`)

**Purpose:** Create or edit bolsa discharge form.

**Sidebar link:** تفريغ البوالص

**Expected:**
- Agent selector
- Date field
- Dynamic row table for cargo entries
- Save/Clear buttons

### All Bolsas (`allBolsasPage`)

**Purpose:** Central view of all bolsa forms with filtering and printing.

**Sidebar link:** جميع البوالص

**Expected:**
- Title: "جميع سجلات تفريغ البوالص"
- Filter inputs (global, agent, owner, company, vehicle, karta, date)
- Date range with from/to
- Quick range buttons
- Summary cards (6 cards: weight, count, ohda, dokhan, grand total, solar)
- Bolsa cards with emerald green theme
- Action buttons: edit, print, delete

### Client Accounts (`ownersPage`)

**Purpose:** Manage vehicle owners and their financial accounts.

**Sidebar link:** كشف حساب العملاء

**Expected:**
- Add owner form (name + notes)
- Search input
- Table: name, balance, actions
- Click owner → detail page with transaction ledger

### Treasury (`treasuryPage`)

**Purpose:** Record and track treasury transactions.

**Sidebar link:** الخزنة

**Expected:** Transaction list, add entry form, balance display.

### Offices (`officesPage`)

**Purpose:** Manage company/office records.

**Sidebar link:** الشركات

**Expected:** Office list, add/edit forms, detail pages with transaction history.

### Archive (`archivePage`)

**Purpose:** Archive historical data into batches.

**Sidebar link:** الأرشيف

**Expected:** Archive batch list, create/view/restore buttons.

### Dashboard (`dashboardPage`)

**Purpose:** Admin-only financial overview.

**Sidebar link:** لوحة التحكم

**Expected:** Summary cards, financial totals, charts. Blocked for non-admin users.

---

## 8. Browser Console Verification

Open browser Developer Tools (F12) → Console tab.

### Expected on startup:

```
[SyncService] ▶ بدء مراقبة التغييرات — كل 4000 ms
```

### Must NOT see:

- ❌ `ReferenceError` — function not defined
- ❌ `TypeError` — cannot read property of null/undefined
- ❌ `SyntaxError` — parsing error
- ❌ `Uncaught (in promise)` — unhandled async errors
- ❌ Repeating warnings in a loop
- ❌ `404` errors for JS/CSS/API files
- ❌ CORS errors

### Acceptable:

- `console.warn` for non-critical issues (rare)
- `console.log` from SyncService startup message

---

## 9. Network Verification

Open browser Developer Tools (F12) → Network tab.

### On page load:

| Request | Method | Expected Response |
|---|---|---|
| `session.php` | GET | `200` with user data |
| `versions.php` | GET | `200` with version numbers (repeats every 4s) |

### When navigating to All Receipts:

| Request | Method | Expected Response |
|---|---|---|
| `list.php` (receipts) | GET | `200` with receipt array |

### When navigating to All Bolsas:

| Request | Method | Expected Response |
|---|---|---|
| `list.php` (bolsa-forms) | GET | `200` with bolsa array |

### When searching receipts:

| Request | Method | Expected Response |
|---|---|---|
| `search.php` | POST | `200` with `{ data, meta }` |

### Red flags:

- ❌ `401` responses (session expired — re-login)
- ❌ `500` responses (server error — check `logs/app.log`)
- ❌ `0` status (network error — check Apache is running)
- ❌ Duplicate requests firing simultaneously
- ❌ Requests to `undefined` URLs

---

## 10. Database Verification

### Tables (18 total)

| Table | Purpose |
|---|---|
| `users` | User accounts and authentication |
| `vehicle_owners` | Vehicle owner records |
| `vehicles` | Vehicle registry |
| `agents` | Agent (mandoub) records with balances |
| `offices` | Company/office records |
| `drivers` | Driver registry |
| `notes` | General notes |
| `receipt_counters` | Auto-increment counters for receipt numbers |
| `receipts` | Receipt forms (كارتات) — money in cents |
| `treasury` | Treasury transaction ledger |
| `vehicle_ledger` | Per-vehicle financial ledger |
| `bolsa_forms` | Bolsa discharge forms |
| `main_capital_treasury` | Capital treasury records |
| `archive_batches` | Archive batch metadata |
| `financial_snapshots` | Point-in-time financial snapshots |
| `data_versions` | Entity version tracking for sync |
| `backup_metadata` | Backup file metadata |
| `hamola_details` | Hamola (load) detail records |

### Verification queries:

```sql
-- Check table count
SELECT COUNT(*) FROM information_schema.tables 
WHERE table_schema = 'karta_erp';
-- Expected: 18

-- Check user accounts
SELECT username, role, is_active FROM users;
-- Expected: admin (admin), accountant (accountant)

-- Check data versions (sync)
SELECT * FROM data_versions;
-- Should have rows for each tracked entity
```

### Data Integrity Rules

- All money columns use `BIGINT` (integer cents)
- `100` in the database = `1.00` in the UI
- Dates use `DATETIME(3)` with `Africa/Cairo` timezone
- Soft deletes use `deleted_at` column (where applicable)
- `receipt_counters` tracks the next receipt number per user

---

## 11. Printing Verification

### Single Receipt Print

1. Go to All Receipts → find a receipt card
2. Click 🖨️ طباعة (print button)
3. **Expected:** Browser print dialog opens with:
   - A4 portrait layout
   - RTL Arabic text
   - Company header with logo
   - Receipt details table
   - Totals row at bottom
   - Correct financial values

### Bulk Print (PDF Export)

1. Go to All Receipts → click 📄 تصدير PDF
2. **Expected:** Browser print dialog with all visible receipts
3. Each receipt should be on its own card with page-break-before

### Single Bolsa Print

1. Go to All Bolsas → find a bolsa card
2. Click 🖨️ طباعة
3. **Expected:** A4 landscape layout with emerald green headers

### Print Troubleshooting

- If print dialog doesn't open: check browser popup blocker
- If layout is wrong: verify `styles.css` is loaded
- If colors don't print: enable "Background graphics" in browser print settings

---

## 12. Excel Export Verification

### How to export:

1. Go to All Receipts
2. Apply desired filters
3. Click 📊 تصدير Excel

### Expected file:

- Format: `.xlsx`
- Filename: auto-generated with date
- Encoding: UTF-8 (Arabic text renders correctly)
- Data: Only the currently visible (filtered) receipts
- Columns: Match the receipt table columns
- Separator rows: Excluded from export
- Empty records: Skipped silently

### Verification:

- Open in Excel or Google Sheets
- Arabic text should display correctly (RTL)
- Numeric values should be numbers, not strings
- Totals should match the on-screen summary cards

---

## 13. Common Problems

### Problem: Login fails with correct credentials

**Symptoms:** "بيانات غير صحيحة" error  
**Cause:** Password hashes not properly generated  
**Fix:** Re-run `setup.php` or manually hash passwords:
```bash
php -r "echo password_hash('admin123', PASSWORD_BCRYPT);"
```
Update the `users` table with the correct hash.

### Problem: Blank page after login

**Symptoms:** White screen, no content  
**Cause:** JavaScript module loading error  
**Fix:** Open browser console (F12) → check for `404` or `SyntaxError`. Verify all `.js` files exist in the karta directory.

### Problem: API returns 500 errors

**Symptoms:** Features don't load, network tab shows 500  
**Cause:** PHP error  
**Fix:** Check `logs/app.log` for the detailed error message. Common causes:
- MySQL not running
- Database connection credentials wrong in `config/database.php`
- Missing PHP extension

### Problem: Data not updating across devices

**Symptoms:** Changes made on one device don't appear on another  
**Cause:** SyncService not running or poll failing  
**Fix:** Check browser console for sync errors. Verify `/api/sync/versions.php` returns `200`.

### Problem: Print shows wrong layout

**Symptoms:** Print dialog shows unstyled content  
**Cause:** Print CSS not loading in iframe  
**Fix:** The print system uses inline styles inside the iframe. If the issue persists, try a different browser.

### Problem: Session expires too quickly

**Symptoms:** Frequent "تم انتهاء الجلسة" errors  
**Cause:** PHP `session.gc_maxlifetime` too low  
**Fix:** Edit `config/session.php` → increase `lifetime` and `gc_maxlifetime` values.

### Problem: Arabic text appears as boxes or question marks

**Symptoms:** □□□□ or ??? instead of Arabic text  
**Cause:** Character encoding mismatch  
**Fix:** Verify `config/database.php` has `charset => 'utf8mb4'` and `MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4"`.

---

## 14. Recovery

### Application Crash

1. Check `logs/app.log` for the error
2. Restart Apache and MySQL from XAMPP Control Panel
3. Clear browser cache and reload

### Database Corruption

1. Stop MySQL
2. Restore from backup (see Backup & Restore)
3. If no backup: re-import SQL schema files and accept data loss

### Backup & Restore

**Create backup:**
- Click 💾 نسخة احتياطية in the application header
- Downloads a SQL dump file

**Restore backup:**
- Click 📥 استعادة in the header
- Select the backup SQL file
- Confirm restoration

**Manual backup via phpMyAdmin:**
1. Open `http://localhost/phpmyadmin`
2. Select `karta_erp` database
3. Click "Export" → "Go"
4. Save the `.sql` file

**Manual restore via phpMyAdmin:**
1. Drop the existing `karta_erp` database
2. Create a new `karta_erp` database
3. Import the backup `.sql` file
4. Run `setup.php` again to re-hash passwords

### Wrong Configuration

1. Compare `config/database.php` against known-good values
2. Verify MySQL is running: `http://localhost/phpmyadmin`
3. Test connectivity: `http://localhost/system52/karta/api/health/ping.php`

### Cache Problems

1. Hard reload: `Ctrl + Shift + R` in browser
2. Clear browser cache: Settings → Clear browsing data
3. If using a versioned script URL (`app.js?v=...`), update the version parameter in `index.html`

### Permission Problems

Ensure these directories are writable by the Apache process:

```
karta/logs/
karta/storage/
karta/uploads/
```

On Windows (XAMPP), this is typically not an issue. On Linux, use:

```bash
chmod -R 775 logs/ storage/ uploads/
chown -R www-data:www-data logs/ storage/ uploads/
```

---

## 15. Production Deployment Notes

### Pre-Deployment Checklist

- [ ] Backup current database
- [ ] Verify `config/app.php` has `'debug' => false`
- [ ] Verify `setup.php` is deleted
- [ ] Verify `config/database.php` has correct production credentials
- [ ] Test health endpoint after deployment

### Deployment Order

1. **Stop Apache** (XAMPP Control Panel)
2. **Backup database** (phpMyAdmin export)
3. **Copy new files** to `C:\xampp\htdocs\system52\karta\`
4. **Do NOT overwrite** `config/database.php` if credentials differ
5. **Run any new SQL migration files** in phpMyAdmin
6. **Start Apache**
7. **Verify health endpoint** returns `"status": "ok"`
8. **Test login** with admin credentials
9. **Verify one receipt loads** on All Receipts page

### Rollback

1. Stop Apache
2. Restore previous file version from backup
3. Restore database from SQL backup if schema changed
4. Start Apache
5. Verify health endpoint

### LAN Access Configuration

All LAN devices access the system via the server's IP address:

```
http://192.168.x.x/system52/karta/login.html
```

The API base URL is auto-detected by `services/apiConfig.js` — no hardcoded URLs.

---

## 16. Maintenance Checklist

### Daily

- [ ] Verify application is accessible from all LAN devices
- [ ] Check `logs/app.log` for errors (should be empty or minimal)
- [ ] Verify sync is working (browser console shows no sync errors)

### Weekly

- [ ] Create a database backup (💾 button or phpMyAdmin export)
- [ ] Clear old log entries from `logs/app.log` if file is large
- [ ] Verify disk space on the server

### Monthly

- [ ] Test backup restore on a separate XAMPP instance
- [ ] Verify all 10 pages load without console errors
- [ ] Review user accounts (deactivate unused accounts)
- [ ] Check XAMPP for updates

---

## 17. Final Acceptance Checklist

All of the following must pass before considering the application healthy:

### Infrastructure

- [ ] Apache is running and serving the application
- [ ] MySQL is running and accessible
- [ ] Health endpoint returns `"status": "ok"`
- [ ] All 18 database tables exist
- [ ] `setup.php` has been deleted
- [ ] `config/app.php` has `debug => false`

### Authentication

- [ ] Admin login works
- [ ] Accountant login works
- [ ] Logout works
- [ ] Invalid credentials are rejected

### Core Features

- [ ] Create a receipt → save successfully
- [ ] Receipt appears in All Receipts
- [ ] Edit the receipt → save changes
- [ ] Delete the receipt → confirm and verify removal
- [ ] Create a bolsa form → save successfully
- [ ] Bolsa appears in All Bolsas
- [ ] Edit the bolsa → save changes
- [ ] Delete the bolsa → confirm and verify removal

### Financial Integrity

- [ ] Receipt financial totals are mathematically correct
- [ ] Client balance updates after receipt create/delete
- [ ] Agent balance updates after bolsa create/delete
- [ ] Treasury balance reflects operations

### Search & Filter

- [ ] All Receipts multi-select filters work
- [ ] All Receipts date range works
- [ ] All Receipts status filter works
- [ ] All Bolsas text filters work
- [ ] All Bolsas date range works

### Output

- [ ] Single receipt prints correctly
- [ ] Bulk receipt PDF exports correctly
- [ ] Excel export downloads and opens correctly
- [ ] Single bolsa prints correctly
- [ ] Bulk bolsa PDF exports correctly

### Sync & Multi-Device

- [ ] Create a receipt on Device A → appears on Device B within 5 seconds
- [ ] Delete a record on Device A → disappears from Device B within 5 seconds
- [ ] No duplicate sync requests in network tab

### Stability

- [ ] Zero JavaScript errors in browser console after 5 minutes of use
- [ ] Navigate all 10 pages sequentially — no errors accumulate
- [ ] Navigate to All Bolsas → leave → return → leave → return — no memory leak, no duplicate dialogs
- [ ] Application survives network interruption and recovers on reconnect

### Browser Compatibility

- [ ] Chrome — all features work
- [ ] Edge — all features work
- [ ] Firefox — all features work (if required)

---

*End of Runbook*
