# PLAN_databasetoolsconn-tab-mytab — next-dbadmin

## Title
Convert DatabaseToolsConn tab bar to MyTab; convert status filters to MySelectMulti

## Plan
- [x] In `src/components/DatabaseToolsConn.tsx`, replace the hand-rolled tab bar (lines ~48-60) with `nextjs-shared/MyTab`, using explicit `underlineActiveClass`/`underlineInactiveClass` overrides to preserve the current look exactly (`text-xs`, `px-4 py-2`, white active background) rather than adopting MyTab's own defaults.
- [x] In `src/components/SchemaSyncConn.tsx` (`TableSummarySection`, lines ~607-667), replace the hand-rolled `<details>/<summary>` status-filter checkbox dropdown with `nextjs-shared/MySelectMulti`, using `showReset={true}` to preserve the existing one-click "All" reset. Map `STATUS_FILTER_OPTIONS` to its `options` prop, `selectedStatuses` (converted between `Set`/`string[]`) to `selected`/`onChange`.
- [x] In `src/components/CopyTableConn.tsx`, apply the equivalent conversion to its own status filter (same pattern as SchemaSyncConn).

## Changes
### src/components/DatabaseToolsConn.tsx
- Replaced the hand-rolled `<button>` tab bar with `nextjs-shared/MyTab`, passing explicit `underlineActiveClass`/`underlineInactiveClass` overrides so the rendered look (text-xs, px-4 py-2, white active background) is unchanged from before.
- Not converted in this task (decided against/out of scope, see chat): `CreateSQLConn.tsx` table-list buttons (MyButton doesn't fit the flush list-item shape well).

### src/components/SchemaSyncConn.tsx
- `TableSummarySection`'s status filter (`selectedStatuses` state, `isAll`/`filteredRows` derivation) converted from `Set<string>` to `string[]` to match `MySelectMulti`'s `selected`/`onChange` shape.
- Replaced the hand-rolled `<details>/<summary>` + checkbox-list dropdown with `nextjs-shared/MySelectMulti`, passing `options={STATUS_FILTER_OPTIONS}`, `showReset` + `resetLabel='All'` for the one-click reset, and `overrideClass='w-28 md:w-28 h-6 md:h-6'` to fit compactly in the table header. Per explicit user choice, adopted MySelectMulti's own default bordered-chip look (with a `label='Status'`) rather than trying to preserve the old borderless text-link style — differs visually from before, intentionally.
- `toggleStatus` helper removed — no longer needed, `MySelectMulti` manages its own toggle state internally.

### src/components/CopyTableConn.tsx
- Same conversion applied to its own status filter: `selectedStatuses` state changed from `Set<TableStatus>` to `TableStatus[]`, `isAll`/`filteredRows` updated accordingly, `toggleStatus` helper removed, hand-rolled dropdown replaced with `MySelectMulti` (same props/overrides as SchemaSyncConn). `onChange` casts the `string[]` callback value back to `TableStatus[]` since `MySelectMulti` is generically typed.

## Testing
- [x] Open the app's main database tools page and confirm all 5 tabs (Create SQL, Schema Sync, Copy Tables, Backup, Logging) render with the same look as before: text-xs, px-4 py-2, active tab shown with blue underline/text and white background, inactive tabs gray.
- [x] Click through each tab and confirm switching still works and each panel's content loads correctly (Logging tab in particular remounts/re-fetches on each visit).
- [x] On the Schema Sync tab, run a comparison, then open the Status filter dropdown above the Status column: confirm it now shows as a small bordered "Status" selector, checking/unchecking options filters the table rows correctly, and clicking the "All" reset row clears the filter back to showing every row.
- [x] On the Copy Tables tab, load tables, then repeat the same Status filter check (select statuses, filter rows, click "All" to reset).
