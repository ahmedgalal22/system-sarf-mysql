# Bolsa Separation Migration Plan
## Extracting Bolsa Forms Into an Independent Page

**Date:** 2026-07-15  
**Type:** Architecture Planning Only — No Code  
**Scope:** Separate the Bolsa tab from All Receipts into its own standalone page

---

## 1. Current Architecture

### Where the Bolsa Tab Exists

The Bolsa tab is embedded inside `allReceipts.js` as the second tab of a two-tab view. The page `allReceiptsPage` contains:

- **Tab 1:** الكارتات (Receipts) — receipt cards with filters, summary, print, export
- **Tab 2:** تفريغ البوالص (Bolsa Forms) — bolsa cards with filters, summary, print

Both tabs share a single `STATE` object, a single data loading function (`loadReceiptsData`), a single event handler system (`bindPageEvents`), and a single initialization function (`initAllReceiptsPage`).

### Where the Tab Is Created

`renderShell()` (line 661) generates the HTML for both tabs:
```html
<button data-tab="receipts">📋 الكارتات</button>
<button data-tab="bolsas">📦 تفريغ البوالص</button>
```

The bolsa panel is created at line 692:
```html
<section class="all-panel hidden" data-panel="bolsas">
    ${renderBolsasControls()}
    <div id="bolsasSummaryContainer"></div>
    <div id="bolsasList" class="all-list"></div>
</section>
```

### How It Is Rendered

`renderBolsaList()` (line 1038) builds card HTML for each bolsa record via `innerHTML` into `#bolsasList`. Each card is an `<article class="record-card bolsa-record">` with emerald theme styling.

### Files That Participate

| File | Role |
|---|---|
| `allReceipts.js` | Contains all bolsa listing logic: state, loading, filtering, rendering, print, actions |
| `bolsas.js` | Contains bolsa FORM page (create/edit form) — separate from the listing |
| `financial.js` | `FinancialService.createBolsaForm`, `updateBolsaForm`, `deleteBolsaForm`, `getBolsaForms` |
| `services/receiptRepository.js` | (Indirectly — bolsa uses `ReceiptsModule.getBolsaForms`) |
| `services/clientRepository.js` | `ClientRepository.getAgents` — used by `_enrichBolsasWithAgentName` |
| `services/domainRegistry.js` | `bolsaForms` domain registration |
| `services/syncService.js` | `bolsa_forms` → `bolsaForms:changed` event mapping |
| `repositories/BolsaFormRepository.php` | PHP data access layer |
| `api/entities/bolsa-forms/{list,get,create,update,delete}.php` | CRUD endpoints |
| `api/financial/bolsa-{create,update,delete}.php` | Financial operation endpoints |
| `styles.css` | `.summary-grid--bolsas`, `.record-card__header--emerald`, `.record-card__footer--emerald`, `.record-table--emerald`, `.apply-btn--bolsas`, `.bolsa-filters`, `.all-tab[data-tab="bolsas"]` |
| `printEngine.js` | `printHTML` (shared print infrastructure) |
| `money.js` | `Money.fmt`, `Money.fmtCents` (shared formatting) |
| `dateUtils.js` | `DateUtils.toLocalDate` (shared date utility) |

---

## 2. Bolsa Responsibilities

Every responsibility currently owned by the Bolsa tab inside `allReceipts.js`:

| # | Responsibility | Function(s) |
|---|---|---|
| 1 | **State initialization** | `createBolsaFilterState()` — creates `STATE.filters.bolsas` |
| 2 | **Data loading** | `loadReceiptsData()` calls `ReceiptsModule.getBolsaForms()` in parallel with receipt loading |
| 3 | **Agent name enrichment** | `_enrichBolsasWithAgentName()` — resolves `agent_id` to `agent_name` from agents table |
| 4 | **Client-side filtering** | `getBolsaCardsFiltered()` — filters by date range, specific date, global search, agent, owner, company, vehicle, karta |
| 5 | **Row-level filtering** | `_bolsaRowMatchesFilters()` — filters individual rows within a bolsa card |
| 6 | **Summary computation** | `summarizeBolsas()` — computes weight, count, ohda, dokhan, solar, grand total |
| 7 | **Summary rendering** | `renderSummaryCards('bolsas', ...)` — renders 6 summary cards |
| 8 | **Controls rendering** | `renderBolsasControls()` — renders 6 filter inputs + 3 range buttons + date inputs + apply + print button + 5 datalists |
| 9 | **Card list rendering** | `renderBolsaList()` — renders bolsa cards with row tables |
| 10 | **Datalist population** | `renderDatalists()` — populates 5 bolsa datalists from `STATE.bolsas` |
| 11 | **Single bolsa printing** | `printSingleBolsa()` + `buildBolsaPrintBlock()` — standalone print with own CSS |
| 12 | **Bulk bolsa printing** | `serializeCurrentView('bolsas')` + `printStyles()` — bulk PDF via shared print styles |
| 13 | **Edit action** | `handleCardAction('edit-bolsa')` → `showPage('bolsaPage')` → `loadBolsaForEdit()` |
| 14 | **Delete action** | `handleCardAction('delete-bolsa')` → `FinancialService.deleteBolsaForm()` |
| 15 | **Print action** | `handleCardAction('print-bolsa')` → `printSingleBolsa()` |
| 16 | **Tab switching** | `setActiveTabButtons()` — toggles `is-active` class and `hidden` panels |
| 17 | **Event listening** | `bolsaForms:changed` → `_scheduleAllReceiptsRefresh` → full reload |
| 18 | **Row helper functions** | `getBolsaRows()`, `getBolsaWeight()`, `getBolsaOhda()`, `getBolsaDokhan()` |

---

## 3. Dependency Graph

### Shared Between Receipts and Bolsa

| Category | Shared Item | Used By Receipts | Used By Bolsa |
|---|---|---|---|
| **State** | `STATE` object | `STATE.receipts`, `STATE.meta`, `STATE.options`, `STATE.filters.receipts`, `STATE.tab`, `STATE.ready`, `STATE.loading` | `STATE.bolsas`, `STATE.filters.bolsas`, `STATE.tab` |
| **Data loading** | `loadReceiptsData(mode)` | Loads receipts via `list.php` or `search.php` | Loads bolsas via `getBolsaForms()` (always, in parallel) |
| **Rendering** | `renderAll()` | Calls `getReceiptCardsFiltered()` + `renderSummaryCards('receipts')` + `renderLists()` | Calls `getBolsaCardsFiltered()` + `renderSummaryCards('bolsas')` + `renderLists()` |
| **Rendering** | `renderLists()` | Calls `renderReceiptList()` | Calls `renderBolsaList()` |
| **Rendering** | `renderSummaryCards()` | Receipt branch (uses `summarizeReceipts`) | Bolsa branch (uses `summarizeBolsas`) |
| **Rendering** | `renderShell()` | Creates receipt panel DOM | Creates bolsa panel DOM |
| **Rendering** | `renderDatalists()` | (receipt datalists removed) | Populates bolsa datalists |
| **Events** | `bindPageEvents()` | Handles receipt clicks, inputs, changes | Handles bolsa tab clicks, bolsa filter inputs, bolsa apply button |
| **Events** | `_scheduleAllReceiptsRefresh` | Listens to `receipts:changed` | Listens to `bolsaForms:changed` |
| **Actions** | `handleCardAction()` | Receipt actions (edit, delete, print, status) | Bolsa actions (edit, delete, print) |
| **Print** | `serializeCurrentView(tab)` | Receipt bulk print | Bolsa bulk print |
| **Print** | `printCurrentView(tab)` | Calls `serializeCurrentView` | Same |
| **Print** | `printStyles()` | Receipt bulk print CSS | Bolsa bulk print CSS |
| **Init** | `initAllReceiptsPage()` | Initializes receipt components | Initializes bolsa panel (part of `renderShell`) |
| **Refresh** | `refreshAllReceiptsPage(mode)` | Reloads receipts | Reloads bolsas (always, via `loadReceiptsData`) |
| **Utilities** | `esc()`, `fmtMoney()`, `toNumber()`, `receiptDisplayDate()`, `receiptFullDate()`, `receiptDayName()`, `receiptTime()`, `inRange()`, `normalizeDate()`, `rowContains()`, `setDatalist()`, `summaryCard()`, `setFilterValue()`, `setQuickRange()` | Yes | Yes |
| **Tab** | `setActiveTabButtons()` | Sets receipt tab active state | Sets bolsa tab active state |
| **CSS** | `.all-receipts-*`, `.all-panel`, `.all-tab`, `.all-list`, `.filter-grid`, `.range-toolbar`, `.record-card`, `.summary-grid`, `.summary-card`, `.empty-state` | Yes | Yes |
| **Imports** | `Money`, `DateUtils`, `printHTML`, `FinancialService`, `ClientRepository` | Yes | Yes |

### NOT Shared (Bolsa-Only)

| Item | Details |
|---|---|
| `createBolsaFilterState()` | Only bolsa filter state |
| `getBolsaCardsFiltered()` | Only bolsa filtering |
| `_bolsaRowMatchesFilters()` | Only bolsa row matching |
| `summarizeBolsas()` | Only bolsa summary |
| `getBolsaRows/Weight/Ohda/Dokhan()` | Only bolsa helpers |
| `renderBolsasControls()` | Only bolsa controls HTML |
| `renderBolsaList()` | Only bolsa card rendering |
| `printSingleBolsa()` | Only bolsa single print |
| `buildBolsaPrintBlock()` | Only bolsa print block |
| `_enrichBolsasWithAgentName()` | Only bolsa agent enrichment |
| Emerald CSS classes | Only bolsa styling |

### NOT Shared (Receipt-Only)

| Item | Details |
|---|---|
| All multi-select filter infrastructure | Only receipts |
| `getReceiptCardsFiltered()` | Only receipts |
| `getDisplayRowsForReceipt()` | Only receipts |
| `summarizeReceipts()` | Only receipts |
| Receipt print system (11 functions) | Only receipts |
| `loadReceiptsData` dual-path logic | Only receipts |
| `_populateMultiSelectOptionsFromState()` | Only receipts |
| Loading overlay | Only receipts (search mode) |
| All `_RECEIPT_PRINT_COLS` | Only receipts |
| Status toggle optimization | Only receipts |

---

## 4. State Analysis

### STATE Properties Related to Bolsa

| Property | Owner | Modified By | Read By |
|---|---|---|---|
| `STATE.bolsas` | `loadReceiptsData()` | `loadReceiptsData()` — both modes set it from `getBolsaForms()` | `getBolsaCardsFiltered()`, `renderBolsaList()`, `renderDatalists()`, `handleCardAction()` (bolsa branch) |
| `STATE.filters.bolsas` | `createBolsaFilterState()` | `setFilterValue('bolsas', ...)` via input handler, `setQuickRange('bolsas', ...)` via range buttons | `getBolsaCardsFiltered()`, `_bolsaRowMatchesFilters()`, `renderBolsasControls()` |
| `STATE.tab` | `renderShell()` (default: `'receipts'`) | Click handler for tab buttons | `setActiveTabButtons()`, `printCurrentView()`, `handleCardAction()` (for `data-kind` detection) |

### STATE Properties NOT Related to Bolsa

`STATE.receipts`, `STATE.meta`, `STATE.options`, `STATE.ready`, `STATE.loading`, `STATE.filters.receipts` — these are receipt-only.

---

## 5. Event Analysis

### Events Related to Bolsa

| Event | Source | Listener(s) | Effect |
|---|---|---|---|
| `bolsaForms:changed` | `FinancialService.createBolsaForm/updateBolsaForm/deleteBolsaForm` (financial.js) | `allReceipts.js` → `_scheduleAllReceiptsRefresh` → full reload | Reloads both receipts AND bolsas |
| `bolsaForms:changed` | `syncService.js` (remote detection) | Same | Same |
| `bolsaForms:changed` | — | `bolsas.js` → `_loadMandoubsSelect()` | Refreshes mandoub select on form page |
| `bolsaForms:changed` | — | `receipts.js` → clears bolsa row cache | Invalidates receipt form's bolsa linkage cache |
| `agents:changed` | Various sources | `allReceipts.js` → `_scheduleAllReceiptsRefresh` | Reloads both (bolsa needs agent names for enrichment) |

### Events That Bolsa Does NOT Dispatch

The Bolsa tab itself dispatches zero events. All event dispatching happens in `FinancialService` (financial.js) after server operations. The delete action in `handleCardAction` does NOT dispatch `bolsaForms:changed` — it relies on the `FinancialService.deleteBolsaForm` to do so. However, looking at the code:

```javascript
if (action === 'delete-bolsa') {
    await FinancialService.deleteBolsaForm(username, id);
    alert('✅ تم حذف النموذج بنجاح');
}
```

There is NO explicit `receipts:changed` or `bolsaForms:changed` dispatch here. The event is dispatched inside `FinancialService.deleteBolsaForm`.

---

## 6. Rendering Pipeline

### From Page Open to Bolsa Cards

```
initAllReceiptsPage()
  → renderShell()
      → creates <section data-panel="bolsas"> with renderBolsasControls() HTML
      → creates #bolsasSummaryContainer
      → creates #bolsasList
  → bindPageEvents()
      → attaches click/input/change handlers that include bolsa tab logic
  → refreshAllReceiptsPage('list')
    → loadReceiptsData('list')
      → ReceiptsModule.getBolsaForms(username)    [parallel with receipt loading]
        → GET /entities/bolsa-forms/list.php
        → returns all bolsa forms
      → _enrichBolsasWithAgentName(bolsas)
        → ClientRepository.getAgents()
        → maps agent_id → agent_name
      → STATE.bolsas = enriched bolsas
      → getBolsaCardsFiltered()
        → filters STATE.bolsas by: date range, specific date, global search,
          agent, owner, company, vehicle, karta
      → renderSummaryCards('bolsas', filtered)
        → summarizeBolsas(filtered)
        → renders 6 summary cards into #bolsasSummaryContainer
      → renderLists(receipts, bolsas)
        → renderBolsaList(filtered)
          → sorts by bolsa_date DESC
          → filters rows via _bolsaRowMatchesFilters
          → builds card HTML per record
          → #bolsasList.innerHTML = cards
      → renderDatalists()
        → populates 5 bolsa datalists from STATE.bolsas
```

### Tab Switching

When user clicks the "📦 تفريغ البوالص" tab:
```
click handler → STATE.tab = 'bolsas' → setActiveTabButtons()
  → receipt panel gets class 'hidden'
  → bolsa panel removes class 'hidden'
```

No data reloading. Bolsa data was already loaded during the initial load.

---

## 7. Data Pipeline

```
MySQL: bolsa_forms table
  ↓
BolsaFormRepository.php → getAllByUsername($username)
  → SELECT * FROM bolsa_forms WHERE username=? AND deleted_at IS NULL AND is_archived=0
  → decodes JSON rows and totals
  ↓
bolsa-forms/list.php → jsonSuccess($data)
  ↓
HTTP Response → JSON
  ↓
ApiClient.get() → _normalizeResponse() → { success, data }
  ↓
DBProvider.getAll('bolsaForms', {username})
  → routes through domainRegistry → bolsaForms → apiPath: '/entities/bolsa-forms'
  ↓
ReceiptsModule.getBolsaForms(username)
  → calls DBProvider.getAll
  ↓
loadReceiptsData() receives bolsas array
  ↓
_enrichBolsasWithAgentName(bolsas)
  → ClientRepository.getAgents() → agents list
  → maps agent_id → agent_name on each record
  ↓
STATE.bolsas = enriched records
  ↓
getBolsaCardsFiltered() → applies client-side filters
  ↓
renderBolsaList() → builds HTML → DOM
```

---

## 8. Initialization Pipeline

Everything executed during `initAllReceiptsPage()` that belongs to Bolsa:

| Step | Bolsa Involvement |
|---|---|
| `renderShell()` | Creates bolsa panel HTML, bolsa controls, bolsa containers |
| `_initMultiSelectFilters()` | None — receipt-only |
| `bindPageEvents()` | Registers bolsa tab click, bolsa filter inputs, bolsa range buttons, bolsa apply button, bolsa card actions (edit/delete/print) |
| `window.addEventListener('bolsaForms:changed')` | Triggers full reload (includes bolsa) |
| `window.addEventListener('agents:changed')` | Triggers full reload (bolsa needs agent names) |
| `refreshAllReceiptsPage('list')` → `loadReceiptsData('list')` | Loads bolsas in parallel with receipts |

---

## 9. Migration Impact

### A. Must Move (to new Bolsa listing page)

| Item | Reason |
|---|---|
| `createBolsaFilterState()` | Bolsa-only state factory |
| `getBolsaCardsFiltered()` | Bolsa-only filtering |
| `_bolsaRowMatchesFilters()` | Bolsa-only row filter |
| `summarizeBolsas()` | Bolsa-only summary |
| `getBolsaRows()`, `getBolsaWeight()`, `getBolsaOhda()`, `getBolsaDokhan()` | Bolsa-only helpers |
| `renderBolsasControls()` | Bolsa-only UI |
| `renderBolsaList()` | Bolsa-only rendering |
| `renderDatalists()` (bolsa portion) | Bolsa-only datalists |
| `printSingleBolsa()` | Bolsa-only print |
| `buildBolsaPrintBlock()` | Bolsa-only print block |
| `_enrichBolsasWithAgentName()` | Bolsa-only enrichment |
| Bolsa summary card rendering (`renderSummaryCards('bolsas', ...)` branch) | Bolsa-only summary |
| Bolsa card actions in `handleCardAction()` | Bolsa-only actions |
| `bolsaForms:changed` listener | Bolsa-only refresh |
| `agents:changed` listener (for bolsa enrichment) | Bolsa needs agent names |
| `STATE.bolsas` | Bolsa-only data |
| `STATE.filters.bolsas` | Bolsa-only filter state |

### B. Must Stay (in All Receipts page)

| Item | Reason |
|---|---|
| All receipt state, loading, filtering, rendering | Receipt-only |
| `loadReceiptsData(mode)` — receipt data source branch | Receipt-only (but bolsa loading must be removed from it) |
| All multi-select filter infrastructure | Receipt-only |
| All receipt print system | Receipt-only |
| Receipt summary cards | Receipt-only |
| Status toggle optimization | Receipt-only |
| Loading overlay | Receipt-only |

### C. Must Be Shared (used by both after migration)

| Item | Reason |
|---|---|
| `esc()` | HTML escaping — used by both |
| `fmtMoney()` / `centsToMoney()` / `toNumber()` | Formatting — used by both |
| `receiptDisplayDate()` / `receiptFullDate()` / `receiptDayName()` / `receiptTime()` | Date formatting — used by bolsa cards despite the name |
| `inRange()` / `normalizeDate()` | Date range filtering — used by bolsa |
| `rowContains()` | Text matching — used by bolsa filters |
| `summaryCard()` | Summary card HTML helper — used by both |
| `setDatalist()` | Datalist population — used by bolsa |
| `setFilterValue()` / `setQuickRange()` | Filter state helpers — used by bolsa |
| `printHTML()` (from printEngine.js) | Print infrastructure — already external |
| `printStyles()` | Shared bulk print CSS — used by bolsa bulk print |
| `Money` / `DateUtils` / `FinancialService` / `ClientRepository` | External module imports — already external |
| CSS: `.filter-grid`, `.range-toolbar`, `.record-card`, `.all-list`, `.summary-grid`, `.summary-card`, `.empty-state` | Layout classes — used by both |
| CSS: Emerald theme classes | Bolsa-specific but defined in shared `styles.css` |

---

## 10. Shared Infrastructure

Existing infrastructure that both pages should continue sharing after migration:

| Infrastructure | Location | Usage |
|---|---|---|
| `printEngine.js` (`printHTML`, `buildPrintDocument`) | Separate module | Both use it for printing |
| `money.js` (`Money`) | Separate module | Formatting |
| `dateUtils.js` (`DateUtils`) | Separate module | Date operations |
| `financial.js` (`FinancialService`) | Separate module | `deleteBolsaForm` (bolsa), receipt operations (receipts) |
| `services/clientRepository.js` (`ClientRepository`) | Separate module | Agent resolution (bolsa), owner data (receipts) |
| `bolsas.js` (`loadBolsaForEdit`) | Separate module | Edit navigation (used by both pages' card actions) |
| `services/syncService.js` | Separate module | Version polling (fires events for both) |
| `services/apiClient.js` | Separate module | HTTP transport |
| `services/dbProvider.js` + domain registry | Separate modules | Data routing |
| `constants/payoutStatus.js` | Separate module | Receipt-only but already external |
| `styles.css` | Single CSS file | Shared styles |
| `app.js` (SPA router) | Separate module | Page navigation |
| `index.html` (page sections) | SPA shell | Page containers |

---

## 11. Risks

| # | Risk | Severity | Details |
|---|---|---|---|
| 1 | **Broken bolsa data loading** | High | Currently `loadReceiptsData()` loads bolsas in parallel with receipts. After separation, the new page must have its own loading function. If the parallel `Promise.all` is not correctly split, one page could fail to load. |
| 2 | **Broken event listeners** | High | `bolsaForms:changed` and `agents:changed` currently trigger `_scheduleAllReceiptsRefresh` which reloads BOTH receipts and bolsas. After separation, the All Receipts page should stop listening to `bolsaForms:changed`, and the new Bolsa page must have its own listener. |
| 3 | **Shared utility functions** | Medium | 15+ utility functions (esc, fmtMoney, receiptDisplayDate, etc.) are defined inside `allReceipts.js`. The new Bolsa page needs them. Options: (a) duplicate them, (b) extract to a shared utility module, (c) import from allReceipts.js (creates dependency). |
| 4 | **`renderAll()` calls bolsa rendering** | Medium | `renderAll()` currently renders both receipts AND bolsas. After separation, it must render only receipts. If bolsa rendering code is removed but `renderAll` still calls it, the page crashes. |
| 5 | **`handleCardAction()` shared function** | Medium | Contains both receipt and bolsa action branches. Must be split. The bolsa branch (`edit-bolsa`, `print-bolsa`, `delete-bolsa`) must move to the new page. |
| 6 | **`bindPageEvents()` shared handler** | Medium | The click, input, and change event handlers contain both receipt and bolsa filter logic. The bolsa branches must be removed from `allReceipts.js` and recreated in the new page. |
| 7 | **Tab switching removal** | Low | After separation, `allReceipts.js` no longer needs tab switching. `STATE.tab`, `setActiveTabButtons()`, and the tab buttons in `renderShell()` must be removed. |
| 8 | **`serializeCurrentView()` shared print** | Medium | Currently handles both `tab === 'receipts'` and `tab === 'bolsas'`. After separation, the All Receipts version only needs the receipt branch. The bolsa branch must exist in the new page. |
| 9 | **`printStyles()` shared CSS** | Low | Used by both receipt and bolsa bulk printing. Must be available to both pages. Could be duplicated or extracted. |
| 10 | **SPA routing** | Low | `app.js` needs a new page entry for the bolsa listing page. `index.html` needs a new `<section>` element. A new sidebar link may be needed, or the existing "تفريغ البوالص" link could point to the new listing page instead of the form page. |
| 11 | **Bolsa form page navigation** | Low | The "edit-bolsa" action navigates to `bolsaPage` (the form page). This navigation must work from the new listing page the same way it works now. |
| 12 | **`printCurrentView()` shared function** | Low | Calls `serializeCurrentView(STATE.tab)`. After separation, each page has its own tab context. |
| 13 | **Initialization order** | Low | `app.js` initializes `initAllReceiptsPage()` during boot. The new bolsa listing page needs its own init function registered in `app.js`. |
| 14 | **CSS class naming** | Low | Some CSS classes have `all-receipts-` prefix. The new bolsa page may reuse these classes or need its own. No functional risk — purely cosmetic. |

---

## 12. Migration Order

### Step 1: Create the shared utilities module

Extract the 15+ utility functions used by both pages into a new shared module (e.g., `allReceiptsUtils.js` or similar). This includes: `esc`, `fmtMoney`, `centsToMoney`, `toNumber`, `receiptDisplayDate`, `receiptFullDate`, `receiptDayName`, `receiptTime`, `inRange`, `normalizeDate`, `rowContains`, `setDatalist`, `summaryCard`, `setFilterValue`, `setQuickRange`, `printStyles`, `getLast30DaysRange`.

**Verify:** Both `allReceipts.js` and the future bolsa page can import these. No behavior change.

### Step 2: Create the new Bolsa listing page file

Create `allBolsas.js` (or similar name). Move into it:
- Bolsa STATE (`bolsas: []`, `filters.bolsas`)
- `createBolsaFilterState()`
- `getBolsaCardsFiltered()`
- `_bolsaRowMatchesFilters()`
- `summarizeBolsas()`
- `getBolsaRows/Weight/Ohda/Dokhan()`
- `renderBolsasControls()`
- `renderBolsaList()`
- Bolsa summary rendering
- Bolsa datalist rendering
- `printSingleBolsa()` + `buildBolsaPrintBlock()`
- `_enrichBolsasWithAgentName()`
- Bolsa card actions (edit, delete, print)
- Bolsa event handlers (filter inputs, range buttons, apply button)
- Bolsa event listeners (`bolsaForms:changed`, `agents:changed`)
- Own `loadBolsasData()` function
- Own `renderAll()` function
- Own `initAllBolsasPage()` function

Import shared utilities from Step 1.

**Verify:** New file compiles. Functions exist. Not yet wired into the app.

### Step 3: Add SPA infrastructure for the new page

- Add `<section id="allBolsasPage" class="page hidden"></section>` to `index.html`
- Add page mapping in `app.js` (`PAGE_MAP`, `PAGE_KEY_NORMALIZE`)
- Add `showPage` handler for the new page
- Update sidebar: either add a new link or change the existing "تفريغ البوالص" link to point to the listing page

**Verify:** New page shows/hides correctly via sidebar navigation. Content is empty.

### Step 4: Wire the new Bolsa page

- Import `initAllBolsasPage` in `app.js`
- Call it in `showPage` handler
- Wire `bolsaForms:changed` and `agents:changed` listeners

**Verify:** New page loads bolsa data, renders cards, filters work, summary works, print works, edit/delete actions work.

### Step 5: Remove Bolsa from All Receipts

- Remove `STATE.bolsas` and `STATE.filters.bolsas` from `allReceipts.js`
- Remove `STATE.tab` and tab switching logic
- Remove bolsa panel from `renderShell()`
- Remove tab buttons (only receipts tab remains — or remove tabs entirely)
- Remove `renderBolsasControls()` call
- Remove bolsa branch from `renderSummaryCards()`
- Remove `renderBolsaList()` call from `renderLists()` (or inline `renderReceiptList()` directly)
- Remove bolsa branch from `handleCardAction()`
- Remove bolsa filter branches from `bindPageEvents()`
- Remove bolsa branch from `serializeCurrentView()`
- Remove `getBolsaForms()` call from `loadReceiptsData()` — receipts page no longer loads bolsas
- Remove `_enrichBolsasWithAgentName()`
- Remove bolsa datalist rendering from `renderDatalists()`
- Remove `bolsaForms:changed` listener
- Remove `agents:changed` listener (unless receipts still need it — verify)
- Remove all bolsa-only functions

**Verify:** All Receipts page works with receipts only. No bolsa references remain. No errors.

### Step 6: Clean up

- Remove unused imports (`loadBolsaForEdit` from bolsas.js — now imported by new page)
- Remove unused CSS classes if any
- Update page title and subtitle (no longer "الصرف والتفريغ" — just "الكارتات")
- Verify print/export still works for receipts
- Verify all event flows work correctly

**Verify:** Full regression test. Both pages work independently.

---

## 13. Verification Checklist

### Bolsa Page (New) — Must Work

- [ ] Page opens via sidebar navigation
- [ ] Bolsa cards load and render
- [ ] Agent names displayed correctly
- [ ] Date range filter works
- [ ] Quick range buttons (day/week/month) work
- [ ] Global search filter works
- [ ] Agent filter works
- [ ] Owner filter works
- [ ] Company filter works
- [ ] Vehicle filter works
- [ ] Karta filter works
- [ ] Date filter works
- [ ] Apply button works
- [ ] Summary cards display correct totals
- [ ] Print single bolsa works
- [ ] Print all filtered bolsas works
- [ ] Edit bolsa navigates to form page
- [ ] Delete bolsa works with confirmation
- [ ] `bolsaForms:changed` event triggers refresh
- [ ] `agents:changed` event triggers refresh
- [ ] SyncService triggers refresh for remote changes
- [ ] Empty state message when no bolsas match

### All Receipts Page — Must Still Work

- [ ] Page opens via sidebar navigation
- [ ] Receipt cards load and render
- [ ] No bolsa tab visible
- [ ] No bolsa data loaded
- [ ] Multi-select filters (customer, company, number, vehicle, karta, type) work
- [ ] Status buttons (all/paid/unpaid) work
- [ ] Sort by payout date works
- [ ] Date range filter works
- [ ] Quick range buttons work
- [ ] Apply button works
- [ ] Summary cards display correct totals
- [ ] Print single receipt works
- [ ] Print all filtered receipts works
- [ ] Export to Excel works
- [ ] Edit receipt navigates to form page
- [ ] Delete receipt works
- [ ] Payout status toggle works (instant, no reload)
- [ ] Note save works
- [ ] `receipts:changed` event triggers refresh
- [ ] Page size dropdown works (if applicable)
- [ ] Empty state message when no receipts match
- [ ] No errors in browser console
- [ ] No broken imports
- [ ] No references to bolsa in allReceipts.js

### Cross-System — Must Still Work

- [ ] SyncService fires correct events
- [ ] Dashboard refreshes on `receipts:changed`
- [ ] Treasury page refreshes on `receipts:changed`
- [ ] Entities page invalidates karta cache on `receipts:changed`
- [ ] Bolsa form page (create/edit) still works
- [ ] Receipt form page (create/edit) still works
- [ ] Archive page still works
- [ ] Backup/restore still works
- [ ] Login/logout still works

---

**End of Migration Plan**

*No code was written. No files were modified. This is an architecture plan only.*
