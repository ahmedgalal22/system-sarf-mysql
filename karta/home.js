/**
 * home.js — الصفحة الرئيسية
 */

function _render() {
  const page = document.getElementById('homePage');
  if (!page) return;

  page.innerHTML = `
    <!-- بطاقة الترحيب -->
    <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;margin-bottom:20px;">
      <h2 style="font-size:1.75rem;font-weight:800;color:#1f2937;margin:0 0 6px;">مرحباً بك في نظام Karta</h2>
      <p style="color:#4b5563;font-size:0.9375rem;margin:0 0 20px;">نظام شامل لإدارة الكارتات وأصحاب المركبات والمكاتب</p>
    </div>

    <!-- البطاقتان السفليتان -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

      <!-- مميزات النظام -->
      <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;">
        <h3 style="font-size:1.25rem;font-weight:700;color:#1f2937;margin:0 0 16px;">مميزات النظام</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${_featureItem('إدارة شاملة لأصحاب المركبات والمكاتب')}
          ${_featureItem('نموذج صرف احترافي مع حسابات تلقائية')}
          ${_featureItem('تتبع المديونيات والمدفوعات')}
          ${_featureItem('طباعة احترافية لجميع التقارير')}
          ${_featureItem('حفظ تلقائي للبيانات')}
          ${_featureItem('متوافق مع جميع الأجهزة')}
        </div>
      </div>

      <!-- البدء السريع -->
      <div style="background:#fff;border-radius:16px;box-shadow:0 4px 16px rgba(0,0,0,0.08);padding:24px;">
        <h3 style="font-size:1.25rem;font-weight:700;color:#1f2937;margin:0 0 16px;">البدء السريع</h3>
        <div style="display:flex;flex-direction:column;gap:12px;">
          ${_stepItem(1, 'أضف أصحاب المركبات', 'ابدأ بإضافة بيانات أصحاب المركبات', '#3b82f6', '#eff6ff', 'ownersPage')}
          ${_stepItem(2, 'أضف المكاتب', 'سجل بيانات المكاتب التي تتعامل معها', '#22c55e', '#f0fdf4', 'officesPage')}
          ${_stepItem(3, 'أنشئ نماذج الصرف', 'قم بإنشاء وإدارة نماذج الصرف', '#7c3aed', '#f5f3ff', 'receipt')}
        </div>
      </div>

    </div>
  `;
}

function _featureItem(text) {
  return `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="color:#22c55e;font-size:1.125rem;font-weight:700;flex-shrink:0;line-height:1.4;">✓</span>
      <span style="color:#374151;font-size:0.875rem;line-height:1.6;">${text}</span>
    </div>`;
}

function _stepItem(num, title, desc, circleColor, bgColor, pageName) {
  return `
    <div data-action="home-navigate" data-page="${pageName}" style="background:${bgColor};border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:box-shadow 0.2s,transform 0.2s;" onmouseover="this.style.boxShadow='0 4px 12px rgba(0,0,0,0.1)';this.style.transform='translateY(-1px)'" onmouseout="this.style.boxShadow='';this.style.transform=''">
      <div style="width:32px;height:32px;border-radius:50%;background:${circleColor};color:#fff;font-weight:700;font-size:0.875rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${num}</div>
      <div>
        <p style="font-weight:700;color:#1f2937;margin:0;font-size:0.9375rem;">${title}</p>
        <p style="color:#6b7280;margin:2px 0 0;font-size:0.8125rem;">${desc}</p>
      </div>
    </div>`;
}

let _bound = false;

function initHomePage() {
  if (!_bound) {
    _bound = true;
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-action="home-navigate"]');
      if (nav && typeof window.showPage === 'function') {
        window.showPage(nav.dataset.page);
      }
    });
  }

  _render();
}

export { initHomePage };
