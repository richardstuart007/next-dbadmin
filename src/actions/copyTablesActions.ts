'use server'

import { execSync, spawnSync, ExecSyncOptions } from 'child_process'
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { compareSchemasFromUrls, fetchTableCountsFromUrl, fetchTableSequencesFromUrl } from '@/src/actions/schemaSyncActions'
import type { TableStatus } from '@/src/actions/schemaUtils'

const PG_BIN_PATHS = [
  'C:\\Program Files\\PostgreSQL\\18\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
]

function execPg(cmd: string, options: ExecSyncOptions = {}) {
  const augmentedPath = [...PG_BIN_PATHS, process.env.PATH ?? ''].join(';')
  return execSync(cmd, { ...options, env: { ...process.env, PATH: augmentedPath } })
}

function spawnPg(args: string[]): { stdout: string; stderr: string } {
  const augmentedPath = [...PG_BIN_PATHS, process.env.PATH ?? ''].join(';')
  const result = spawnSync('psql', args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: augmentedPath }
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

//----------------------------------------------------------------------------------
//  Types
//----------------------------------------------------------------------------------
export type CopyEvent = 'CREATE_TABLE' | 'COPY' | 'INDEX' | 'SEQUENCE' | 'ERROR' | 'BACKUP' | 'SKIPPED'

export type CopyLog = {
  event: CopyEvent
  detail: string
}

export type CopyResult = {
  success: boolean
  logs: CopyLog[]
}

export type BackupResult = {
  conflicts: string[]
  logs: CopyLog[]
}

export type TableComparisonRow = {
  table:         string
  status:        TableStatus
  sourceCount:   number | null
  targetCount:   number | null
  sourceNextSeq: number | null
  targetNextSeq: number | null
}

//----------------------------------------------------------------------------------
//  stripUnsupportedParams — remove query params unsupported by psql / pg_dump
//----------------------------------------------------------------------------------
function stripUnsupportedParams(url: string): string {
  return url.replace(/[&?]timezone=[^&]*/g, '')
}

//----------------------------------------------------------------------------------
//  check_target_state — check existence and row count for each table in target
//----------------------------------------------------------------------------------
async function check_target_state(
  targetUrl: string,
  tables: string[]
): Promise<Record<string, { exists: boolean; count: number }>> {
  const cleanTarget = stripUnsupportedParams(targetUrl)
  const result: Record<string, { exists: boolean; count: number }> = {}

  for (const table of tables) {
    const { stdout: existsOut } = spawnPg([
      cleanTarget, '-t', '-c',
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${table}'`
    ])
    const exists = parseInt(existsOut.trim(), 10) === 1

    if (!exists) {
      result[table] = { exists: false, count: 0 }
      continue
    }

    const { stdout: countOut } = spawnPg([cleanTarget, '-t', '-c', `SELECT COUNT(*) FROM "${table}"`])
    result[table] = { exists: true, count: parseInt(countOut.trim(), 10) || 0 }
  }

  return result
}

//----------------------------------------------------------------------------------
//  parsePsqlOutput — parse psql stdout into structured log entries
//----------------------------------------------------------------------------------
function parsePsqlOutput(output: string): CopyLog[] {
  const logs: CopyLog[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (/^CREATE TABLE/i.test(trimmed)) {
      logs.push({ event: 'CREATE_TABLE', detail: trimmed })
    } else if (/^COPY (\d+)/.test(trimmed)) {
      const match = trimmed.match(/^COPY (\d+)/)!
      logs.push({ event: 'COPY', detail: `${match[1]} rows copied` })
    } else if (/^CREATE INDEX/i.test(trimmed)) {
      logs.push({ event: 'INDEX', detail: trimmed })
    } else if (/ERROR/i.test(trimmed) && trimmed.length > 5) {
      logs.push({ event: 'ERROR', detail: trimmed })
    }
  }
  return logs
}

//----------------------------------------------------------------------------------
//  get_tables — return all user table names in the public schema for a given URL
//----------------------------------------------------------------------------------
export async function get_tables({
  url,
}: {
  url: string
  caller?: string
}): Promise<string[]> {
  try {
    const cleanUrl = stripUnsupportedParams(url)
    const output = execPg(
      `psql "${cleanUrl}" -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"`,
      { encoding: 'utf8' }
    ) as string
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('('))
  } catch {
    return []
  }
}

//----------------------------------------------------------------------------------
//  repair_sequences — reset every sequence column to MAX(col) so inserts don't collide
//  Searches all columns (not just attnum=1) so tables where the PK is not the first
//  column are handled correctly. Logs an error entry if repair fails.
//----------------------------------------------------------------------------------
async function repair_sequences(cleanTargetUrl: string, table: string): Promise<CopyLog[]> {
  const logs: CopyLog[] = []
  try {
    const { stdout } = spawnPg([
      cleanTargetUrl, '-t', '-c',
      `SELECT attname FROM pg_attribute JOIN pg_class ON pg_class.oid = pg_attribute.attrelid WHERE relname = '${table}' AND attnum > 0 AND NOT attisdropped AND pg_get_serial_sequence('public.${table}', attname) IS NOT NULL ORDER BY attnum LIMIT 1`
    ])
    const colName = stdout.trim()
    if (!colName) return logs

    const { stderr } = spawnPg([
      cleanTargetUrl, '-c',
      `SELECT setval(pg_get_serial_sequence('public.${table}', '${colName}'), GREATEST(COALESCE(MAX("${colName}"), 0), 1), COALESCE(MAX("${colName}"), 0) > 0) FROM public."${table}"`
    ])
    if (stderr && /error/i.test(stderr)) {
      logs.push({ event: 'ERROR', detail: `${table} — sequence repair failed: ${stderr.trim()}` })
    } else {
      logs.push({ event: 'SEQUENCE', detail: `${table} — sequence repaired` })
    }
  } catch (error) {
    logs.push({ event: 'ERROR', detail: `${table} — sequence repair exception: ${(error as Error).message}` })
  }
  return logs
}

//----------------------------------------------------------------------------------
//  copy_tables — copy selected tables from source to target using pg_dump/psql
//  Repairs sequences after each table. Skips tables with existing rows in target.
//----------------------------------------------------------------------------------
export async function copy_tables({
  sourceUrl,
  targetUrl,
  tables,
  sourceLabel = '',
  targetLabel = '',
}: {
  sourceUrl: string
  targetUrl: string
  tables: string[]
  sourceLabel?: string
  targetLabel?: string
  caller?: string
}): Promise<CopyResult> {
  const allLogs: CopyLog[] = []
  let hasError = false

  const cleanSource = stripUnsupportedParams(sourceUrl)
  const cleanTarget = stripUnsupportedParams(targetUrl)

  for (const table of tables) {
    const tableLogs: CopyLog[] = []
    const tmpFile = join(tmpdir(), `copy_${table}_${Date.now()}.sql`)

    try {
      const state = await check_target_state(cleanTarget, [table])
      const targetState = state[table]

      if (targetState.exists && targetState.count > 0) {
        const log: CopyLog = {
          event: 'SKIPPED',
          detail: `${table} — has ${targetState.count.toLocaleString()} rows in target, backup and clear manually first`
        }
        tableLogs.push(log)
        allLogs.push(log)
        continue
      }

      const dumpFlags = targetState.exists
        ? `--no-owner --data-only -t ${table}`
        : `--no-owner -t ${table}`

      try {
        execPg(`pg_dump ${dumpFlags} "${cleanSource}" -f "${tmpFile}"`)
      } catch (error) {
        const msg = (error as Error).message
        const log: CopyLog = { event: 'ERROR', detail: `${table} — pg_dump failed: ${msg}` }
        tableLogs.push(log)
        allLogs.push(log)
        hasError = true
        continue
      }

      const filtered = readFileSync(tmpFile, 'utf8')
        .split('\n')
        .filter(line => !line.match(/transaction_timeout/))
        .filter(line => !line.match(/setval/))
        .join('\n')
      writeFileSync(tmpFile, filtered, 'utf8')

      let psqlOutput = ''
      try {
        psqlOutput = execPg(`psql "${cleanTarget}" -f "${tmpFile}"`, { encoding: 'utf8' }) as string
      } catch (error) {
        psqlOutput = (error as any).stdout ?? ''
      }

      for (const log of parsePsqlOutput(psqlOutput)) {
        const tagged: CopyLog = { event: log.event, detail: `${table} — ${log.detail}` }
        tableLogs.push(tagged)
        allLogs.push(tagged)
        if (log.event === 'ERROR') hasError = true
      }

      const seqLogs = await repair_sequences(cleanTarget, table)
      for (const log of seqLogs) {
        allLogs.push(log)
      }

      void sourceLabel
      void targetLabel

    } finally {
      if (existsSync(tmpFile)) unlinkSync(tmpFile)
    }
  }

  return { success: !hasError, logs: allLogs }
}

//----------------------------------------------------------------------------------
//  backup_tables — snapshot target tables in-place before overwriting them
//  Returns conflicts if any backup names already exist; creates nothing in that case.
//----------------------------------------------------------------------------------
export async function backup_tables({
  targetUrl,
  tables,
}: {
  targetUrl: string
  tables: { table: string; backupName: string }[]
  caller?: string
}): Promise<BackupResult> {
  const cleanTarget = stripUnsupportedParams(targetUrl)
  const backupNames = tables.map(t => t.backupName)

  const namesList = backupNames.map(n => `'${n}'`).join(',')
  const { stdout: checkOut } = spawnPg([
    cleanTarget, '-t', '-c',
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${namesList})`
  ])
  const existing = checkOut.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('('))

  if (existing.length > 0) {
    return { conflicts: existing, logs: [] }
  }

  const logs: CopyLog[] = []
  for (const { table, backupName } of tables) {
    const { stderr } = spawnPg([
      cleanTarget, '-c',
      `CREATE TABLE "${backupName}" AS SELECT * FROM "${table}"`
    ])
    if (stderr && /error/i.test(stderr)) {
      logs.push({ event: 'ERROR', detail: `${backupName} — ${stderr.trim()}` })
    } else {
      logs.push({ event: 'BACKUP', detail: `${backupName} — created from ${table}` })
    }
  }

  return { conflicts: [], logs }
}

//----------------------------------------------------------------------------------
//  compare_tables — compare tables between source and target by schema then row count
//  Status mirrors schema sync: identical/different/only_in_source/only_in_target.
//----------------------------------------------------------------------------------
export async function compare_tables({
  sourceUrl,
  targetUrl,
}: {
  sourceUrl: string
  targetUrl: string
  caller?:   string
}): Promise<TableComparisonRow[]> {
  const schemaResult = await compareSchemasFromUrls({
    url1:   sourceUrl,
    url2:   targetUrl,
    label1: '',
    label2: '',
  })

  const allTables = schemaResult.tableSummary.map(t => t.table_name)

  const [sourceCounts, targetCounts, sourceSeqs, targetSeqs] = await Promise.all([
    fetchTableCountsFromUrl(sourceUrl, allTables),
    fetchTableCountsFromUrl(targetUrl, allTables),
    fetchTableSequencesFromUrl(sourceUrl, allTables),
    fetchTableSequencesFromUrl(targetUrl, allTables),
  ])

  return schemaResult.tableSummary.map(t => ({
    table:         t.table_name,
    status:        t.status,
    sourceCount:   t.status !== 'only_in_target' ? (sourceCounts[t.table_name] ?? null) : null,
    targetCount:   t.status !== 'only_in_source' ? (targetCounts[t.table_name] ?? null) : null,
    sourceNextSeq: t.status !== 'only_in_target' ? (sourceSeqs[t.table_name] ?? null) : null,
    targetNextSeq: t.status !== 'only_in_source' ? (targetSeqs[t.table_name] ?? null) : null,
  }))
}

//----------------------------------------------------------------------------------
//  truncate_table — remove all rows from a table in the target database
//----------------------------------------------------------------------------------
export async function truncate_table({
  targetUrl,
  table,
}: {
  targetUrl: string
  table:     string
  caller?:   string
}): Promise<{ success: boolean; message: string }> {
  const cleanTarget = stripUnsupportedParams(targetUrl)
  const { stderr } = spawnPg([cleanTarget, '-c', `TRUNCATE TABLE "${table}"`])
  if (stderr && /error/i.test(stderr)) {
    return { success: false, message: stderr.trim() }
  }
  await repair_sequences(cleanTarget, table)
  return { success: true, message: `${table} truncated and sequence reset` }
}

//----------------------------------------------------------------------------------
//  drop_table — permanently delete a table from the target database
//----------------------------------------------------------------------------------
export async function drop_table({
  targetUrl,
  table,
}: {
  targetUrl: string
  table:     string
  caller?:   string
}): Promise<{ success: boolean; message: string }> {
  const cleanTarget = stripUnsupportedParams(targetUrl)
  const { stderr } = spawnPg([cleanTarget, '-c', `DROP TABLE "${table}"`])
  if (stderr && /error/i.test(stderr)) {
    return { success: false, message: stderr.trim() }
  }
  return { success: true, message: `${table} dropped` }
}
