# next-db-admin

Local-only database admin tool. Never deployed.

## Purpose

Copy tables between databases and compare schemas across projects.
All DB connections are defined in `connections.json` in the project root (gitignored).

## nextjs-shared reference

Read `node_modules/nextjs-shared/CONSUMING_PROJECTS.md` before implementing
any feature from nextjs-shared. It contains all component APIs, database
function signatures, coding conventions, and setup instructions.

## connections.json

Flat list of named connections — one entry per database environment:

```json
{
  "projectName": {
    "local":      { "url": "postgres://...", "label": "...", "colour": "green" },
    "production": { "url": "postgres://...", "label": "...", "colour": "red", "readonly": true }
  }
}
```

`connections.json` is gitignored. Never commit real URLs.

## Architecture

- `src/app/page.tsx` — server component: reads connections.json, passes ConnectionEntry[] to DatabaseToolsConn
- `src/components/DatabaseToolsConn.tsx` — tab container (Copy Tables / Schema Sync)
- `src/components/CopyTableConn.tsx` — table copy UI; calls server actions from nextjs-shared/copyTables
- `src/components/SchemaSyncConn.tsx` — schema compare UI; calls compareDDLsFromUrls (pg_dump --schema-only per table)
- `src/components/ConnectionPicker.tsx` — dropdown for selecting a database connection
- `src/actions/schemaSyncActions.ts` — fetchTableCountsFromUrl server action (URL-based row counts)
- `src/types/connections.ts` — ConnectionEntry, Connection, ConnectionsFile types
- `src/app/api/copy/route.ts` — POST SSE route: accepts { sourceUrl, targetUrl, tables }
- `src/app/api/schema-compare/route.ts` — GET route: accepts url1, url2 query params

## nextjs-shared suitability

SQL utility functions in this project accept a `url` parameter to connect to arbitrary databases. This makes them **ineligible for `nextjs-shared`** — shared database functions use the project's configured connection, not a caller-supplied URL. Never propose moving a URL-accepting database function to `nextjs-shared`.

## Schema file

`scripts/schema.sql` is the single source of truth for the database structure. Every new table and index must be added here.

## Key conventions

- Always use `function` declarations, never arrow functions for named functions
- `'use client'` or `'use server'` must be the very first line
- Never use `require()` — ES module imports only
- POSTGRES_URL in `.env` is optional (used only for write_Logging; failures are silent)
- Do not add the `xlg_logging` table unless you have a local database to point to

## Silent file updates — never ask permission

**PLAN.md and CHANGES.md are always updated silently.**  
Never ask before checking off a step in `.claude/PLAN.md` or appending to `.claude/CHANGES.md`. These are mechanical parts of execution — no confirmation needed.
