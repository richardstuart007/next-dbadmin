'use server'

import { execSync } from 'child_process'
import { readFile, writeFile, access } from 'fs/promises'
import { createArbitraryDb } from '@/src/lib/dbArbitrary'
import { schemaFilePath } from '@/src/lib/schemaPaths'
import { fetchSchema, diffSchemas, diffDDLMaps } from '@/src/actions/schemaUtils'
import type { SchemaCompareResult, DDLCompareResult } from '@/src/actions/schemaUtils'

const PG_BIN_PATHS = [
  'C:\\Program Files\\PostgreSQL\\18\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
]

export type TableDDL = { table_name: string; sql: string }

function execPgDump(args: string): string {
  const augmentedPath = [...PG_BIN_PATHS, process.env.PATH ?? ''].join(';')
  return execSync(`pg_dump ${args}`, {
    encoding: 'utf8',
    env: { ...process.env, PATH: augmentedPath },
  }) as string
}

function parsePgDumpByTable(raw: string): TableDDL[] {
  const text = raw.replace(/\r\n/g, '\n')
  const tableMap = new Map<string, string[]>()

  const seqToTable = new Map<string, string>()
  const ownedRe = /ALTER SEQUENCE public\.(\S+)\s+OWNED BY public\.(\w+)\./g
  let om: RegExpExecArray | null
  while ((om = ownedRe.exec(text)) !== null) seqToTable.set(om[1], om[2])

  const defaultRe = /-- Name: (\w+) \w+; Type: DEFAULT;[\s\S]*?nextval\('public\.(\S+?)'::regclass\)/g
  let dm: RegExpExecArray | null
  while ((dm = defaultRe.exec(text)) !== null) {
    if (!seqToTable.has(dm[2])) seqToTable.set(dm[2], dm[1])
  }

  const blocks = text.split(/\n--\n(?=-- Name:)/)
  for (const block of blocks) {
    const headerMatch = block.match(/^-- Name: ([^;]+); Type: ([^;]+);/)
    if (!headerMatch) continue
    const name = headerMatch[1].trim()
    const type = headerMatch[2].trim()
    if (type === 'SEQUENCE OWNED BY') continue

    const lines = block.split('\n')
    let sqlStart = 0
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('--') && lines[i].trim() !== '') { sqlStart = i; break }
    }
    const sqlLines = lines.slice(sqlStart)
    let sqlEnd = sqlLines.length
    while (sqlEnd > 0 && (sqlLines[sqlEnd - 1].trim().startsWith('--') || sqlLines[sqlEnd - 1].trim() === '')) {
      sqlEnd--
    }
    const sql = sqlLines.slice(0, sqlEnd).join('\n').trim()
    if (!sql) continue

    let tableName: string | null = null
    if (type === 'TABLE') {
      tableName = name
    } else if (type === 'CONSTRAINT' || type === 'DEFAULT') {
      tableName = name.split(' ')[0]
    } else if (type === 'SEQUENCE') {
      tableName = seqToTable.get(name) ?? null
      if (!tableName) {
        const m2 = sql.match(/ALTER TABLE public\.(\w+)/)
        if (m2) tableName = m2[1]
      }
    } else if (type === 'INDEX') {
      const m2 = sql.match(/ON public\.(\w+)/)
      if (m2) tableName = m2[1]
    }

    if (tableName) {
      if (!tableMap.has(tableName)) tableMap.set(tableName, [])
      tableMap.get(tableName)!.push(sql)
    }
  }

  return [...tableMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table_name, sqls]) => ({ table_name, sql: sqls.join('\n\n') }))
}

//----------------------------------------------------------------------------------
//  fetchTableMaxIdsFromUrl — get MAX(pk_col) per table for tables that have a sequence
//  Returns table_name → max id. Tables with no sequence or no rows are omitted. Returns {} on error.
//----------------------------------------------------------------------------------
export async function fetchTableMaxIdsFromUrl(url: string, tables: string[]): Promise<Record<string, number | null>> {
  if (tables.length === 0) return {}
  if (!url) return {}
  const db = createArbitraryDb(url)
  try {
    const colResult = await db.query({
      query: `
        SELECT DISTINCT ON (cls.relname)
          cls.relname AS table_name,
          attr.attname AS col_name
        FROM pg_class cls
        JOIN pg_namespace ns   ON ns.oid = cls.relnamespace
        JOIN pg_attribute attr ON attr.attrelid = cls.oid
                               AND attr.attnum > 0 AND NOT attr.attisdropped
        JOIN pg_depend dep     ON dep.refobjid = cls.oid
                               AND dep.refobjsubid = attr.attnum
                               AND dep.classid = 'pg_class'::regclass
                               AND dep.deptype IN ('a', 'i')
        JOIN pg_class seq_cls  ON seq_cls.oid = dep.objid AND seq_cls.relkind = 'S'
        WHERE ns.nspname = 'public'
          AND cls.relkind = 'r'
          AND cls.relname = ANY($1::text[])
        ORDER BY cls.relname, attr.attnum
      `,
      params: [tables],
    })
    if (colResult.rows.length === 0) return {}
    const unions = colResult.rows
      .map((r: { table_name: string; col_name: string }) =>
        `SELECT '${r.table_name}'::text AS t, MAX("${r.col_name}") AS m FROM public."${r.table_name}"`
      )
      .join(' UNION ALL ')
    const maxResult = await db.query({ query: unions })
    const maxIds: Record<string, number | null> = {}
    for (const row of maxResult.rows) {
      maxIds[row.t] = row.m !== null ? parseInt(row.m, 10) : null
    }
    const result = maxIds
    return result
  } catch {
    return {}
  }
}

//----------------------------------------------------------------------------------
//  fetchTableSequencesFromUrl — get next sequence value per table for given tables
//  Returns table_name → next value. Tables with no sequence are omitted. Returns {} on error.
//----------------------------------------------------------------------------------
export async function fetchTableSequencesFromUrl(url: string, tables: string[]): Promise<Record<string, number | null>> {
  if (tables.length === 0) return {}
  if (!url) return {}
  const db = createArbitraryDb(url)
  try {
    const result = await db.query({
      query: `
        SELECT
          cls.relname AS table_name,
          CASE
            WHEN s.last_value IS NOT NULL THEN s.last_value + s.increment_by
            ELSE s.start_value
          END AS next_value
        FROM pg_class cls
        JOIN pg_namespace ns   ON ns.oid = cls.relnamespace
        JOIN pg_attribute attr ON attr.attrelid = cls.oid
                               AND attr.attnum > 0 AND NOT attr.attisdropped
        JOIN pg_depend dep     ON dep.refobjid = cls.oid
                               AND dep.refobjsubid = attr.attnum
                               AND dep.classid = 'pg_class'::regclass
                               AND dep.deptype IN ('a', 'i')
        JOIN pg_class seq_cls  ON seq_cls.oid = dep.objid AND seq_cls.relkind = 'S'
        JOIN pg_sequences s    ON s.sequencename = seq_cls.relname
                               AND s.schemaname = ns.nspname
        WHERE ns.nspname = 'public'
          AND cls.relkind = 'r'
          AND cls.relname = ANY($1::text[])
      `,
      params: [tables],
    })
    const seqs: Record<string, number | null> = {}
    for (const row of result.rows) seqs[row.table_name] = parseInt(row.next_value, 10)
    const result2 = seqs
    return result2
  } catch {
    return {}
  }
}

//----------------------------------------------------------------------------------
//  fetchTablePKMaxFromUrl — get MAX(pk_col) for a single table by looking up its
//  primary key column first. Works whether or not the column has an identity sequence.
//----------------------------------------------------------------------------------
export async function fetchTablePKMaxFromUrl(url: string, tableName: string): Promise<number | null> {
  if (!url || !tableName) return null
  const db = createArbitraryDb(url)
  try {
    const pkResult = await db.query({
      query: `
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_name = $1
        ORDER BY kcu.ordinal_position
        LIMIT 1
      `,
      params: [tableName],
    })
    if (pkResult.rows.length === 0) return null
    const pkCol     = pkResult.rows[0].column_name as string
    const maxResult = await db.query({ query: `SELECT MAX("${pkCol}") AS m FROM public."${tableName}"` })
    const m         = maxResult.rows[0]?.m
    const result    = m !== null && m !== undefined ? parseInt(m, 10) : null
    return result
  } catch {
    return null
  }
}

//----------------------------------------------------------------------------------
//  fetchTableCountsFromUrl — count rows for given tables in a database via URL
//  Uses createArbitraryDb so no env file is needed — URL is passed directly.
//  Tables that do not exist are omitted from the result. Returns {} on any error.
//----------------------------------------------------------------------------------
export async function fetchTableCountsFromUrl(url: string, tables: string[]): Promise<Record<string, number>> {
  if (tables.length === 0) return {}
  if (!url) return {}
  const db = createArbitraryDb(url)
  try {
    const checkResult = await db.query({
      query: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      params: [tables],
    })
    const existing: string[] = checkResult.rows.map((r: { table_name: string }) => r.table_name)
    if (existing.length === 0) return {}
    const unions = existing.map(t => `SELECT '${t}'::text AS t, COUNT(*) AS c FROM public."${t}"`).join(' UNION ALL ')
    const countResult = await db.query({ query: unions })
    const counts: Record<string, number> = {}
    for (const row of countResult.rows) counts[row.t] = parseInt(row.c, 10)
    return counts
  } catch {
    return {}
  }
}

//----------------------------------------------------------------------------------
//  compareSchemasFromUrls — fetch and diff schemas from two databases via URL
//  Uses createArbitraryDb so no env file is needed — URLs are passed directly.
//----------------------------------------------------------------------------------
export async function compareSchemasFromUrls({
  url1,
  url2,
  label1,
  label2,
  excludePrefixes,
}: {
  url1: string
  url2: string
  label1: string
  label2: string
  excludePrefixes?: string
}): Promise<SchemaCompareResult> {
  const db1 = createArbitraryDb(url1)
  const db2 = createArbitraryDb(url2)
  const [rows1, rows2] = await Promise.all([fetchSchema(db1), fetchSchema(db2)])
  const prefixes = (excludePrefixes ?? '').split(',').map(p => p.trim()).filter(Boolean)
  function filter<T extends { table_name: string }>(rows: T[]): T[] {
    return prefixes.length ? rows.filter(r => !prefixes.some(p => r.table_name.startsWith(p))) : rows
  }
  const filtered1 = filter(rows1)
  const diff = diffSchemas(filtered1, filter(rows2), label1, label2)
  return { label1, label2, schema1: filtered1, ...diff }
}

//----------------------------------------------------------------------------------
//  compareDDLsFromUrls — run pg_dump --schema-only against both URLs and diff DDL
//----------------------------------------------------------------------------------
export async function compareDDLsFromUrls({
  url1,
  url2,
  label1,
  label2,
  excludePrefixes,
}: {
  url1:             string
  url2:             string
  label1:           string
  label2:           string
  excludePrefixes?: string
}): Promise<DDLCompareResult> {
  const [src, tgt] = await Promise.all([
    generateCreateSQLFromUrl(url1).catch((): TableDDL[] => []),
    generateCreateSQLFromUrl(url2).catch((): TableDDL[] => []),
  ])
  const prefixes = (excludePrefixes ?? '').split(',').map(p => p.trim()).filter(Boolean)
  function filterTables(tables: TableDDL[]): TableDDL[] {
    return prefixes.length
      ? tables.filter(t => !prefixes.some(p => t.table_name.startsWith(p)))
      : tables
  }
  const srcMap = new Map(filterTables(src).map(t => [t.table_name, t.sql]))
  const tgtMap = new Map(filterTables(tgt).map(t => [t.table_name, t.sql]))
  const result = diffDDLMaps(srcMap, tgtMap, label1, label2)
  return result
}

//----------------------------------------------------------------------------------
//  readSchemaFile — read and parse scripts/schema.sql for a project (private helper)
//----------------------------------------------------------------------------------
async function readSchemaFile(projectKey: string): Promise<TableDDL[]> {
  const filePath = schemaFilePath(projectKey)
  try {
    const content = await readFile(filePath, 'utf8')
    const result  = parsePgDumpByTable(content)
    return result
  } catch {
    return []
  }
}

//----------------------------------------------------------------------------------
//  regenerateSchemaFile — write pg_dump output for a DB back to scripts/schema.sql
//  Tables written alphabetically, one blank line between each.
//----------------------------------------------------------------------------------
export async function regenerateSchemaFile(
  url:        string,
  projectKey: string
): Promise<{ success: boolean; message: string }> {
  try {
    const tables   = await generateCreateSQLFromUrl(url)
    const content  = tables.map(t => `-- Name: ${t.table_name}; Type: TABLE;\n--\n\n${t.sql}`).join('\n\n--\n') + '\n'
    const filePath = schemaFilePath(projectKey)
    try {
      await access(filePath)
    } catch {
      const result = { success: false, message: `File not found: ${filePath}` }
      return result
    }
    await writeFile(filePath, content, 'utf8')
    const result = { success: true, message: `Wrote ${tables.length} tables to scripts/schema.sql` }
    return result
  } catch (e) {
    const result = { success: false, message: (e as Error).message }
    return result
  }
}

//----------------------------------------------------------------------------------
//  compareDDLWithFile — compare a live DB against its scripts/schema.sql snapshot.
//  fileExists: false when the file is missing or empty — caller shows a prompt to
//  regenerate. Uses diffDDLMaps so comparison is identical to DB-vs-DB mode.
//----------------------------------------------------------------------------------
export async function compareDDLWithFile({
  url,
  projectKey,
  label1,
  excludePrefixes,
}: {
  url:              string
  projectKey:       string
  label1:           string
  excludePrefixes?: string
}): Promise<DDLCompareResult & { fileExists: boolean; filePath: string }> {
  const filePath   = schemaFilePath(projectKey)
  const [dbDDL, fileDDL] = await Promise.all([
    generateCreateSQLFromUrl(url).catch((): TableDDL[] => []),
    readSchemaFile(projectKey),
  ])
  const fileExists = fileDDL.length > 0
  const prefixes   = (excludePrefixes ?? '').split(',').map(p => p.trim()).filter(Boolean)
  function filterTables(tables: TableDDL[]): TableDDL[] {
    return prefixes.length
      ? tables.filter(t => !prefixes.some(p => t.table_name.startsWith(p)))
      : tables
  }
  const srcMap  = new Map(filterTables(dbDDL).map(t => [t.table_name, t.sql]))
  const fileMap = new Map(filterTables(fileDDL).map(t => [t.table_name, t.sql]))
  const r       = diffDDLMaps(srcMap, fileMap, label1, 'schema.sql')
  const result  = { ...r, fileExists, filePath }
  return result
}

//----------------------------------------------------------------------------------
//  generateCreateSQLFromUrl — run pg_dump --schema-only against a database URL
//  Returns per-table CREATE TABLE + index DDL. No env file needed — URL direct.
//----------------------------------------------------------------------------------
export async function generateCreateSQLFromUrl(url: string): Promise<TableDDL[]> {
  if (!url) throw new Error('URL is required')
  const cleanUrl = url.replace(/[&?]timezone=[^&]*/g, '')
  let raw: string
  try {
    raw = execPgDump(`--schema-only --no-owner --no-acl --schema=public "${cleanUrl}"`)
  } catch (e) {
    throw new Error(`pg_dump failed: ${(e as Error).message}`)
  }
  if (!raw.trim()) throw new Error('pg_dump returned empty output')
  //
  //  pg_dump on local PostgreSQL emits \unrestrict lines that confuse the parser — strip them
  //
  raw = raw.split('\n').filter(line => !line.startsWith('\\unrestrict ')).join('\n')
  const result = parsePgDumpByTable(raw)
  if (result.length === 0) {
    throw new Error(
      `pg_dump ran (${raw.length} chars) but no tables were parsed. ` +
      `First 300 chars: ${raw.slice(0, 300).replace(/\n/g, '↵')}`
    )
  }
  return result
}
