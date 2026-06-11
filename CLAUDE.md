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
- `src/components/SchemaSyncConn.tsx` — schema compare UI; calls compareSchemasFromUrls from nextjs-shared/schemaSync
- `src/components/ConnectionPicker.tsx` — dropdown for selecting a database connection
- `src/actions/schemaSyncActions.ts` — fetchTableCountsFromUrl server action (URL-based row counts)
- `src/types/connections.ts` — ConnectionEntry, Connection, ConnectionsFile types
- `src/app/api/copy/route.ts` — POST SSE route: accepts { sourceUrl, targetUrl, tables }
- `src/app/api/schema-compare/route.ts` — GET route: accepts url1, url2 query params

## Key conventions

- Always use `function` declarations, never arrow functions for named functions
- `'use client'` or `'use server'` must be the very first line
- Never use `require()` — ES module imports only
- POSTGRES_URL in `.env` is optional (used only for write_Logging; failures are silent)
- Do not add the `xlg_logging` table unless you have a local database to point to
