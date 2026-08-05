# PLAN_reinstall-fix-myselectmulti — next-dbadmin

## Title
Reinstall nextjs-shared and fix obsolete MySelectMulti props

## Plan
- [x] Reinstall dependencies (remove `node_modules`/`package-lock.json`/`.next`, `npm install`) to
      pull current `nextjs-shared` (was pinned at 2.1.34, 28 versions behind current 2.1.62).
- [x] `src/components/SchemaSyncConn.tsx` (~line 641-642): remove the obsolete `showReset` and
      `resetLabel='All'` props from the `MySelectMulti` call — removed from the component's type
      entirely; the "select all" row is now built in by default (governed by `selectAllLabel`), no
      replacement prop needed.
- [x] `src/components/CopyTableConn.tsx` (~line 532-533): same fix, same obsolete props.
- [x] Run `npx tsc --noEmit` and `npm run build` to confirm the reinstalled version compiles clean.

## Changes

### node_modules / package-lock.json
- Reinstalled to pull `nextjs-shared@2.1.62` (was pinned at 2.1.34).

### src/components/SchemaSyncConn.tsx
- Removed the obsolete `showReset`/`resetLabel='All'` props from the `MySelectMulti` status filter
  — no longer part of the component's type; its "select all" row is built in by default now.

### src/components/CopyTableConn.tsx
- Same fix, same obsolete props removed from its `MySelectMulti` status filter.

## Testing
- [ ] Confirmed via `npx tsc --noEmit` + `npm run build` — both pass.
- [ ] Open the Schema Sync and Copy Table pages — confirm the Status multi-select filter still
      renders and filters correctly, including its built-in "select all" row.
