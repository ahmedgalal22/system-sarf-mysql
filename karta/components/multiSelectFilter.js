/**
 * MultiSelectFilter — Excel-style searchable multi-select dropdown.
 *
 * A reusable, standalone UI component. Has ZERO knowledge of receipts,
 * search APIs, or any domain logic. Communicates exclusively via:
 *   - Constructor options (label, key, options, selected, onConfirm)
 *   - Public methods (setOptions, setSelected, getSelected, destroy)
 *
 * ─── BEHAVIOR ──────────────────────────────────────────────────────────
 *   Open popup   → checkbox list populated from options, pre-checked
 *                  from current selection
 *   Search box   → filters checkbox list in real-time (client-side)
 *   Check/uncheck → updates TEMPORARY state, does NOT fire onConfirm
 *   Select All   → checks all VISIBLE items (respecting search query)
 *   OK (تم)      → commits selection, fires onConfirm(values), closes
 *   Cancel (إلغاء) → discards changes, closes, selection unchanged
 *   Clear (مسح)  → clears all selections, commits immediately,
 *                   fires onConfirm([]), closes
 *   Click outside → same as Cancel
 *   Escape key   → same as Cancel
 * ────────────────────────────────────────────────────────────────────────
 */

// Global: only one popup open at a time across all instances
let _activePopup = null;

export class MultiSelectFilter {

  /**
   * @param {object} config
   * @param {HTMLElement}  config.container   — parent element to mount into
   * @param {string}       config.label       — display label (e.g. "العميل")
   * @param {string}       config.key         — unique key for data attributes
   * @param {string[]}     config.options     — available values
   * @param {string[]}     config.selected    — initially selected values
   * @param {function}     config.onConfirm   — callback(selectedValues: string[])
   * @param {boolean}      [config.rtl=true]  — RTL layout
   */
  constructor(config) {
    this._container  = config.container;
    this._label      = config.label || '';
    this._key        = config.key || '';
    this._options    = Array.isArray(config.options) ? config.options.map(v => String(v ?? '')).filter(Boolean) : [];
    this._selected   = new Set(Array.isArray(config.selected) ? config.selected : []);
    this._onConfirm  = typeof config.onConfirm === 'function' ? config.onConfirm : () => {};
    this._rtl        = config.rtl !== false;

    // Temporary selection state (only committed on OK)
    this._tempSelected = new Set(this._selected);
    this._searchQuery  = '';
    this._isOpen       = false;

    // DOM references
    this._triggerEl = null;
    this._popupEl   = null;

    // Bound handlers (for cleanup)
    this._onDocMouseDown = this._handleDocMouseDown.bind(this);
    this._onDocKeyDown   = this._handleDocKeyDown.bind(this);

    this._render();
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────

  /** Replace the available options list. Preserves selected values that still exist. */
  setOptions(options) {
    this._options = Array.isArray(options) ? options.map(v => String(v ?? '')).filter(Boolean) : [];
    // Intersect: keep only selected values that exist in new options
    const optSet = new Set(this._options);
    const newSelected = new Set();
    for (const v of this._selected) {
      if (optSet.has(v)) newSelected.add(v);
    }
    this._selected = newSelected;
    this._updateTriggerText();
    // If popup is open, re-render the list
    if (this._isOpen) this._renderList();
  }

  /** Set the selected values externally. */
  setSelected(values) {
    this._selected = new Set(Array.isArray(values) ? values : []);
    this._tempSelected = new Set(this._selected);
    this._updateTriggerText();
    if (this._isOpen) this._renderList();
  }

  /** Get the current confirmed selected values. */
  getSelected() {
    return [...this._selected];
  }

  /** Remove component from DOM and clean up all listeners. */
  destroy() {
    this._closePopup();
    if (this._triggerEl) {
      this._triggerEl.removeEventListener('click', this._triggerClickHandler);
      this._triggerEl.remove();
    }
    this._triggerEl = null;
    this._popupEl  = null;
  }

  // ── RENDERING ─────────────────────────────────────────────────────────

  _render() {
    // Trigger button
    this._triggerEl = document.createElement('button');
    this._triggerEl.type = 'button';
    this._triggerEl.className = 'ms-filter-trigger';
    this._triggerEl.dataset.msKey = this._key;
    this._triggerClickHandler = () => this._toggle();
    this._triggerEl.addEventListener('click', this._triggerClickHandler);
    this._updateTriggerText();
    this._container.appendChild(this._triggerEl);
  }

  _updateTriggerText() {
    if (!this._triggerEl) return;
    const count = this._selected.size;
    if (count === 0) {
      this._triggerEl.textContent = this._label;
      this._triggerEl.classList.remove('ms-filter-trigger--active');
    } else {
      this._triggerEl.textContent = `${this._label} (${count})`;
      this._triggerEl.classList.add('ms-filter-trigger--active');
    }
  }

  _toggle() {
    if (this._isOpen) {
      this._cancel();
    } else {
      this._openPopup();
    }
  }

  // ── POPUP LIFECYCLE ───────────────────────────────────────────────────

  _openPopup() {
    // Close any other open popup
    if (_activePopup && _activePopup !== this) {
      _activePopup._cancel();
    }

    // Snapshot current selection as temp (changes are discarded on cancel)
    this._tempSelected = new Set(this._selected);
    this._searchQuery = '';
    this._isOpen = true;
    _activePopup = this;

    // Build popup DOM
    this._popupEl = document.createElement('div');
    this._popupEl.className = 'ms-filter-popup';
    if (this._rtl) this._popupEl.dir = 'rtl';
    this._popupEl.dataset.msKey = this._key;

    this._popupEl.innerHTML = `
      <div class="ms-filter-search-wrap">
        <input type="text" class="ms-filter-search" placeholder="بحث..." autocomplete="off" />
      </div>
      <label class="ms-filter-select-all">
        <input type="checkbox" />
        <span>تحديد الكل</span>
      </label>
      <div class="ms-filter-list"></div>
      <div class="ms-filter-actions">
        <button type="button" class="ms-filter-btn ms-filter-btn--clear">مسح</button>
        <button type="button" class="ms-filter-btn ms-filter-btn--cancel">إلغاء</button>
        <button type="button" class="ms-filter-btn ms-filter-btn--ok">تم</button>
      </div>
    `;

    // Event delegation inside popup
    this._popupEl.addEventListener('click', (e) => {
      if (e.target.closest('.ms-filter-btn--ok'))     { this._confirm(); return; }
      if (e.target.closest('.ms-filter-btn--cancel')) { this._cancel();  return; }
      if (e.target.closest('.ms-filter-btn--clear'))  { this._clearAndConfirm(); return; }
    });

    // Search input
    const searchInput = this._popupEl.querySelector('.ms-filter-search');
    searchInput.addEventListener('input', () => {
      this._searchQuery = searchInput.value.trim().toLowerCase();
      this._renderList();
    });

    // Select All checkbox
    const selectAllCb = this._popupEl.querySelector('.ms-filter-select-all input');
    selectAllCb.addEventListener('change', () => {
      if (selectAllCb.checked) {
        this._selectAllVisible();
      } else {
        this._deselectAllVisible();
      }
    });

    // Checkbox change delegation on the list
    const listEl = this._popupEl.querySelector('.ms-filter-list');
    listEl.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const value = cb.dataset.value;
      if (value === undefined) return;
      if (cb.checked) {
        this._tempSelected.add(value);
      } else {
        this._tempSelected.delete(value);
      }
      this._updateSelectAllState();
    });

    // Always position below trigger
    this._container.appendChild(this._popupEl);

    // Render checkbox list
    this._renderList();

    // Global listeners for close-on-outside / escape
    document.addEventListener('mousedown', this._onDocMouseDown, true);
    document.addEventListener('keydown', this._onDocKeyDown, true);

    // Focus search input
    requestAnimationFrame(() => searchInput.focus());
  }

  _closePopup() {
    if (!this._isOpen) return;
    this._isOpen = false;
    if (_activePopup === this) _activePopup = null;

    document.removeEventListener('mousedown', this._onDocMouseDown, true);
    document.removeEventListener('keydown', this._onDocKeyDown, true);

    if (this._popupEl) {
      this._popupEl.remove();
      this._popupEl = null;
    }
  }

  // ── LIST RENDERING ────────────────────────────────────────────────────

  _renderList() {
    const listEl = this._popupEl?.querySelector('.ms-filter-list');
    if (!listEl) return;

    const query = this._searchQuery;
    const visible = query
      ? this._options.filter(v => v.toLowerCase().includes(query))
      : this._options;

    // Cap at 500 to prevent DOM explosion
    const capped = visible.length > 500;
    const renderItems = capped ? visible.slice(0, 500) : visible;

    const html = renderItems.map(value => {
      const checked = this._tempSelected.has(value) ? 'checked' : '';
      const escaped = _esc(value);
      return `<label class="ms-filter-item">
        <input type="checkbox" data-value="${escaped}" ${checked} />
        <span>${escaped}</span>
      </label>`;
    }).join('');

    const capNotice = capped
      ? `<div class="ms-filter-cap-notice">يُعرض ${renderItems.length} من ${visible.length} — استخدم البحث للتضييق</div>`
      : '';

    listEl.innerHTML = html + capNotice;
    this._updateSelectAllState();
  }

  _updateSelectAllState() {
    const selectAllCb = this._popupEl?.querySelector('.ms-filter-select-all input');
    if (!selectAllCb) return;

    const query = this._searchQuery;
    const visible = query
      ? this._options.filter(v => v.toLowerCase().includes(query))
      : this._options;

    if (visible.length === 0) {
      selectAllCb.checked = false;
      selectAllCb.indeterminate = false;
      return;
    }

    const allChecked = visible.every(v => this._tempSelected.has(v));
    const someChecked = visible.some(v => this._tempSelected.has(v));
    selectAllCb.checked = allChecked;
    selectAllCb.indeterminate = !allChecked && someChecked;
  }

  // ── ACTIONS ───────────────────────────────────────────────────────────

  _selectAllVisible() {
    const query = this._searchQuery;
    const visible = query
      ? this._options.filter(v => v.toLowerCase().includes(query))
      : this._options;
    for (const v of visible) this._tempSelected.add(v);
    this._renderList();
  }

  _deselectAllVisible() {
    const query = this._searchQuery;
    const visible = query
      ? this._options.filter(v => v.toLowerCase().includes(query))
      : this._options;
    for (const v of visible) this._tempSelected.delete(v);
    this._renderList();
  }

  /** Clear all selections AND immediately commit (fires onConfirm, closes popup). */
  _clearAndConfirm() {
    this._selected = new Set();
    this._tempSelected = new Set();
    this._updateTriggerText();
    this._closePopup();
    this._onConfirm([]);
  }

  _confirm() {
    this._selected = new Set(this._tempSelected);
    this._updateTriggerText();
    this._closePopup();
    this._onConfirm([...this._selected]);
  }

  _cancel() {
    // Discard temp — revert to committed selection
    this._tempSelected = new Set(this._selected);
    this._closePopup();
  }

  // ── GLOBAL EVENT HANDLERS ─────────────────────────────────────────────

  _handleDocMouseDown(e) {
    if (!this._isOpen) return;
    // Click inside popup or trigger → ignore
    if (this._popupEl?.contains(e.target)) return;
    if (this._triggerEl?.contains(e.target)) return;
    this._cancel();
  }

  _handleDocKeyDown(e) {
    if (!this._isOpen) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      this._cancel();
    }
  }
}

// ── Utility ───────────────────────────────────────────────────────────────

function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
