/**
 * app.js — bootstrap, routing, initialization
 */

import { AuthModule }  from './auth.js';
import { initReceiptPage } from './receipts.js';
import { initAllReceiptsPage } from './allReceipts.js';
import { attachOwnersPageListeners, loadOwners } from './entities.js';
import { attachOfficesPageListeners, initOfficesPage, loadOffices } from './offices.js';
import { initTreasuryPage } from './treasury.js';
import { initArchivePage } from './archive.js';
import { closeArchiveViewer } from './archiveViewer.js';
import { initHomePage } from './home.js';
import { initSidebarLayout } from './sidebarLayout.js';
import { initDashboardPage } from './dashboard.js';
import './entities.js';
import { verifyServerReady } from './services/serverVerification.js';
import { activateServerMode, API_CONFIG } from './services/apiConfig.js';
import { SyncService } from './services/syncService.js';

const LAST_PAGE_KEY = 'karta_v2_last_page';
const LAST_PAGE_CTX_KEY = 'karta_v2_last_page_ctx';
const PAGE_MAP = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receiptPage',
  allReceipts: 'allReceiptsPage',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  officesPage: 'officesPage',
  treasuryPage: 'treasuryPage',
  archivePage: 'archivePage',
  officeDetailsPage: 'officeDetailsPage',
};
const PAGE_KEY_NORMALIZE = {
  homePage: 'homePage',
  dashboardPage: 'dashboardPage',
  receipt: 'receipt',
  receiptPage: 'receipt',
  allReceipts: 'allReceipts',
  allReceiptsPage: 'allReceipts',
  ownersPage: 'ownersPage',
  ownerDetailsPage: 'ownerDetailsPage',
  officesPage: 'officesPage',
  treasuryPage: 'treasuryPage',
  archivePage: 'archivePage',
  officeDetailsPage: 'officeDetailsPage',
};

function _readLastPage() {
  return sessionStorage.getItem(LAST_PAGE_KEY);
}

function _writeLastPage(pageId) {
  if (!pageId) return;
  sessionStorage.setItem(LAST_PAGE_KEY, pageId);
}

function _readLastPageContext() {
  const raw = sessionStorage.getItem(LAST_PAGE_CTX_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _resolvePageElement(pageName) {
  // allow passing direct section id
  const direct = document.getElementById(pageName);
  if (direct) return direct;
  return document.getElementById(PAGE_MAP[pageName]);
}

function _resolvePageKey(pageName, targetId) {
  if (PAGE_KEY_NORMALIZE[pageName]) return PAGE_KEY_NORMALIZE[pageName];
  if (PAGE_KEY_NORMALIZE[targetId]) return PAGE_KEY_NORMALIZE[targetId];
  if (PAGE_MAP[pageName]) return pageName;
  if (PAGE_MAP[targetId]) return targetId;
  return pageName || targetId || '';
}

async function showPage(pageName) {
  const session = AuthModule.getSession();
  const role = session?.role || 'user';

  // Secure Navigation Layer
  if (role !== 'admin') {
    const targetEl = _resolvePageElement(pageName);
    const targetId = targetEl?.id || '';
    const pageKey = _resolvePageKey(pageName, targetId);
    if (pageKey === 'dashboardPage' || targetId === 'dashboardPage') {
      pageName = 'homePage';
    }
  }

  const pages = document.querySelectorAll('.page');
  pages.forEach(p => p.classList.add('hidden'));

  const target = _resolvePageElement(pageName);
  if (target) {
    target.classList.remove('hidden');
  }

  const targetId = target?.id || '';
  const pageKey = _resolvePageKey(pageName, targetId);
  _writeLastPage(pageKey);

  // ── Sidebar active state ──
  document.querySelectorAll('#sidebar .sidebar-link').forEach(link => {
    const lp = link.dataset.page;
    link.classList.toggle('active', lp === pageKey || lp === targetId);
  });

  if (pageName === 'ownersPage' || targetId === 'ownersPage') {
    await loadOwners();
  }
  if (pageName === 'officesPage' || targetId === 'officesPage') {
    await loadOffices();
  }
  if (pageName === 'allReceipts' || targetId === 'allReceiptsPage') {
    await initAllReceiptsPage();
  }
  if (pageName === 'dashboardPage' || targetId === 'dashboardPage') {
    if (role === 'admin') {
      await initDashboardPage();
    } else {
      await showPage('homePage');
    }
  }
  if (pageName === 'treasuryPage' || targetId === 'treasuryPage') {
    initHomePage();
    initTreasuryPage();
  }
  if (pageName === 'archivePage' || targetId === 'archivePage') {
    closeArchiveViewer();
    await initArchivePage();
  }
  if (pageName === 'homePage' || targetId === 'homePage') {
    initHomePage();
  }
}

window.showPage = showPage;

function _bindLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', async () => {
    await AuthModule.logout();
    window.location.href = 'login.html';
  });
}

async function boot() {
  try {
    // ── Step 1: Server Mode Activation ────────────────────────────────
    // Must happen FIRST so that all subsequent API calls route correctly.
    try {
      const serverCheck = await verifyServerReady();
      if (serverCheck.ready) {
        activateServerMode();
      } else {
        console.warn('[boot] Server not ready, staying in LOCAL mode:', serverCheck.errors);
      }
    } catch (e) {
      console.warn('[boot] Server verification failed, staying in LOCAL mode:', e.message);
    }

    // ── Step 2: PHP Session Check ─────────────────────────────────────
    // The SOLE authority for authentication. No localStorage, no IndexedDB.
    const session = await AuthModule.checkSession();
    if (!session) {
      window.location.href = 'login.html';
      return;
    }

    const username = session.username;
    if (!username) {
      throw new Error('Session username is required');
    }

    window.__APP_CONTEXT__ = Object.freeze({
      username,
      role: session.role,
    });


    // Secure Sidebar Visibility for non-admins
    if (session.role !== 'admin') {
      const dbLink = document.querySelector('[data-page="dashboardPage"]');
      if (dbLink) {
        dbLink.remove();
      }
    }

    initSidebarLayout();
    _bindLogout();
    initReceiptPage();
    await initAllReceiptsPage();
    initOfficesPage();
    attachOwnersPageListeners();
    attachOfficesPageListeners();
    initTreasuryPage();
    const lastPage = _readLastPage();
    const ctx = _readLastPageContext();
    let restored = false;

    if (lastPage === 'officeDetailsPage' && ctx?.officeId && typeof window.showOfficeDetails === 'function') {
      await window.showOfficeDetails(ctx.officeId);
      restored = true;
    } else if (lastPage === 'ownerDetailsPage' && ctx?.ownerId && typeof window.showOwnerDetails === 'function') {
      await window.showOwnerDetails(ctx.ownerId, ctx.ownerType || 'owner');
      restored = true;
    }

    if (!restored) {
      let fallbackPage = lastPage;
      if (lastPage === 'officeDetailsPage') fallbackPage = 'officesPage';
      if (lastPage === 'ownerDetailsPage') fallbackPage = 'ownersPage';
      if (!fallbackPage || !_resolvePageElement(fallbackPage)) fallbackPage = 'homePage';
      await showPage(fallbackPage);
    }

    // sidebar [data-page] navigation (unified — no more onclick)
    document.getElementById('sidebar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page]');
      if (!btn) return;
      const pageId = btn.dataset.page;
      if (pageId) showPage(pageId);
    });

    // ── Real-Time Sync — start polling AFTER all modules are initialized ──
    try {
      SyncService.start();
    } catch (syncErr) {
      console.warn('[boot] SyncService failed to start — app continues normally:', syncErr.message);
    }

  } catch (err) {
    console.error('[app] Boot failed:', err);
    const app = document.getElementById('app');
    if (app) {
      app.innerHTML = `
        <div class="login-page">
          <div class="login-card shadow-lg">
            <div class="alert alert-error flex-col gap-4 text-center">
              <span class="text-2xl mb-2" aria-hidden="true">⚠️</span>
              <p class="font-bold text-lg mb-2">فشل تحميل التطبيق</p>
              <p class="text-muted text-sm mb-0">${err.message || 'خطأ غير معروف'}</p>
            </div>
          </div>
        </div>`;
    }
  }
}

boot();


// ─────────────────────────────────────────────────────────────────────────────
// BACKUP SYSTEM — MySQL Native (Phase 10B)
// Reads from MySQL ONLY via PHP API. Zero IndexedDB.
// ─────────────────────────────────────────────────────────────────────────────

function _initMySQLBackup() {
  const backupBtn = document.getElementById('mysqlBackupBtn');
  const restoreBtn = document.getElementById('mysqlRestoreBtn');

  if (backupBtn && !backupBtn.dataset.bound) {
    backupBtn.dataset.bound = '1';
    backupBtn.addEventListener('click', async () => {
      if (!confirm('هل تريد إنشاء نسخة احتياطية كاملة من قاعدة البيانات؟')) return;
      backupBtn.disabled = true;
      backupBtn.textContent = '⏳ جاري التصدير...';
      try {
        const res = await fetch(API_CONFIG.BASE_URL + '/backup/create.php', {
          credentials: 'include',
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || 'فشل إنشاء النسخة الاحتياطية');
        }
        const blob = await res.blob();
        const cd = res.headers.get('Content-Disposition') || '';
        const fnMatch = cd.match(/filename="?([^"]+)"?/);
        const filename = fnMatch ? fnMatch[1] : `karta-v2-backup-${new Date().toISOString().slice(0,10)}.json`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        alert('✅ تم تحميل النسخة الاحتياطية بنجاح');
      } catch (err) {
        alert('❌ ' + (err.message || 'فشل إنشاء النسخة الاحتياطية'));
      } finally {
        backupBtn.disabled = false;
        backupBtn.textContent = '💾 نسخة احتياطية';
      }
    });
  }

  if (restoreBtn && !restoreBtn.dataset.bound) {
    restoreBtn.dataset.bound = '1';
    restoreBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.style.display = 'none';
      document.body.appendChild(input);

      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) return;

        // Validate file size
        if (file.size > 50 * 1024 * 1024) {
          alert('❌ حجم الملف كبير جداً (الحد: 50MB)');
          return;
        }

        try {
          const text = await file.text();
          let backup;
          try { backup = JSON.parse(text); }
          catch { alert('❌ الملف غير صالح — ليس بصيغة JSON'); return; }

          if (!backup?.system?.version || !backup?.tables) {
            alert('❌ الملف ليس نسخة احتياطية صالحة من نظام Karta');
            return;
          }

          const tableCount = Object.keys(backup.tables).length;
          let totalRows = 0;
          for (const t of Object.values(backup.tables)) {
            if (Array.isArray(t)) totalRows += t.length;
          }
          const backupDate = backup.system.created_at || 'غير معروف';

          const msg =
            '⚠️ هل أنت متأكد من استعادة هذه النسخة الاحتياطية؟\n\n' +
            '📅 تاريخ النسخة: ' + backupDate + '\n' +
            '📦 عدد الجداول: ' + tableCount + '\n' +
            '📊 عدد السجلات: ' + totalRows + '\n\n' +
            '⚠️ سيتم حذف جميع البيانات الحالية واستبدالها بالنسخة الاحتياطية.\n' +
            '⚠️ هذه العملية لا يمكن التراجع عنها!\n\n' +
            'هل تريد المتابعة؟';

          if (!confirm(msg)) return;
          if (!confirm('⚠️ تأكيد نهائي: سيتم حذف جميع البيانات الحالية. هل أنت متأكد؟')) return;

          restoreBtn.disabled = true;
          restoreBtn.textContent = '⏳ جاري الاستعادة...';

          const res = await fetch(API_CONFIG.BASE_URL + '/backup/restore.php', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: text,
          });

          const result = await res.json();
          if (result.success) {
            alert('✅ ' + (result.message || 'تم استعادة النسخة الاحتياطية بنجاح') +
                  '\n\nسيتم إعادة تحميل الصفحة...');
            window.location.reload();
          } else {
            alert('❌ ' + (result.message || 'فشل استعادة النسخة الاحتياطية'));
          }
        } catch (err) {
          alert('❌ ' + (err.message || 'حدث خطأ أثناء الاستعادة'));
        } finally {
          restoreBtn.disabled = false;
          restoreBtn.textContent = '📥 استعادة';
        }
      });

      input.click();
    });
  }
}

// Initialize after DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(_initMySQLBackup, 300));
} else {
  setTimeout(_initMySQLBackup, 300);
}

