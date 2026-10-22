# Bolsa Separation Migration Plan v2.2
## Staged Migration with Verification Gates

**Date:** 2026-07-15  
**Type:** Refined execution plan — No code  
**Supersedes:** `bolsa-separation-migration-plan.md`

---

## Execution Rules

### Rule 1: Staged Migration — Never Destructive

Every component follows this sequence:

```
1. COPY to new location
2. VERIFY new location works
3. DISABLE in original (comment out / flag — do NOT delete)
4. VERIFY original still works without it
5. WAIT for explicit approval
6. DELETE from original (only after approval)
```

At no point during the migration is any functionality deleted before the replacement is verified and approved. The original code remains recoverable at every step.

### Rule 2: Mandatory Verification Gates

After every migration step, execution **STOPS**. A Verification Report is produced containing:

- Files modified
- Functions moved
- Functions disabled
- Imports added / removed
- Dependencies affected
- Regression risks
- Verification checklist
- Rollback procedure
- Current system status

Then: **"Waiting for approval before continuing to the next migration step."**

No automatic continuation. The next step begins only after explicit user approval.

### Rule 3: Rollback Strategy

Every step defines:
- **What can be reverted:** which files to restore
- **Maximum rollback scope:** which step(s) are undone
- **Conditions that require rollback:** specific failure criteria

Rollback is always possible by restoring the files listed. The original code is never deleted until the final cleanup step.

### Rule 4: Success Criteria

Each step defines objective pass/fail conditions. All must pass before requesting approval:
- Zero JavaScript console errors
- Zero broken imports
- Navigation works (sidebar → page → content visible)
- Existing functionality unchanged (verified per checklist)
- Events fire and listeners respond correctly
- Rendering matches previous behavior visually

### Rule 5: No Shared Utility Extraction During Migration

The current goal is **only** to separate the Bolsa page. Creating a shared utilities module is a separate refactor that would increase migration risk and expand scope.

During the migration:
- All existing utilities stay inside `allReceipts.js` unchanged.
- No new shared module is created.
- No existing imports in `allReceipts.js` are changed.

After the Bolsa separation is fully completed, verified, and approved, a separate decision will be made about whether to extract common utilities into a shared module.

### Rule 6: Reuse Over Duplication

Prefer REUSE of existing infrastructure over duplication whenever possible.

**REUSE** (import from existing external modules):
- CSS classes — all existing `.record-card`, `.summary-card`, `.summary-grid`, `.filter-grid`, `.range-toolbar`, `.all-list`, `.empty-state`, emerald theme classes, and any other generic layout classes in `styles.css`. No duplicate CSS.
- External modules — `Money` (money.js), `DateUtils` (dateUtils.js), `printHTML` (printEngine.js), `FinancialService` (financial.js), `ReceiptsModule` (receipts.js), `ClientRepository` (clientRepository.js), `loadBolsaForEdit` (bolsas.js), `ExcelService` (excelService.js). These are already in separate modules. Import normally.
- Constants — `RECEIPT_PAYOUT_STATUS`, `getPayoutStatusMeta` if needed.

**DUPLICATE temporarily** (copy into `allBolsas.js` — only for functions defined inside `allReceipts.js`):
- Bolsa-specific logic: `_enrichBolsasWithAgentName`, `getBolsaCardsFiltered`, `_bolsaRowMatchesFilters`, `summarizeBolsas`, `getBolsaRows/Weight/Ohda/Dokhan`, `renderBolsasControls`, `renderBolsaList`, `printSingleBolsa`, `buildBolsaPrintBlock`
- Generic utilities that are ONLY defined inside `allReceipts.js` and cannot be imported: `esc`, `fmtMoney`, `centsToMoney`, `toNumber`, `inRange`, `normalizeDate`, `rowContains`, `setDatalist`, `setFilterValue`, `setQuickRange`, `getLast30DaysRange`
- Date formatting helpers only defined inside `allReceipts.js`: `receiptDisplayDate`, `receiptFullDate`, `receiptDayName`, `receiptTime`
- Rendering helpers only defined inside `allReceipts.js`: `summaryCard`, `printStyles`

**Decision rule:** If a function is already exported from a separate module → import it. If it is defined locally inside `allReceipts.js` and not exported → copy it temporarily. Never modify `allReceipts.js` to export functions during the migration.

---

## Migration Steps

### Step 1: Create Bolsa Listing Page (Empty Shell)

**Objective:** Create the new `allBolsas.js` file and SPA infrastructure. The page loads and shows an empty shell. No bolsa logic moved yet.

**What happens:**
1. Create `allBolsas.js` with:
   - Basic STATE (`bolsas: []`, `filters`, `loading`, `ready`)
   - `initAllBolsasPage()` — renders an empty shell with title "تفريغ البوالص"
   - Reuses existing CSS classes (`.all-receipts-page` or similar layout classes from `styles.css`)
   - Exports `initAllBolsasPage`
2. Add `<section id="allBolsasPage" class="page hidden"></section>` to `index.html`
3. Add page mapping in `app.js` (`PAGE_MAP`, `PAGE_KEY_NORMALIZE`, `showPage` handler)
4. Add sidebar link or update existing "تفريغ البوالص" link

**No bolsa code moved from allReceipts.js.** The bolsa tab inside All Receipts continues to work exactly as before.

**Files modified:**
- `allBolsas.js` — CREATED (empty shell)
- `index.html` — MODIFIED (new section added)
- `app.js` — MODIFIED (new page mapping + showPage handler)

**Files NOT modified:**
- `allReceipts.js` — UNTOUCHED
- `styles.css` — UNTOUCHED (reuses existing classes)

**Success criteria:**
- [ ] New page navigable via sidebar
- [ ] New page shows empty shell with title
- [ ] All Receipts page still works identically (receipts + bolsa tab)
- [ ] All other pages still work
- [ ] Zero JS errors

**Rollback:**
- Delete `allBolsas.js`
- Revert `index.html` (remove the new section)
- Revert `app.js` (remove the new page mapping)
- **3 files to restore:** `index.html`, `app.js` (revert to pre-step versions)

**Conditions requiring rollback:**
- New page causes any error on other pages
- Navigation breaks
- Any existing page stops working

**→ STOP. Produce Verification Report. Wait for approval.**

---

### Step 2: Move Bolsa Data Loading

**Objective:** The new Bolsa page loads its own data independently. The old bolsa tab inside All Receipts still works (dual operation).

**What happens:**
1. Add to `allBolsas.js`:
   - `loadBolsasData()` — calls `ReceiptsModule.getBolsaForms()` + `_enrichBolsasWithAgentName()`
   - Copy `_enrichBolsasWithAgentName()` from `allReceipts.js` (temporary duplicate)
   - Import `ReceiptsModule` from `receipts.js` (REUSE — already external)
   - Import `ClientRepository` from `services/clientRepository.js` (REUSE — already external)
   - STATE.bolsas populated on load
2. The new page loads bolsa data when navigated to
3. `allReceipts.js` bolsa loading is **NOT disabled** — it still loads bolsas for the tab

**Both pages load bolsa data independently.** This is intentional dual operation during migration.

> **Note on temporary duplication:** `_enrichBolsasWithAgentName` is temporarily duplicated because it is defined inside `allReceipts.js` and not exported. This duplication exists only during the migration period. It will be eliminated after the old implementation is fully disabled and verified.

**Files modified:**
- `allBolsas.js` — MODIFIED (data loading added)

**Files NOT modified:**
- `allReceipts.js` — UNTOUCHED

**Success criteria:**
- [ ] New page loads bolsa data (verify via console.log or card count)
- [ ] All Receipts bolsa tab still works
- [ ] No duplicate API calls interfere with each other
- [ ] Zero JS errors

**Rollback:**
- Revert `allBolsas.js` to Step 1 version (empty shell)
- **1 file to restore**

**→ STOP. Produce Verification Report. Wait for approval.**

---

### Step 3: Move Bolsa Rendering

**Objective:** The new Bolsa page renders bolsa cards, filters, summary, and datalists. Both pages show bolsa data simultaneously (dual operation).

**What happens:**

**Bolsa-specific functions — COPIED (temporary duplicates):**
- `createBolsaFilterState()`
- `getBolsaCardsFiltered()`
- `_bolsaRowMatchesFilters()`
- `summarizeBolsas()`
- `getBolsaRows()`, `getBolsaWeight()`, `getBolsaOhda()`, `getBolsaDokhan()`
- `renderBolsasControls()`
- `renderBolsaList()`
- Bolsa summary rendering logic
- Bolsa datalist rendering logic

**Generic utilities — COPIED (only because they are not exported from allReceipts.js):**
- `esc`, `fmtMoney`, `centsToMoney`, `toNumber`
- `receiptDisplayDate`, `receiptFullDate`, `receiptDayName`, `receiptTime`
- `inRange`, `normalizeDate`, `rowContains`
- `setDatalist`, `summaryCard`, `setFilterValue`, `setQuickRange`, `getLast30DaysRange`

**REUSED (imported from existing external modules — NOT copied):**
- `Money` from `money.js`
- `DateUtils` from `dateUtils.js`

**REUSED (existing CSS — NOT duplicated):**
- `.filter-grid`, `.range-toolbar`, `.record-card`, `.record-table`, `.all-list`
- `.summary-grid`, `.summary-card`, `.summary-card--*`
- `.record-card__header--emerald`, `.record-card__footer--emerald`, `.record-table--emerald`
- `.empty-state`, `.apply-btn`, `.range-btn`, `.pdf-btn`
- All existing CSS classes remain in `styles.css` unchanged

**`allReceipts.js` bolsa tab is NOT disabled — still works.**

**Files modified:**
- `allBolsas.js` — MODIFIED (rendering added)

**Files NOT modified:**
- `allReceipts.js` — UNTOUCHED
- `styles.css` — UNTOUCHED

**Success criteria:**
- [ ] New page renders bolsa cards identically to the old tab
- [ ] New page filters work (all 7 filters)
- [ ] New page summary cards show correct totals
- [ ] New page datalists populated
- [ ] Quick range buttons work on new page
- [ ] Apply button works on new page
- [ ] Old bolsa tab inside All Receipts still works
- [ ] Zero JS errors

**Rollback:**
- Revert `allBolsas.js` to Step 2 version
- **1 file to restore**

**→ STOP. Produce Verification Report. Wait for approval.**

---

### Step 4: Move Bolsa Actions and Events

**Objective:** The new Bolsa page handles edit, delete, print actions and listens to domain events. Both pages still operational.

**What happens:**

**Bolsa-specific functions — COPIED (temporary duplicates):**
- `printSingleBolsa()` + `buildBolsaPrintBlock()`
- `printStyles()` (used by bolsa bulk print — temporary copy)
- Bolsa version of `serializeCurrentView`

**REUSED (imported from existing external modules — NOT copied):**
- `FinancialService` from `financial.js` — for `deleteBolsaForm`
- `loadBolsaForEdit` from `bolsas.js` — for edit navigation
- `printHTML` from `printEngine.js` — for print infrastructure

**New logic in `allBolsas.js`:**
- Bolsa card action handler (edit, delete, print)
- Click/input/change event delegation for bolsa controls
- `bolsaForms:changed` listener → reload
- `agents:changed` listener → reload
- Refresh coalescing scheduler (own independent scheduler)

**`allReceipts.js` is NOT modified.**

**Files modified:**
- `allBolsas.js` — MODIFIED (actions + events added)

**Files NOT modified:**
- `allReceipts.js` — UNTOUCHED
- `styles.css` — UNTOUCHED

**Success criteria:**
- [ ] Edit bolsa from new page → navigates to form page correctly
- [ ] Delete bolsa from new page → confirmation + deletion works
- [ ] Print single bolsa from new page → correct output
- [ ] Print all filtered bolsas from new page → correct output
- [ ] `bolsaForms:changed` triggers reload on new page
- [ ] `agents:changed` triggers reload on new page
- [ ] All Receipts bolsa tab still works for all actions
- [ ] Zero JS errors

**Rollback:**
- Revert `allBolsas.js` to Step 3 version
- **1 file to restore**

**→ STOP. Produce Verification Report. Wait for approval.**

---

### Step 5: Disable Bolsa in All Receipts

**Objective:** Disable (not delete) all bolsa functionality inside `allReceipts.js`. The old tab disappears. The new page is the sole bolsa listing.

**What happens:**
1. In `allReceipts.js`:
   - Comment out `STATE.bolsas` and `STATE.filters.bolsas` initialization
   - Comment out tab buttons in `renderShell()` (remove `data-tab="bolsas"` button)
   - Comment out bolsa panel in `renderShell()`
   - Comment out `renderBolsasControls()` call
   - Comment out bolsa branch in `renderSummaryCards()`
   - Comment out `renderBolsaList()` call in `renderLists()`
   - Comment out bolsa branch in `handleCardAction()`
   - Comment out bolsa filter branches in `bindPageEvents()`
   - Comment out bolsa branch in `serializeCurrentView()`
   - Comment out `getBolsaForms()` call in `loadReceiptsData()`
   - Comment out `_enrichBolsasWithAgentName()` call
   - Comment out bolsa datalist rendering in `renderDatalists()`
   - Comment out `bolsaForms:changed` listener
   - Comment out `agents:changed` listener (if receipts don't need it — verify first)
   - Comment out `setActiveTabButtons()` tab logic
   - All disabled code marked with `// MIGRATION-DISABLED: moved to allBolsas.js`

2. `allReceipts.js` becomes receipt-only. No bolsa tab visible.

**All commented-out code remains in the file for rollback.**

**Files modified:**
- `allReceipts.js` — MODIFIED (bolsa code commented out, not deleted)

**Success criteria:**
- [ ] All Receipts page shows receipts only — no tab buttons
- [ ] No bolsa data loaded on All Receipts page
- [ ] All receipt functionality works identically
- [ ] Multi-select filters work
- [ ] Status toggle works
- [ ] Print/export works for receipts
- [ ] New Bolsa page works independently
- [ ] No JS errors on either page
- [ ] No broken imports
- [ ] `receipts:changed` still triggers receipt reload
- [ ] `bolsaForms:changed` does NOT trigger receipt reload
- [ ] SyncService still works for both pages

**Rollback:**
- Uncomment all `MIGRATION-DISABLED` lines in `allReceipts.js`
- **1 file to restore** (or search-replace to uncomment)

**Conditions requiring rollback:**
- Any receipt functionality breaks
- Any bolsa functionality not working on new page
- Any event flow broken

**→ STOP. Produce Verification Report. Wait for approval.**

---

### Step 6: Final Cleanup (Permanent Deletion)

**Objective:** Remove all disabled bolsa code from `allReceipts.js`. Clean imports. Remove dead functions.

**Precondition:** Steps 1–5 approved and verified in production.

**What happens:**
1. Delete all `// MIGRATION-DISABLED` blocks from `allReceipts.js`
2. Delete all bolsa-only functions from `allReceipts.js`
3. Remove unused imports (`loadBolsaForEdit` if no longer needed)
4. Remove `STATE.tab` if no longer needed
5. Update page title/subtitle
6. Clean up `renderLists()` — can be inlined or simplified
7. Verify no dead references remain

**Files modified:**
- `allReceipts.js` — MODIFIED (dead code permanently removed)

**Success criteria:**
- [ ] Zero occurrences of "bolsa" in `allReceipts.js` (except possibly in comments about history)
- [ ] Zero `MIGRATION-DISABLED` comments
- [ ] File compiles without errors
- [ ] All brackets balanced
- [ ] All receipt functionality works
- [ ] All bolsa functionality works on new page
- [ ] Full regression pass

**Rollback:**
- Restore `allReceipts.js` from Step 5 version (still has commented-out code)
- **1 file to restore**

**This is the ONLY step where code is permanently deleted.**

**→ STOP. Produce Verification Report. Wait for final approval.**

---

## Summary of All Steps

| Step | Action | allReceipts.js | allBolsas.js | styles.css | Reversible? |
|---|---|---|---|---|---|
| 1 | Create empty bolsa page shell | UNTOUCHED | Created (empty) | UNTOUCHED | ✅ Delete new file + revert app.js/index.html |
| 2 | Move bolsa data loading | UNTOUCHED | Data loading added | UNTOUCHED | ✅ Revert to Step 1 |
| 3 | Move bolsa rendering | UNTOUCHED | Rendering added | UNTOUCHED | ✅ Revert to Step 2 |
| 4 | Move bolsa actions + events | UNTOUCHED | Actions + events added | UNTOUCHED | ✅ Revert to Step 3 |
| 5 | Disable bolsa in allReceipts | Bolsa code commented out | Complete standalone page | UNTOUCHED | ✅ Uncomment |
| 6 | Final cleanup | Bolsa code permanently deleted | No change | UNTOUCHED | ⚠️ Revert to Step 5 only |

**Key properties:**
- `allReceipts.js` is UNTOUCHED in Steps 1–4. Modified only in Step 5 (commented out) and Step 6 (deleted).
- `styles.css` is NEVER modified. All CSS is reused.
- At every step from 1 through 5, the system can be fully rolled back by restoring at most 3 files.
- No functionality is permanently lost until Step 6.
- Temporary function duplication between `allReceipts.js` and `allBolsas.js` exists during Steps 2–5. This is intentional and scoped to functions defined inside `allReceipts.js` that cannot be imported.
- External modules (`Money`, `DateUtils`, `FinancialService`, `printHTML`, `loadBolsaForEdit`, `ReceiptsModule`, `ClientRepository`) are always imported — never duplicated.

---

**End of Migration Plan v2.2**

*No code was written. No files were modified.*
