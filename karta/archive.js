/**
 * archive.js — Archive Management Page
 */

import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { openArchiveViewer, attachArchiveViewerListeners } from './archiveViewer.js';
import { DateUtils } from './dateUtils.js';
import { ArchiveService } from './services/archiveService.js';

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _username() {
  return AuthModule.getSession()?.username || '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

const STATE = {
  shellRendered: false,
  loading: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Render
// ═══════════════════════════════════════════════════════════════════════════════

function _renderShell() {
  const page = document.getElementById('archivePage');
  if (!page) return;
  if (STATE.shellRendered && page.querySelector('#archiveBatchesList')) return;

  page.innerHTML = `
    <div class="p-6 card">
      <div class="card-header mb-4">
        <h2 class="card-title mb-0">📦 إدارة الأرشيف</h2>
        <p style="color:#6b7280;font-size:0.875rem;margin:4px 0 0;">أرشفة العمليات القديمة مع الحفاظ على الأرصدة</p>
      </div>

      <!-- Create Archive -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:24px;">
        <h3 style="font-size:1rem;font-weight:700;margin:0 0 16px;color:#1f2937;">إنشاء أرشيف جديد</h3>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;">
          <div>
            <label style="display:block;font-size:0.75rem;color:#6b7280;margin-bottom:4px;font-weight:700;">من تاريخ</label>
            <input id="archiveFromDate" type="date" class="input input-sm" />
          </div>
          <div>
            <label style="display:block;font-size:0.75rem;color:#6b7280;margin-bottom:4px;font-weight:700;">إلى تاريخ</label>
            <input id="archiveToDate" type="date" class="input input-sm" />
          </div>
          <button type="button" data-action="archive-preview" class="btn btn-secondary btn-sm">👁️ معاينة</button>
          <button type="button" data-action="archive-execute" class="btn btn-primary btn-sm">📦 تنفيذ الأرشفة</button>
        </div>
        <div id="archivePreviewResult" style="margin-top:12px;"></div>
      </div>

      <!-- Batches List -->
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 12px;color:#1f2937;">الأرشيفات السابقة</h3>
      <div id="archiveBatchesList"></div>
    </div>
  `;

  STATE.shellRendered = true;
}

async function _renderBatches() {
  const container = document.getElementById('archiveBatchesList');
  if (!container) return;

  const batches = await ArchiveService.getAllBatchesHistory(_username());

  if (!batches.length) {
    container.innerHTML = '<div style="text-align:center;padding:24px;color:#9ca3af;">لا توجد أرشيفات سابقة</div>';
    return;
  }

  container.innerHTML = batches.map(b => {
    const isArchived = b.status === 'archived' || b.status === 'active';
    const isRestored = b.status === 'restored';
    const version = Number(b.archive_version) || 1;

    const statusBadge = isArchived
      ? '<span style="background:#dcfce7;color:#16a34a;padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:700;">مؤرشف</span>'
      : '<span style="background:#fef3c7;color:#a16207;padding:2px 10px;border-radius:999px;font-size:0.75rem;font-weight:700;">مستعاد</span>';

    const versionBadge = version > 1
      ? `<span style="background:#eff6ff;color:#2563eb;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;margin-right:6px;">v${version}</span>`
      : '';

    const metaLine = [
      `تم بتاريخ: ${_esc(b.archived_at?.split('T')[0] || '—')}`,
      b.restored_at ? `استعادة: ${_esc(b.restored_at.split('T')[0])}` : '',
      b.last_rearchived_at ? `إعادة أرشفة: ${_esc(b.last_rearchived_at.split('T')[0])}` : '',
      b.notes || '',
    ].filter(Boolean).join(' — ');

    return `
      <div style="background:#fff;border:1px solid ${isRestored ? '#fbbf24' : '#e2e8f0'};border-radius:12px;padding:16px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-weight:700;color:#1f2937;margin-bottom:4px;">
            ${_esc(b.from_date)} → ${_esc(b.to_date)} ${statusBadge} ${versionBadge}
          </div>
          <div style="font-size:0.8125rem;color:#6b7280;">
            ${metaLine}
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" data-action="archive-view" data-id="${b.id}" class="btn btn-primary btn-sm">📖 استعراض</button>
          ${isArchived ? `<button type="button" data-action="archive-restore" data-id="${b.id}" class="btn btn-secondary btn-sm">♻️ استعادة</button>` : ''}
          ${isRestored ? `<button type="button" data-action="archive-rearchive" data-id="${b.id}" class="btn btn-success btn-sm">📦 إعادة الأرشفة</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════════════════════

async function _handlePreview() {
  const from = document.getElementById('archiveFromDate')?.value || '';
  const to = document.getElementById('archiveToDate')?.value || '';
  const container = document.getElementById('archivePreviewResult');
  if (!container) return;

  if (!from || !to) {
    container.innerHTML = '<p style="color:#dc2626;font-size:0.875rem;">⚠️ حدد تاريخ البداية والنهاية</p>';
    return;
  }

  container.innerHTML = '<p style="color:#6b7280;">جاري المعاينة...</p>';

  try {
    const preview = await ArchiveService.previewArchive(_username(), from, to);
    const storeLabels = {
      treasury: 'الخزنة',
      vehicle_ledger: 'دفتر الحسابات',
      receipts: 'النماذج',
      mainCapitalTreasury: 'رأس المال',
    };

    const rows = Object.entries(preview.counts)
      .filter(([, count]) => count > 0)
      .map(([store, count]) => `<span style="background:#eff6ff;color:#2563eb;padding:3px 10px;border-radius:8px;font-size:0.8125rem;font-weight:600;">${storeLabels[store] || store}: ${count}</span>`)
      .join(' ');

    container.innerHTML = `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;">
        <p style="font-weight:700;color:#16a34a;margin:0 0 8px;">إجمالي السجلات: ${preview.total}</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${rows || '<span style="color:#6b7280;">لا توجد سجلات في هذه الفترة</span>'}</div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<p style="color:#dc2626;">❌ ${_esc(err.message)}</p>`;
  }
}

let _isArchiving = false;

async function _handleExecute() {
  if (_isArchiving) return;
  const from = document.getElementById('archiveFromDate')?.value || '';
  const to = document.getElementById('archiveToDate')?.value || '';

  if (!from || !to) { alert('⚠️ حدد تاريخ البداية والنهاية'); return; }
  if (!confirm(`هل تريد أرشفة جميع العمليات من ${from} إلى ${to}؟\n\nسيتم حفظ لقطة مالية واستبعاد هذه العمليات من العرض اليومي.`)) return;

  _isArchiving = true;
  try {
    const result = await ArchiveService.createArchive(_username(), from, to);
    alert(`✅ تم الأرشفة بنجاح\nعدد السجلات: ${result.recordsArchived}`);
    await _renderBatches();
    window.dispatchEvent(new CustomEvent('treasury:changed'));
    window.dispatchEvent(new CustomEvent('receipts:changed'));
  } catch (err) {
    alert('❌ ' + (err.message || 'حدث خطأ'));
  } finally {
    _isArchiving = false;
  }
}

async function _handleReArchive(batchId) {
  if (_isArchiving) return;
  if (!confirm('هل تريد إعادة أرشفة هذه الفترة؟\n\nسيتم إعادة حساب اللقطة المالية وأرشفة جميع السجلات في نفس الفترة.')) return;

  _isArchiving = true;
  try {
    const result = await ArchiveService.reArchive(_username(), batchId);
    alert(`✅ تمت إعادة الأرشفة بنجاح\nالإصدار: ${result.version}\nعدد السجلات: ${result.recordsArchived}`);
    await _renderBatches();
    window.dispatchEvent(new CustomEvent('treasury:changed'));
    window.dispatchEvent(new CustomEvent('receipts:changed'));
  } catch (err) {
    alert('❌ ' + (err.message || 'حدث خطأ'));
  } finally {
    _isArchiving = false;
  }
}

async function _handleRestore(batchId) {
  if (_isArchiving) return;
  if (!confirm('هل تريد استعادة هذا الأرشيف؟\nسيتم إعادة جميع السجلات للعرض اليومي.')) return;

  _isArchiving = true;
  try {
    const result = await ArchiveService.restoreArchive(_username(), batchId);
    alert(`✅ تمت الاستعادة بنجاح\nعدد السجلات: ${result.recordsRestored}`);
    await _renderBatches();
    window.dispatchEvent(new CustomEvent('treasury:changed'));
    window.dispatchEvent(new CustomEvent('receipts:changed'));
  } catch (err) {
    alert('❌ ' + (err.message || 'حدث خطأ'));
  } finally {
    _isArchiving = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════════════════════

let _bound = false;

function _attachListeners() {
  if (_bound) return;
  _bound = true;

  document.addEventListener('click', async (e) => {
    const root = e.target.closest('#archivePage');
    if (!root) return;

    if (e.target.closest('[data-action="archive-preview"]')) {
      await _handlePreview();
      return;
    }
    if (e.target.closest('[data-action="archive-execute"]')) {
      await _handleExecute();
      return;
    }
    const viewBtn = e.target.closest('[data-action="archive-view"]');
    if (viewBtn) {
      await openArchiveViewer(viewBtn.dataset.id);
      return;
    }
    const restoreBtn = e.target.closest('[data-action="archive-restore"]');
    if (restoreBtn) {
      await _handleRestore(restoreBtn.dataset.id);
      return;
    }
    const rearchiveBtn = e.target.closest('[data-action="archive-rearchive"]');
    if (rearchiveBtn) {
      await _handleReArchive(rearchiveBtn.dataset.id);
      return;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════════

async function initArchivePage() {
  _renderShell();
  _attachListeners();
  attachArchiveViewerListeners();
  await _renderBatches();
}

export { initArchivePage };
