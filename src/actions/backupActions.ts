'use server'

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createArbitraryDb } from '@/src/lib/dbArbitrary'

//----------------------------------------------------------------------------------
//  list_tables_url — list all public tables with row counts from a database URL
//----------------------------------------------------------------------------------
export async function list_tables_url(url: string): Promise<{ table: string; count: number }[]> {
  if (!url) return []
  const db = createArbitraryDb(url)
  try {
    const tablesRes = await db.query({
      query: `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    })
    const tables: string[] = tablesRes.rows.map((r: { tablename: string }) => r.tablename)
    if (tables.length === 0) return []
    const unions = tables
      .map(t => `SELECT '${t}'::text AS t, COUNT(*)::int AS c FROM public."${t}"`)
      .join(' UNION ALL ')
    const countRes = await db.query({ query: unions })
    const countMap: Record<string, number> = {}
    for (const row of countRes.rows) countMap[row.t] = row.c
    return tables.map(t => ({ table: t, count: countMap[t] ?? 0 }))
  } catch {
    return []
  }
}

//----------------------------------------------------------------------------------
//  check_tables_url — check existence and row count for given table names
//----------------------------------------------------------------------------------
export async function check_tables_url(
  url: string,
  names: string[]
): Promise<{ name: string; exists: boolean; count: number }[]> {
  if (!url || names.length === 0) return names.map(name => ({ name, exists: false, count: 0 }))
  const db = createArbitraryDb(url)
  try {
    const existsRes = await db.query({
      query: `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      params: [names],
    })
    const existingSet = new Set(existsRes.rows.map((r: { tablename: string }) => r.tablename))
    const existing = names.filter(n => existingSet.has(n))
    const countMap: Record<string, number> = {}
    if (existing.length > 0) {
      const unions = existing
        .map(t => `SELECT '${t}'::text AS t, COUNT(*)::int AS c FROM public."${t}"`)
        .join(' UNION ALL ')
      const countRes = await db.query({ query: unions })
      for (const row of countRes.rows) countMap[row.t] = row.c
    }
    return names.map(name => ({
      name,
      exists: existingSet.has(name),
      count: countMap[name] ?? 0,
    }))
  } catch {
    return names.map(name => ({ name, exists: false, count: 0 }))
  }
}

//----------------------------------------------------------------------------------
//  table_duplicate_url — CREATE TABLE backup LIKE base INCLUDING ALL
//----------------------------------------------------------------------------------
export async function table_duplicate_url(url: string, from: string, to: string): Promise<void> {
  const db = createArbitraryDb(url)
  await db.query({ query: `CREATE TABLE public."${to}" (LIKE public."${from}" INCLUDING ALL)` })
}

//----------------------------------------------------------------------------------
//  table_copy_url — INSERT INTO backup SELECT * FROM base
//----------------------------------------------------------------------------------
export async function table_copy_url(url: string, from: string, to: string): Promise<void> {
  const db = createArbitraryDb(url)
  await db.query({ query: `INSERT INTO public."${to}" SELECT * FROM public."${from}"` })
}

//----------------------------------------------------------------------------------
//  table_truncate_url — TRUNCATE a table
//----------------------------------------------------------------------------------
export async function table_truncate_url(url: string, table: string): Promise<void> {
  const db = createArbitraryDb(url)
  await db.query({ query: `TRUNCATE public."${table}"` })
}

//----------------------------------------------------------------------------------
//  table_drop_url — DROP TABLE IF EXISTS
//----------------------------------------------------------------------------------
export async function table_drop_url(url: string, table: string): Promise<void> {
  const db = createArbitraryDb(url)
  await db.query({ query: `DROP TABLE IF EXISTS public."${table}"` })
}

//----------------------------------------------------------------------------------
//  table_seqreset_url — reset all sequences on a table to MAX(pk)
//----------------------------------------------------------------------------------
export async function table_seqreset_url(url: string, table: string): Promise<void> {
  const db = createArbitraryDb(url)
  const seqSql = `
DO $$
DECLARE
  r RECORD;
  v BIGINT;
BEGIN
  FOR r IN
    SELECT a.attname, pg_get_serial_sequence('public."${table}"', a.attname) AS seq
    FROM pg_class t
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = '${table}'
      AND pg_get_serial_sequence('public."${table}"', a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM public."${table}"', r.attname) INTO v;
    PERFORM setval(r.seq, GREATEST(v, 1), v > 0);
  END LOOP;
END $$`
  await db.query({ query: seqSql })
}

//----------------------------------------------------------------------------------
//  table_export_json — export all rows from a table to a JSON file
//----------------------------------------------------------------------------------
export async function table_export_json(
  url: string,
  table: string,
  filePath: string
): Promise<boolean> {
  const db = createArbitraryDb(url)
  try {
    const result = await db.query({ query: `SELECT json_agg(t) FROM public."${table}" t` })
    const rows = result.rows[0]?.json_agg
    if (!rows || !Array.isArray(rows)) return false
    const dir = filePath.substring(0, filePath.lastIndexOf('/') || filePath.lastIndexOf('\\'))
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, JSON.stringify(rows, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

//----------------------------------------------------------------------------------
//  table_import_json — insert rows from a JSON file into a table in batches of 100
//----------------------------------------------------------------------------------
export async function table_import_json(
  url: string,
  table: string,
  filePath: string
): Promise<number> {
  if (!existsSync(filePath)) return 0
  const BATCH = 100
  const db = createArbitraryDb(url)
  try {
    const jsonData: Record<string, unknown>[] = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!Array.isArray(jsonData) || jsonData.length === 0) return 0
    let total = 0
    for (let i = 0; i < jsonData.length; i += BATCH) {
      const batch = jsonData.slice(i, i + BATCH)
      const cols = Object.keys(batch[0])
      const placeholders = batch
        .map((_, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(', ')})`)
        .join(', ')
      const values = batch.flatMap(row => cols.map(c => row[c]))
      const result = await db.query({
        query: `INSERT INTO public."${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${placeholders}`,
        params: values,
      })
      total += result.rowCount ?? 0
    }
    return total
  } catch {
    return 0
  }
}

//----------------------------------------------------------------------------------
//  directory_list_local — list file names in a local directory (no DB needed)
//----------------------------------------------------------------------------------
export async function directory_list_local(dirPath: string): Promise<string[]> {
  try {
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return []
    return readdirSync(dirPath).filter(f => statSync(join(dirPath, f)).isFile())
  } catch {
    return []
  }
}

//----------------------------------------------------------------------------------
//  file_count_json_local — count rows in a JSON array file (no DB needed)
//----------------------------------------------------------------------------------
export async function file_count_json_local(filePath: string): Promise<number> {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return 0
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    return Array.isArray(parsed) ? parsed.length : 0
  } catch {
    return 0
  }
}
