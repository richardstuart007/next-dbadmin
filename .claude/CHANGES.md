# Changes — next-dbadmin, "version": "1.0.4"

## 2026-07-11 — Fix silent SSL failure against Aiven (and other custom-CA) targets

### src/lib/dbArbitrary.ts
- `createArbitraryDb` and `runBatch` now strip `sslmode` from the connection string and pass `ssl: { rejectUnauthorized: false }` explicitly to `pg.Client`.
- Root cause: the installed `pg-connection-string` treats `sslmode=require` as an alias for `verify-full` (full CA chain + hostname verification) unless `uselibpqcompat` is set. Aiven signs its certs with its own CA, which isn't in Node's trust store, so every query routed through `createArbitraryDb` (row counts, sizes, sequences, max ids) was throwing and being silently swallowed by try/catch blocks in `schemaSyncActions.ts`, showing as blank `—` for every target-side value even though the actual copy (via `psql`/`pg_dump`, which handle `sslmode=require` the traditional lenient way) succeeded.
- Verified by connecting directly to the real Aiven URL with the fixed `Client` config — succeeded where it previously failed.

## 2026-07-11 — Wire up write_logging for Copy Tables actions

### src/actions/copyTablesActions.ts
- `repair_sequence`, `vacuum_table`, `copy_tables`, `backup_tables`, `truncate_table`, `drop_table` now call `write_logging` (severity `'I'` on success, `'E'` on failure), using the `caller` param already passed in from `CopyTableConn.tsx` but never previously destructured or used.
- Root cause: none of these action functions ever called `write_logging`, despite `caller` being accepted as a parameter — logging was simply never wired up, not misrouted. `write_logging` reads `POSTGRES_URL` directly, so entries land in this project's own `xlg_logging` table regardless of which source/target connection the action operated on.

## 2026-07-11 — Extend logging to read-only fetch/compare functions, add environment + table context, add Logging tab

### src/actions/schemaSyncActions.ts
- All 10 exported functions (`fetchTableMaxIdsFromUrl`, `fetchTableSequencesFromUrl`, `fetchTablePKMaxFromUrl`, `fetchTableCountsFromUrl`, `fetchTableSizesFromUrl`, `compareSchemasFromUrls`, `compareDDLsFromUrls`, `regenerateSchemaFile`, `compareDDLWithFile`, `generateCreateSQLFromUrl`) now call `write_logging`, including the previously-unlogged read-only fetches (per user: "in dev mode ... we report everything").
- Added a `label` param (environment name, e.g. connection label) to every function alongside the existing `caller` param, and every log message now explicitly includes `[environment]` and `table(s)=...` so log entries answer: which environment, which table(s), which caller (`lg_caller` column), which action (`lg_functionname` column).

### src/actions/copyTablesActions.ts
- `repair_sequence`, `vacuum_table`, `truncate_table`, `drop_table`, `backup_tables` now accept a `label` param and include it in their log messages; `compare_tables` now accepts `sourceLabel`/`targetLabel` and threads them into every inner fetch call and into `compareDDLsFromUrls`.

### src/components/CopyTableConn.tsx, SchemaSyncConn.tsx, CreateSQLConn.tsx, src/app/api/schema-compare/route.ts
- Updated every call site to pass `caller` and the relevant connection `label`(s) through to the action functions above.

### src/components/LoggingConn.tsx (new), DatabaseToolsConn.tsx
- New "Logging" tab showing `nextjs-shared`'s `OwnerTableLogging` (paginated `xlg_logging` viewer). Initially added a custom `truncate_logging` server action + duplicate Truncate button, but `OwnerTableLogging` already ships its own "Truncate Logging" button (`action_truncateLogging`) — removed the redundant `src/actions/loggingActions.ts` and custom button; `LoggingConn` is now a thin wrapper.

### ~/.claude/settings.json (global, outside this project)
- Widened the `npx tsc --noEmit` allow rule to a prefix wildcard (`npx tsc --noEmit*`) for both Bash and PowerShell, so variant invocations with extra flags don't fall through to the broader `ask` rule for `npx *`.

## 2026-07-11 — Fix regression: forcing ssl on every connection broke local (no-SSL) Postgres

### src/lib/dbArbitrary.ts
- Regression introduced by the earlier Aiven SSL fix: unconditionally passing `ssl: { rejectUnauthorized: false }` makes `pg` require SSL, and `client.connect()` throws `"The server does not support SSL connections"` when the target server has no SSL at all (the local Postgres case) — it does not fall back to plaintext the way omitting `ssl` entirely does. This silently zeroed out every source-side (local) count/size/sequence value while target (Aiven) started working, exactly inverting the original bug.
- Added `resolveSsl()`: returns `false` when the connection string's `sslmode` is absent or `disable` (local), and `{ rejectUnauthorized: false }` otherwise (Aiven, Neon, etc.). Verified both cases connect successfully with a direct test against the real local and Aiven databases.
- Confirmed via direct query against `xlg_logging` that the `write_logging` additions from the prior two entries were working correctly throughout — the error trail (`fetchTableCountsFromUrl` etc. logging severity `'E'` for `[chess Local]`) is what pinpointed this regression. No logging bug; the Logging tab had simply been loaded once and not refreshed after the fix was tested.

### src/types/connections.ts, src/app/page.tsx, src/components/ConnectionPicker.tsx
- Added optional `location` field to `Connection`/`ConnectionEntry`, flattened through from `connections.json` in `page.tsx`, and displayed as small muted text next to the existing colour dot in `ConnectionPicker` — the one shared component used by Copy Tables, Schema Sync, Create SQL, and Backup, so it surfaces everywhere at once.

## 2026-07-11 — Fix Logging tab showing stale data on revisit

### src/components/DatabaseToolsConn.tsx
- Tabs stay mounted (just toggled via a `hidden` CSS class) when switching, so `LoggingConn`'s one-time fetch never re-ran on revisit — confirmed `OwnerTableLogging` itself already uses `skipCache: true`, so this wasn't a caching issue.
- Added a `loggingKey` counter that increments via `useEffect` every time `activeTab` becomes `'logging'`, passed as `key={loggingKey}` on `<LoggingConn>` to force a remount (and re-fetch) on every visit, without changing the always-mounted behavior the other tabs rely on to preserve their state.
