# Changes — next-dbadmin, "version": "1.0.3"

## src/actions/copyTablesActions.ts
- `truncate_table`: replaced plain `TRUNCATE TABLE` + `repair_sequences()` with `TRUNCATE TABLE ... RESTART IDENTITY` — single atomic statement, same outcome, no separate sequence-repair query needed

## src/actions/schemaUtils.ts
- Added `DDLComparisonRow` type: `{ table_name, status, sourceDDL, targetDDL }`
- Added `DDLCompareResult` type: `{ label1, label2, rows: DDLComparisonRow[] }`

## src/actions/schemaSyncActions.ts
- Added `compareDDLsFromUrls`: runs `generateCreateSQLFromUrl` against both databases in parallel, normalises DDL (trim + collapse blank lines), compares per table → identical / different / only_in_source / only_in_target

## src/components/SchemaSyncConn.tsx
- Replaced `information_schema`-based column comparison with full DDL comparison via `compareDDLsFromUrls`
- On table click: shows DDL panel adapting to status — identical (grey), source-only (blue, "run this"), target-only (orange, "orphan"), different (side-by-side blue/orange with source as reference)
- Row counts retained alongside DDL comparison

## src/lib/schemaPaths.ts (new)
- `schemaFilePath(projectKey)` — resolves `C:\Users\richa\github\<projectKey>\scripts\schema.sql`

## src/actions/schemaSyncActions.ts
- Added `fs/promises` and `schemaFilePath` imports
- Extracted `diffDDLMaps(srcMap, tgtMap, label1, label2)` pure function — shared by both comparison modes
- Refactored `compareDDLsFromUrls` to call `diffDDLMaps` (no behaviour change)
- Added `readSchemaFile(projectKey)` private helper — reads and parses `scripts/schema.sql`
- Added `regenerateSchemaFile(url, projectKey)` — writes pg_dump output to `scripts/schema.sql`
- Added `compareDDLWithFile({ url, projectKey, label1, excludePrefixes })` — DB vs schema.sql comparison, returns `DDLCompareResult & { fileExists: boolean }`

## src/components/SchemaSyncConn.tsx
- Added `compareMode: 'db' | 'file'` toggle (radio buttons) between Target DB and Schema file modes
- File mode: compares live DB against `scripts/schema.sql`; Regenerate button writes pg_dump output to file
- File mode hides Target DB picker and row count columns
- Added `lineDiff(src, tgt)` — LCS-based line diff returning `srcLines`/`tgtLines` with `'same'|'src'|'tgt'` kind
- Added `DiffPreBlock` — renders diff lines with per-line highlight for changed lines
- "Different" DDLPanel now shows side-by-side line-level diff: blue highlights in source panel, orange in target panel

## scripts/schema.sql (cross-project)
- Moved `schema.sql` from `lib/` → `scripts/` in infostore, next-bridge, next-chess-analysis, next-bridgeschool, nextjs-shared
- Moved `schema.sql` from `src/` → `scripts/` in next-bridgeschool and nextjs-shared
- Added `## Schema file` section to all seven project CLAUDE.md files (including next-dbadmin, next-bridge, nextjs-chess)
- Updated next-dbadmin CLAUDE.md: SchemaSyncConn description, added Schema file section
- Updated next-chess-analysis CHANGES.md: old `lib/schema.sql` heading corrected to `scripts/schema.sql`

## src/actions/schemaSyncActions.ts
- `parsePgDumpByTable`: strip trailing comment-only and blank lines from each block's SQL so the pg_dump footer (`-- PostgreSQL database dump complete --`) no longer leaks into the last table's DDL
- `regenerateSchemaFile`: write each table with a `-- Name: <table>; Type: TABLE;` header so `parsePgDumpByTable` can re-parse the file on subsequent compare runs

## src/components/SchemaSyncConn.tsx
- Renamed "Schema file" radio label to `scripts/schema.sql`
- Moved "Overwrite schema.sql" button from action row to inline next to the `scripts/schema.sql` radio (only visible in file mode)
- Fixed stale error message: "Regenerate" → "Overwrite schema.sql"
- Fixed LCS backtracking: only treat a line as a match when both `dp[i-1][j] < dp[i][j]` and `dp[i][j-1] < dp[i][j]` — prevents the wrong `);` occurrence from being matched and shifting diff highlighting by one line

## src/components/CreateSQLConn.tsx
- Changed button label to just `Generate`

## src/actions/schemaSyncActions.ts
- `execPgDump`: added `--schema=public` to exclude Neon's `neon_auth` schema from all dumps
- `compareDDLWithFile`: added `filePath` to return type so the client can show the exact path in error messages
- `regenerateSchemaFile`: removed `mkdir` — if `scripts/schema.sql` doesn't exist, returns `File not found: <path>`; never creates directories

## src/actions/schemaUtils.ts
- `normalize` in `diffDDLMaps`: filters out `START WITH \d+` lines so sequence start values don't cause false-positive "Different" results

## src/components/SchemaSyncConn.tsx
- Added `ApplySQLPanel` component: shows SQL to apply to target
- Added `applyMaxId` state; `handleSelectTable` fetches `MAX(pk)` from target via `fetchTablePKMaxFromUrl` when a "different" table is selected in DB mode
- `DDLPanel`: shows `ApplySQLPanel` for `only_in_source` (full CREATE TABLE DDL, new table) and `different` (ALTER TABLE statements only) in DB mode
- Added `parseColumnLine`, `parseCreateTableColumns`, `generateApplyStatements`: for "different" tables, generates ALTER TABLE statements for column nullability, type, default, new columns, named constraint removal, and source-only IDENTITY/constraint blocks — no CREATE TABLE in output

## connections.json
- Renamed key `next-chess` → `nextjs-chess` to match actual project directory

## src/components/DatabaseToolsConn.tsx
- Reordered tabs to: Create SQL, Schema Sync, Copy Tables, Backup
- Changed default active tab from `backup` to `createsql`

## src/actions/schemaUtils.ts
- Added `is_identity` and `identity_generation` to `SchemaRow` type
- Added `c.is_identity` and `c.identity_generation` to the `fetchSchema` SELECT — both come from `information_schema.columns`
- Added both fields to the `diffSchemas` comparison so tables with a mismatched identity attribute (e.g. `GENERATED BY DEFAULT AS IDENTITY` in source but plain integer in target) are correctly flagged as `different` instead of `identical`

## src/actions/schemaSyncActions.ts
- Added `fetchTableMaxIdsFromUrl`: queries the sequence-backed pk column for each table (DISTINCT ON attnum), then runs a UNION ALL MAX query — returns `Record<string, number | null>` (table → max id)

## src/actions/copyTablesActions.ts
- Extended `TableComparisonRow` with `sourceMaxId` and `targetMaxId` fields
- Updated `compare_tables` to call `fetchTableMaxIdsFromUrl` for both source and target in the existing `Promise.all`, and map results into each row
- Added exported `repair_sequence` server action — public wrapper around `repair_sequences`, strips URL params, returns `{ success, message }`

## src/components/CopyTableConn.tsx
- Imported `repair_sequence`
- Added `handleFixSeq(url, table)`: calls `repair_sequence`, sets message, then refreshes
- Per row: computes `sourceSeqBad` and `targetSeqBad` (`nextSeq !== null && maxId !== null && nextSeq <= maxId`)
- Src Seq / Tgt Seq cells turn red with ⚠ prefix and a "Fix" button when the sequence is behind the max id
