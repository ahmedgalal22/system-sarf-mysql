/**
 * terms.js — صفحة شروط الاستخدام ونافذة التواصل مع المطور
 */

const TERMS_LAST_UPDATED = '22 أكتوبر 2026';

export function buildTermsPageHtml() {
  return `
    <div class="terms-page-container">
      <!-- ترويسة الصفحة -->
      <div class="card terms-hero-card">
        <div class="terms-hero-header">
          <div class="terms-hero-title-group">
            <div class="terms-hero-icon" aria-hidden="true">
              <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
              </svg>
            </div>
            <div>
              <h2 class="terms-page-title">شروط وأحكام استخدام النظام</h2>
              <p class="terms-page-subtitle">يرجى قراءة البنود التالية المنظمة لاستخدام نظام Karta ERP</p>
            </div>
          </div>
          <button
            id="openDeveloperContactBtn"
            type="button"
            data-action="open-developer-contact"
            class="btn btn-primary terms-contact-btn"
            aria-haspopup="dialog"
            aria-controls="developerContactModal"
          >
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
            </svg>
            <span>للتواصل مع المطور</span>
          </button>
        </div>
      </div>

      <!-- أقسام شروط الاستخدام -->
      <div class="terms-sections-grid">
        <article class="card terms-section-card">
          <h3 class="terms-section-title">1. الملكية الفكرية وحقوق الاستخدام</h3>
          <ul class="terms-list">
            <li>تظل حقوق ملكية النظام وبرمجته وتصميمه وتطويره للمطور.</li>
            <li>يحصل المستخدم على حق استخدام النظام داخل نشاطه التجاري المتفق عليه.</li>
            <li>لا تنتقل ملكية النظام أو حقوقه البرمجية إلى المستخدم بمجرد شراء النظام أو استخدامه.</li>
          </ul>
        </article>

        <article class="card terms-section-card">
          <h3 class="terms-section-title">2. نطاق الاستخدام ونقل النظام</h3>
          <ul class="terms-list">
            <li>يخصص النظام للاستخدام داخل النشاط التجاري المتفق عليه مع المطور.</li>
            <li>في حالة الرغبة في نقل النظام إلى جهاز آخر، يجب التنسيق مع المطور والحصول على موافقته قبل النقل.</li>
            <li>في حالة تلف جهاز التشغيل أو تعذر استخدامه، يمكن للمستخدم التواصل مع المطور لترتيب نقل النظام واستعادة البيانات وفق الإمكانيات المتاحة.</li>
          </ul>
        </article>

        <article class="card terms-section-card">
          <h3 class="terms-section-title">3. مسؤولية البيانات والنسخ الاحتياطي</h3>
          <ul class="terms-list">
            <li>بيانات النشاط التجاري التي يدخلها المستخدم تخص المستخدم.</li>
            <li>يعمل النظام محلياً على جهاز المستخدم، ولذلك يتحمل المستخدم مسؤولية الاحتفاظ بنسخ احتياطية دورية من قاعدة البيانات.</li>
            <li>يُنصح بحفظ النسخ الاحتياطية على وحدة تخزين خارجية أو وسيط مستقل عن جهاز التشغيل.</li>
            <li>لا يضمن المطور إمكانية استعادة البيانات في حالة تلف الجهاز أو وحدة التخزين دون وجود نسخة احتياطية سليمة.</li>
            <li>لا يتحمل المطور مسؤولية فقدان البيانات الناتج عن أعطال الأجهزة أو الكهرباء أو الحذف من قبل المستخدم أو الاستخدام غير الصحيح، في حدود ما يسمح به القانون.</li>
          </ul>
        </article>

        <article class="card terms-section-card">
          <h3 class="terms-section-title">4. الضمان</h3>
          <ul class="terms-list">
            <li>يضمن المطور أن النظام يعمل بصورة طبيعية وفق الوظائف المتفق عليها.</li>
            <li>في حالة توقف النظام بالكامل وعدم قدرة المطور على إصلاحه أو إعادة تشغيله خلال مدة المعالجة التي يحددها، يحق للمستخدم استرداد كامل المبلغ المدفوع مقابل النظام، وهذه هي الحالة التي ينطبق عليها هذا الاسترداد.</li>
            <li>لا يشمل الضمان أعطال الأجهزة، أو مشاكل الكهرباء، أو حذف البيانات من قبل المستخدم، أو الاستخدام غير الصحيح.</li>
          </ul>
        </article>

        <article class="card terms-section-card">
          <h3 class="terms-section-title">5. التعديلات والتطوير والدعم</h3>
          <ul class="terms-list">
            <li>أي تطويرات أو إضافات أو تعديلات أو خدمات دعم مستقبلية غير مشمولة في الاتفاق الأصلي، ويتم الاتفاق عليها بشكل منفصل.</li>
          </ul>
        </article>

        <article class="card terms-section-card">
          <h3 class="terms-section-title">6. ملكية البيانات والسرية</h3>
          <ul class="terms-list">
            <li>بيانات النشاط التجاري التي يدخلها المستخدم في النظام تخص المستخدم.</li>
            <li>يتعامل المطور مع البيانات التي قد يطلع عليها أثناء تقديم الدعم الفني بالقدر اللازم لتقديم الخدمة، مع مراعاة المحافظة على سريتها وعدم استخدامها لأغراض أخرى إلا بموافقة المستخدم أو وفق ما يسمح به القانون.</li>
          </ul>
        </article>
      </div>

      <!-- تذييل الصفحة وتاريخ آخر تحديث -->
      <div class="card terms-footer-card">
        <span class="terms-last-updated">تاريخ آخر تحديث: ${TERMS_LAST_UPDATED}</span>
      </div>

      <!-- نافذة التواصل مع المطور -->
      <div
        id="developerContactModal"
        class="modal-overlay hidden"
        role="dialog"
        aria-modal="true"
        aria-labelledby="developerContactModalTitle"
        aria-hidden="true"
      >
        <div class="modal terms-contact-modal">
          <div class="modal-header modal-header--purple">
            <h3 id="developerContactModalTitle" class="modal-header__title" style="font-size:1.125rem;">للتواصل مع المطور</h3>
            <button
              id="closeDeveloperContactIconBtn"
              type="button"
              data-action="close-developer-contact"
              class="modal-close"
              aria-label="إغلاق"
              title="إغلاق"
            >
              <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
              </svg>
            </button>
          </div>
          <div class="modal-body terms-contact-modal__body">
            <div class="terms-contact-item">
              <span class="terms-contact-label">اسم المطور:</span>
              <strong class="terms-contact-value">أحمد جلال خضر</strong>
            </div>
            <div class="terms-contact-item">
              <span class="terms-contact-label">رقم الهاتف:</span>
              <a href="tel:01014580684" class="terms-contact-phone" dir="ltr">01014580684</a>
            </div>
            <div class="terms-contact-item">
              <span class="terms-contact-label">رقم الهاتف:</span>
              <a href="tel:01558999210" class="terms-contact-phone" dir="ltr">01558999210</a>
            </div>
          </div>
          <div class="modal-footer">
            <button
              id="closeDeveloperContactBtn"
              type="button"
              data-action="close-developer-contact"
              class="btn btn-secondary"
            >
              إغلاق
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function openDeveloperContactModal() {
  const modal = document.getElementById('developerContactModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

export function closeDeveloperContactModal() {
  const modal = document.getElementById('developerContactModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

let _termsListenersBound = false;

export function initTermsPage() {
  const page = document.getElementById('termsPage');
  if (!page) return;

  if (!page.querySelector('#developerContactModal')) {
    page.innerHTML = buildTermsPageHtml();
  }

  if (!_termsListenersBound) {
    _termsListenersBound = true;

    document.addEventListener('click', (e) => {
      const target = e.target;
      if (!target || typeof target.closest !== 'function') return;

      if (target.closest('[data-action="open-developer-contact"]')) {
        openDeveloperContactModal();
        return;
      }

      if (target.closest('[data-action="close-developer-contact"]')) {
        closeDeveloperContactModal();
        return;
      }

      if (target.id === 'developerContactModal') {
        closeDeveloperContactModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('developerContactModal');
        if (modal && !modal.classList.contains('hidden')) {
          closeDeveloperContactModal();
        }
      }
    });
  }
}
