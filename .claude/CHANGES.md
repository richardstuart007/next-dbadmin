# Changes — next-dbadmin, "version": "1.0.2"

## src/actions/copyTablesActions.ts
- Added `TableStatus` and `TableComparisonRow` types
- Added `compare_tables` — fetches tables from both source and target, gets row counts for each, returns sorted union with status (`in_sync`, `different`, `source_only`, `target_only`)
- Added `truncate_table` — TRUNCATE TABLE on target database
- Added `drop_table` — DROP TABLE on target database

## src/components/SchemaSyncConn.tsx
- Added `handleSourceChange`: same project-sync logic as CopyTableConn — when source project changes, target project follows while keeping target environment (falls back to first env if exact match not found)
- Replaced inline arrow on Source ConnectionPicker onChange with `handleSourceChange`

## src/components/CopyTableConn.tsx
- `handleSourceChange`: when source project changes, target project automatically follows (same environment kept); falls back to first env for new project if exact env doesn't exist
- `TableStatus` re-exported from `schemaUtils.ts` — now uses identical schema sync values: `identical` / `different` / `only_in_source` / `only_in_target`
- `compare_tables` now calls `compareSchemasFromUrls` (schema comparison) then `fetchTableCountsFromUrl` × 2 in parallel — Status reflects schema parity, Counts reflects row count parity independently
- Removed duplicate `STATUS_LABEL`, `STATUS_COLOUR`, `STATUS_FILTER_OPTIONS` constants — now imports and uses shared `statusMeta` and `STATUS_FILTER_OPTIONS` from `SchemaSyncConn.tsx`

## src/components/SchemaSyncConn.tsx
- Exported `statusMeta` and `STATUS_FILTER_OPTIONS` so they can be shared with CopyTableConn
- Full redesign: replaced flat checkbox list with a comparison table matching SchemaSyncConn layout
- Columns: checkbox | Table | Status ▾ (filterable) | [Source label] | [Target label] | Counts | Actions
- Status badges: In Sync (green) / Different (yellow) / Source Only (blue) / Target Only (orange)
- Per-row Truncate (amber) and Drop (red) buttons on target tables; both fire confirm dialogs
- Summary badge row above table showing counts per status
- Bulk action bar (Copy N Tables + Backup N) appears only when rows are selected
- `target_only` rows have no checkbox — cannot be selected for copy (directional: source→target only)
- After Truncate / Drop / Copy, comparison table refreshes automatically via `handleRefresh`
- Status filter uses `<details>/<summary>` pattern (same as SchemaSyncConn)

## src/actions/copyTablesActions.ts
- Extracted sequence-repair logic into shared `repair_sequences(cleanTargetUrl, table)` helper; called by both `copy_tables` and `truncate_table`
- `repair_sequences` replaces the PL/pgSQL DO block with two plain `spawnPg` calls: first looks up the first serial column (attnum=1) from pg_attribute, second calls setval to MAX (or 1 if empty); no temp file, no loop
- `truncate_table` calls `repair_sequences` after TRUNCATE — table is empty so MAX=0, GREATEST(0,1)=1 → sequence resets to 1; return message updated to "truncated and sequence reset"

## src/actions/schemaSyncActions.ts
- Added `fetchTableSequencesFromUrl(url, tables)` — queries `pg_sequences` via `pg_get_serial_sequence` to compute the next sequence value per table; returns `Record<string, number | null>`
- Fixed `fetchTableSequencesFromUrl`: query referenced `s.is_called` which does not exist in the `pg_sequences` view; replaced with `s.last_value IS NOT NULL` (equivalent: `last_value` is NULL in `pg_sequences` when the sequence has never been called)
- Replaced `fetchTableSequencesFromUrl` query with a `pg_depend`-based approach that finds sequences by ownership rather than by `column_default` or `is_identity`; covers `SERIAL` (deptype='a'), `IDENTITY` (deptype='i'), and any other sequence ownership regardless of how the column was created

## src/actions/copyTablesActions.ts
- Added `sourceNextSeq` and `targetNextSeq` to `TableComparisonRow`
- `compare_tables` now fetches sequences for both source and target in parallel alongside row counts
- Fixed `repair_sequences` bug: `attnum = 1` only checked the first column — changed to `attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1` so tables where the PK is not column 1 are handled correctly
- Added `public.` schema prefix to `pg_get_serial_sequence` and `FROM` clause in `repair_sequences`
- `repair_sequences` now logs an ERROR entry on failure instead of silently swallowing exceptions

## src/components/CopyTableConn.tsx
- Added "Src Seq" and "Tgt Seq" columns showing next sequence value for source and target (or `—` if no sequence)

## src/components/CreateSQLConn.tsx
- Added "All Tables" button at the top of the left panel; when selected, the right panel shows all tables' DDL concatenated with a `-- table_name` comment header per table

## src/actions/schemaSyncActions.ts
- Added `\unrestrict` line filter in `generateCreateSQLFromUrl`: pg_dump on local PostgreSQL emits `\unrestrict <token>` lines that confuse the parser; stripped before calling `parsePgDumpByTable`

## src/components/SchemaSyncConn.tsx
- Replaced `sameConn` (key equality) with `sameUrl` (URL equality) — catches same-URL across different connection names; shows "Same URL for Source and Target"
- `handleCompare` catch now shows "URL to database is invalid" instead of the raw Postgres error message
