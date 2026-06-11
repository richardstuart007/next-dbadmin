'use server'

import { execSync } from 'child_process'
import { createArbitraryDb } from '@/src/lib/dbArbitrary'
import { fetchSchema, diffSchemas } from '@/src/actions/schemaUtils'
import type { SchemaCompareResult } from '@/src/actions/schemaUtils'

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
    const sql = lines.slice(sqlStart).join('\n').trim()
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
//  generateCreateSQLFromUrl — run pg_dump --schema-only against a database URL
//  Returns per-table CREATE TABLE + index DDL. No env file needed — URL direct.
//----------------------------------------------------------------------------------
export async function generateCreateSQLFromUrl(url: string): Promise<TableDDL[]> {
  if (!url) throw new Error('URL is required')
  const cleanUrl = url.replace(/[&?]timezone=[^&]*/g, '')
  let raw: string
  try {
    raw = execPgDump(`--schema-only --no-owner --no-acl "${cleanUrl}"`)
  } catch (e) {
    throw new Error(`pg_dump failed: ${(e as Error).message}`)
  }
  if (!raw.trim()) throw new Error('pg_dump returned empty output')
  const result = parsePgDumpByTable(raw)
  if (result.length === 0) {
    throw new Error(
      `pg_dump ran (${raw.length} chars) but no tables were parsed. ` +
      `First 300 chars: ${raw.slice(0, 300).replace(/\n/g, '↵')}`
    )
  }
  return result
}
