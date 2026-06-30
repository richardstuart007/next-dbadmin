'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyInput } from 'nextjs-shared/MyInput'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import {
  compareDDLsFromUrls,
  compareDDLWithFile,
  fetchTableCountsFromUrl,
  fetchTablePKMaxFromUrl,
  regenerateSchemaFile,
} from '@/src/actions/schemaSyncActions'
import type { DDLCompareResult, DDLComparisonRow } from '@/src/actions/schemaUtils'
import ConnectionPicker from './ConnectionPicker'
import type { ConnectionEntry } from '@/src/types/connections'

type CompareMode = 'db' | 'file'

type DiffLine = { text: string; kind: 'same' | 'src' | 'tgt' }

const HELP_ITEMS: HelpItem[] = [
  {
    heading: 'Target DB mode',
    body: 'Runs pg_dump --schema-only against both databases and compares full DDL per table — columns, types, identity sequences, constraints, and indexes. Source is the reference.',
  },
  {
    heading: 'Schema file mode',
    body: 'Compares the live local database against its committed scripts/schema.sql snapshot. Use Regenerate to update the file from the DB, then commit the diff.',
  },
  {
    heading: 'Different',
    body: 'DDL differs. Lines highlighted blue appear only in the source; lines highlighted orange appear only in the target.',
  },
  {
    heading: 'Source Only',
    body: 'Table exists in source but not in target. The source DDL is exactly what to run in the target to create it.',
  },
  {
    heading: 'Target Only',
    body: 'Table exists in target but not in source — orphan in target.',
  },
]

//----------------------------------------------------------------------------------------------
//  lineDiff — LCS-based line diff. srcLines contains 'same'/'src' lines;
//  tgtLines contains 'same'/'tgt' lines. Used to highlight what changed per panel.
//----------------------------------------------------------------------------------------------
function lineDiff(src: string, tgt: string): { srcLines: DiffLine[]; tgtLines: DiffLine[] } {
  const a = src.split('\n').filter(l => l.trim())
  const b = tgt.split('\n').filter(l => l.trim())
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1].trim() === b[j - 1].trim()
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const srcLines: DiffLine[] = []
  const tgtLines: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (
      i > 0 && j > 0 &&
      a[i - 1].trim() === b[j - 1].trim() &&
      dp[i - 1][j] < dp[i][j] &&
      dp[i][j - 1] < dp[i][j]
    ) {
      srcLines.unshift({ text: a[i - 1], kind: 'same' })
      tgtLines.unshift({ text: b[j - 1], kind: 'same' })
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      tgtLines.unshift({ text: b[j - 1], kind: 'tgt' })
      j--
    } else {
      srcLines.unshift({ text: a[i - 1], kind: 'src' })
      i--
    }
  }
  return { srcLines, tgtLines }
}

//----------------------------------------------------------------------------------------------
//  SchemaSyncConn — compare full DDL between two sources via pg_dump --schema-only.
//  Two modes: Target DB (DB vs DB) and Schema file (DB vs scripts/schema.sql).
//----------------------------------------------------------------------------------------------
export default function SchemaSyncConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey  = connections[0]?.key ?? ''
  const secondKey = connections[1]?.key ?? connections[0]?.key ?? ''

  const [sourceKey, setSourceKey]         = useState(firstKey)
  const [targetKey, setTargetKey]         = useState(secondKey)
  const [compareMode, setCompareMode]     = useState<CompareMode>('db')
  const [result, setResult]               = useState<DDLCompareResult | null>(null)
  const [excludePrefix, setExcludePrefix] = useState('bk_,local_,prod_,dev_,z1_')
  const [message, setMessage]             = useState('')
  const [running, setRunning]             = useState(false)
  const [sourceCounts, setSourceCounts]   = useState<Record<string, number>>({})
  const [targetCounts, setTargetCounts]   = useState<Record<string, number>>({})
  const [selectedTable, setSelectedTable] = useState('')
  const [applyMaxId, setApplyMaxId]       = useState<number | null>(null)

  const sourceConn  = connections.find(c => c.key === sourceKey)
  const targetConn  = connections.find(c => c.key === targetKey)
  const sameUrl     = compareMode === 'db' && !!(sourceConn?.url && targetConn?.url && sourceConn.url === targetConn.url)
  const diffProject = sourceConn && targetConn && sourceConn.projectKey !== targetConn.projectKey

  //----------------------------------------------------------------------------------------------
  //  handleSourceChange — when source project changes, syncs target to same project+env
  //----------------------------------------------------------------------------------------------
  function handleSourceChange(key: string) {
    const newConn = connections.find(c => c.key === key)
    const oldConn = connections.find(c => c.key === sourceKey)
    if (newConn && oldConn && newConn.projectKey !== oldConn.projectKey) {
      //
      //  Project changed — keep env if new project has it, otherwise use first env
      //
      const targetEnv   = targetKey.split('.')[1] ?? ''
      const sameEnv     = connections.find(c => c.projectKey === newConn.projectKey && c.key.split('.')[1] === targetEnv)
      const firstForNew = connections.find(c => c.projectKey === newConn.projectKey)
      const newTarget   = sameEnv ?? firstForNew
      if (newTarget) setTargetKey(newTarget.key)
    }
    setSourceKey(key)
    setResult(null)
    setMessage('')
  }

  //----------------------------------------------------------------------------------------------
  //  handleModeChange — switches compare mode and resets result
  //----------------------------------------------------------------------------------------------
  function handleModeChange(mode: CompareMode) {
    setCompareMode(mode)
    setResult(null)
    setMessage('')
  }

  //----------------------------------------------------------------------------------------------
  //  handleCompare — runs DDL comparison in the selected mode
  //----------------------------------------------------------------------------------------------
  async function handleCompare() {
    if (!sourceConn?.url) { setMessage('No URL configured for source — check connections.json'); return }
    if (compareMode === 'db' && !targetConn?.url) { setMessage(`No URL configured for ${targetConn?.label ?? 'target'} — check connections.json`); return }
    setRunning(true)
    setResult(null)
    setSourceCounts({})
    setTargetCounts({})
    setSelectedTable('')
    setMessage(compareMode === 'db' ? 'Comparing schemas...' : 'Comparing with schema.sql...')
    try {
      let r: DDLCompareResult
      if (compareMode === 'db') {
        r = await compareDDLsFromUrls({
          url1:            sourceConn.url,
          url2:            targetConn!.url,
          label1:          sourceConn.label,
          label2:          targetConn!.label,
          excludePrefixes: excludePrefix,
        })
      } else {
        const fileResult = await compareDDLWithFile({
          url:             sourceConn.url,
          projectKey:      sourceConn.projectKey,
          label1:          sourceConn.label,
          excludePrefixes: excludePrefix,
        })
        if (!fileResult.fileExists) {
          setMessage(`File not found: ${fileResult.filePath}`)
          return
        }
        r = fileResult
      }
      setResult(r)
      const diffCount = r.rows.filter(t => t.status !== 'identical').length
      setMessage(diffCount === 0
        ? 'Schemas are identical'
        : `Found differences in ${diffCount} table${diffCount !== 1 ? 's' : ''}`)
      if (compareMode === 'db') {
        const allTables = r.rows.map(t => t.table_name)
        const [sc, tc] = await Promise.all([
          fetchTableCountsFromUrl(sourceConn.url, allTables),
          fetchTableCountsFromUrl(targetConn!.url, allTables),
        ])
        setSourceCounts(sc)
        setTargetCounts(tc)
      }
    } catch {
      setMessage('Failed to compare schemas')
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleRegenerate — writes pg_dump output for the source DB to scripts/schema.sql
  //----------------------------------------------------------------------------------------------
  async function handleRegenerate() {
    if (!sourceConn?.url) return
    setRunning(true)
    setResult(null)
    setMessage('Overwriting schema.sql...')
    try {
      const r = await regenerateSchemaFile(sourceConn.url, sourceConn.projectKey)
      if (!r.success) { setMessage(r.message); return }
      setMessage(`${r.message} — comparing...`)
    } catch {
      setMessage('Failed to overwrite schema.sql')
      return
    } finally {
      setRunning(false)
    }
    await handleCompare()
  }

  //----------------------------------------------------------------------------------------------
  //  handleSelectTable — selects a table row; fetches target max PK for Apply SQL panel
  //----------------------------------------------------------------------------------------------
  function handleSelectTable(tableName: string) {
    const newTable = selectedTable === tableName ? '' : tableName
    setSelectedTable(newTable)
    setApplyMaxId(null)
    if (newTable && compareMode === 'db' && targetConn?.url) {
      const row = result?.rows.find(r => r.table_name === newTable)
      if (row && row.status === 'different') {
        fetchTablePKMaxFromUrl(targetConn.url, newTable).then(max => {
          setApplyMaxId(max)
        })
      }
    }
  }

  const statusCounts = result
    ? result.rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1
        return acc
      }, {})
    : {}

  const selectedRow = result?.rows.find(r => r.table_name === selectedTable) ?? null

  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2'>
        <MyHelp items={HELP_ITEMS} title='Schema Sync Help' label='Help' />
      </div>

      <div className='space-y-2'>
        <ConnectionPicker
          label='Source'
          connections={connections}
          value={sourceKey}
          onChange={handleSourceChange}
        />

        <div className='flex items-center gap-2'>
          <label className='text-xs font-bold w-16 text-right shrink-0'>Compare</label>
          <div className='flex items-center gap-4'>
            <label className='flex items-center gap-1 text-xs cursor-pointer'>
              <input
                type='radio'
                name='compareMode'
                value='db'
                checked={compareMode === 'db'}
                onChange={() => handleModeChange('db')}
              />
              Target DB
            </label>
            <label className='flex items-center gap-1 text-xs cursor-pointer'>
              <input
                type='radio'
                name='compareMode'
                value='file'
                checked={compareMode === 'file'}
                onChange={() => handleModeChange('file')}
              />
              scripts/schema.sql
            </label>
            {compareMode === 'file' && (
              <MyButton onClick={handleRegenerate} overrideClass='h-6 px-2 py-2' disabled={!sourceKey || running}>
                Overwrite schema.sql
              </MyButton>
            )}
          </div>
        </div>

        {compareMode === 'db' && (
          <ConnectionPicker
            label='Target'
            connections={connections}
            value={targetKey}
            onChange={v => { setTargetKey(v); setResult(null); setMessage('') }}
            highlight={!!diffProject}
          />
        )}
      </div>

      <div className='flex items-center gap-2'>
        <label className='text-xs font-bold w-16 text-right shrink-0'>Exclude</label>
        <MyInput
          overrideClass='w-72'
          type='text'
          value={excludePrefix}
          onChange={e => setExcludePrefix(e.target.value)}
        />
        <MyHelp items={[{
          heading: 'Exclude tables',
          body: 'Comma-separated prefixes — tables whose names start with any of these are ignored entirely.',
        }]} />
      </div>

      <div className='ml-20 flex items-center gap-2'>
        {sameUrl ? (
          <p className='text-xs font-bold text-red-700'>Same URL for Source and Target</p>
        ) : (
          <MyButton onClick={handleCompare} overrideClass='h-6 px-2 py-2' disabled={!sourceKey || running}>
            Compare Schemas
          </MyButton>
        )}
      </div>

      {message && <p className='text-xs text-red-700'>{message}</p>}

      {result && (
        <div className='space-y-2'>
          <div className='flex items-center gap-3'>
            <p className='text-xs font-semibold'>Table Summary ({result.rows.length} tables)</p>
            <span className='text-xs text-green-700'>{statusCounts.identical ?? 0} Identical</span>
            {(statusCounts.different      ?? 0) > 0 && <span className='text-xs text-yellow-700'>{statusCounts.different} Different</span>}
            {(statusCounts.only_in_source ?? 0) > 0 && <span className='text-xs text-blue-700'>{statusCounts.only_in_source} Source Only</span>}
            {(statusCounts.only_in_target ?? 0) > 0 && <span className='text-xs text-orange-700'>{statusCounts.only_in_target} Target Only</span>}
          </div>
          <div className='flex items-start gap-4'>
            <TableSummarySection
              rows={result.rows}
              label1={result.label1}
              label2={result.label2}
              sourceCounts={sourceCounts}
              targetCounts={targetCounts}
              showCounts={compareMode === 'db'}
              selectedTable={selectedTable}
              onSelectTable={handleSelectTable}
            />
            {selectedRow && (
              <DDLPanel
                row={selectedRow}
                label1={result.label1}
                label2={result.label2}
                compareMode={compareMode}
                applyMaxId={applyMaxId}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

//----------------------------------------------------------------------------------------------
//  statusMeta — maps TableStatus to display label and colour class
//----------------------------------------------------------------------------------------------
export function statusMeta(status: string) {
  switch (status) {
    case 'identical':      return { label: 'Identical', className: 'bg-green-100 text-green-800' }
    case 'different':      return { label: 'Different', className: 'bg-yellow-100 text-yellow-800' }
    case 'only_in_source': return { label: 'Source',    className: 'bg-blue-100 text-blue-800' }
    case 'only_in_target': return { label: 'Target',    className: 'bg-orange-100 text-orange-800' }
    default:               return { label: status,      className: 'bg-gray-100 text-gray-800' }
  }
}

export const STATUS_FILTER_OPTIONS = [
  { value: 'identical'      as const, label: 'Identical' },
  { value: 'different'      as const, label: 'Different' },
  { value: 'only_in_source' as const, label: 'Source' },
  { value: 'only_in_target' as const, label: 'Target' },
]

//----------------------------------------------------------------------------------------------
//  DiffPreBlock — renders diff lines with per-line highlighting for changed lines
//----------------------------------------------------------------------------------------------
function DiffPreBlock({ lines, highlightClass }: { lines: DiffLine[]; highlightClass: string }) {
  return (
    <pre className='text-xs font-mono bg-gray-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-96'>
      {lines.map((l, i) => (
        <span
          key={i}
          className={`block ${l.kind !== 'same' ? highlightClass : ''}`}
        >{l.text}</span>
      ))}
    </pre>
  )
}

//----------------------------------------------------------------------------------------------
//  parseColumnLine — parse one column definition line from a CREATE TABLE body into parts.
//  Normalises CONSTRAINT <name> NOT NULL → NOT NULL and records the constraint name.
//----------------------------------------------------------------------------------------------
type ParsedColumn = {
  name:             string
  typeStr:          string
  notNull:          boolean
  defaultVal:       string | null
  namedConstraints: string[]
}

function parseColumnLine(line: string): ParsedColumn | null {
  const trimmed = line.trim().replace(/,$/, '')
  const match   = trimmed.match(/^(\S+)\s+(.*)$/)
  if (!match) return null
  const name              = match[1]
  const namedConstraints: string[] = []
  let rest = match[2].replace(/CONSTRAINT\s+(\S+)\s+NOT\s+NULL/gi, (_, cname: string) => {
    namedConstraints.push(cname)
    return 'NOT NULL'
  })
  const notNull      = /NOT NULL/i.test(rest)
  rest               = rest.replace(/NOT NULL/gi, '').trim()
  let defaultVal: string | null = null
  const defaultMatch = rest.match(/DEFAULT\s+(.+)$/i)
  if (defaultMatch) {
    defaultVal = defaultMatch[1].trim()
    rest       = rest.replace(/DEFAULT\s+.+$/i, '').trim()
  }
  const result: ParsedColumn = { name, typeStr: rest.trim(), notNull, defaultVal, namedConstraints }
  return result
}

//----------------------------------------------------------------------------------------------
//  parseCreateTableColumns — extract column definitions from the CREATE TABLE block of a DDL
//----------------------------------------------------------------------------------------------
function parseCreateTableColumns(ddl: string): Map<string, ParsedColumn> {
  const cols  = new Map<string, ParsedColumn>()
  const block = ddl.match(/CREATE TABLE[^(]+\((.+?)\);/s)?.[1]
  if (!block) return cols
  for (const line of block.split('\n')) {
    if (!line.trim()) continue
    const col = parseColumnLine(line)
    if (col) cols.set(col.name, col)
  }
  return cols
}

//----------------------------------------------------------------------------------------------
//  generateApplyStatements — produce ALTER TABLE statements to apply to the target so it
//  matches the source. Handles column nullability, defaults, type changes, new columns,
//  named constraint removal, and source-only ALTER TABLE blocks (IDENTITY, constraints).
//----------------------------------------------------------------------------------------------
function generateApplyStatements(sourceDDL: string, targetDDL: string, applyMaxId: number | null): string {
  const tableMatch    = sourceDDL.match(/CREATE TABLE\s+(public\.\S+)\s*\(/)
  const fullTableName = tableMatch?.[1] ?? 'public.unknown'
  const srcCols       = parseCreateTableColumns(sourceDDL)
  const tgtCols       = parseCreateTableColumns(targetDDL)
  const lines: string[] = []

  //
  //  Column-level diffs from the CREATE TABLE block
  //
  for (const [name, src] of srcCols) {
    const tgt = tgtCols.get(name)
    if (!tgt) {
      const defStr     = src.defaultVal ? ` DEFAULT ${src.defaultVal}` : ''
      const notNullStr = src.notNull    ? ' NOT NULL'                  : ''
      lines.push(`ALTER TABLE ${fullTableName} ADD COLUMN ${name} ${src.typeStr}${defStr}${notNullStr};`)
      continue
    }
    if (src.typeStr !== tgt.typeStr) {
      lines.push(`ALTER TABLE ${fullTableName} ALTER COLUMN ${name} TYPE ${src.typeStr};`)
    }
    if (src.notNull !== tgt.notNull) {
      lines.push(src.notNull
        ? `ALTER TABLE ${fullTableName} ALTER COLUMN ${name} SET NOT NULL;`
        : `ALTER TABLE ${fullTableName} ALTER COLUMN ${name} DROP NOT NULL;`)
    }
    //
    //  Named NOT NULL constraints in target that source doesn't have → drop from target
    //
    for (const cname of tgt.namedConstraints) {
      if (!src.namedConstraints.includes(cname)) {
        lines.push(`ALTER TABLE ${fullTableName} DROP CONSTRAINT ${cname};`)
      }
    }
    if (src.defaultVal !== tgt.defaultVal) {
      lines.push(src.defaultVal
        ? `ALTER TABLE ${fullTableName} ALTER COLUMN ${name} SET DEFAULT ${src.defaultVal};`
        : `ALTER TABLE ${fullTableName} ALTER COLUMN ${name} DROP DEFAULT;`)
    }
  }
  for (const name of tgtCols.keys()) {
    if (!srcCols.has(name)) {
      lines.push(`-- Column only in target: ALTER TABLE ${fullTableName} DROP COLUMN ${name};`)
    }
  }

  //
  //  Statement-level diffs — non-CREATE-TABLE blocks (IDENTITY, constraints) missing from target
  //
  const tgtLineSet = new Set(targetDDL.split('\n').map(l => l.trim().replace(/;$/, '')).filter(Boolean))
  for (const stmt of sourceDDL.split(/;\n+/).map(s => s.trim()).filter(Boolean)) {
    if (stmt.trimStart().startsWith('CREATE TABLE')) continue
    if (stmt.split('\n').map(l => l.trim().replace(/;$/, '')).filter(Boolean).some(l => !tgtLineSet.has(l))) {
      let adjusted = stmt + ';'
      if (applyMaxId !== null) {
        adjusted = adjusted.replace(/START WITH \d+/g, `START WITH ${applyMaxId + 1}`)
      }
      lines.push(adjusted)
    }
  }

  return lines.join('\n')
}

//----------------------------------------------------------------------------------------------
//  ApplySQLPanel — shows copyable SQL to apply to target, with corrected START WITH value
//----------------------------------------------------------------------------------------------
function ApplySQLPanel({ sql, targetLabel, note }: { sql: string; targetLabel: string; note: string }) {
  return (
    <div className='space-y-1 mt-2'>
      <p className='text-xs font-semibold text-gray-700'>SQL to Apply to {targetLabel}</p>
      <p className='text-xs text-gray-500'>{note}</p>
      <pre className='text-xs font-mono bg-gray-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-64'>
        {sql}
      </pre>
    </div>
  )
}

//----------------------------------------------------------------------------------------------
//  DDLPanel — shows DDL for a selected table, adapting to its comparison status.
//  Different tables get side-by-side line-level diff highlighting.
//  In DB mode, an Apply SQL panel is shown for actionable statuses with correct START WITH.
//----------------------------------------------------------------------------------------------
function DDLPanel({
  row, label1, label2, compareMode, applyMaxId,
}: {
  row:         DDLComparisonRow
  label1:      string
  label2:      string
  compareMode: CompareMode
  applyMaxId:  number | null
}) {
  if (row.status === 'identical') {
    return (
      <div className='flex-1'>
        <p className='text-xs text-green-700 mb-1'>DDL is identical in both sources</p>
        <pre className='text-xs font-mono bg-gray-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-96'>
          {row.sourceDDL}
        </pre>
      </div>
    )
  }
  if (row.status === 'only_in_source') {
    const applySQL = row.sourceDDL ?? ''
    return (
      <div className='flex-1'>
        <p className='text-xs text-blue-700 mb-1'>Only in {label1} — run this DDL in {label2} to create it</p>
        <pre className='text-xs font-mono bg-blue-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-96'>
          {row.sourceDDL}
        </pre>
        {compareMode === 'db' && applySQL && (
          <ApplySQLPanel sql={applySQL} targetLabel={label2} note='New table — START WITH 1 is correct (no existing rows)' />
        )}
      </div>
    )
  }
  if (row.status === 'only_in_target') {
    return (
      <div className='flex-1'>
        <p className='text-xs text-orange-700 mb-1'>Only in {label2} — orphan not in {label1}</p>
        <pre className='text-xs font-mono bg-orange-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-96'>
          {row.targetDDL}
        </pre>
      </div>
    )
  }
  const { srcLines, tgtLines } = lineDiff(row.sourceDDL ?? '', row.targetDDL ?? '')
  const applySQL  = generateApplyStatements(row.sourceDDL ?? '', row.targetDDL ?? '', applyMaxId)
  const applyNote = applyMaxId !== null ? `START WITH adjusted to ${applyMaxId + 1} (target MAX + 1).` : ''
  return (
    <div className='flex-1 space-y-1'>
      <p className='text-xs text-yellow-700'>DDL differs — {label1} is the reference. Highlighted lines exist only in that panel.</p>
      <div className='flex gap-2 items-start'>
        <div className='flex-1'>
          <p className='text-xs font-semibold text-gray-600 mb-1'>{label1}</p>
          <DiffPreBlock lines={srcLines} highlightClass='bg-blue-200 text-blue-900' />
        </div>
        <div className='flex-1'>
          <p className='text-xs font-semibold text-gray-600 mb-1'>{label2}</p>
          <DiffPreBlock lines={tgtLines} highlightClass='bg-orange-200 text-orange-900' />
        </div>
      </div>
      {compareMode === 'db' && applySQL && (
        <ApplySQLPanel sql={applySQL} targetLabel={label2} note={applyNote} />
      )}
    </div>
  )
}

//----------------------------------------------------------------------------------------------
//  TableSummarySection — per-table status grid with optional row counts
//----------------------------------------------------------------------------------------------
function TableSummarySection({
  rows, label1, label2, sourceCounts, targetCounts, showCounts, selectedTable, onSelectTable,
}: {
  rows:          DDLComparisonRow[]
  label1:        string
  label2:        string
  sourceCounts:  Record<string, number>
  targetCounts:  Record<string, number>
  showCounts:    boolean
  selectedTable: string
  onSelectTable: (table: string) => void
}) {
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set())

  if (rows.length === 0) return null

  const isAll        = selectedStatuses.size === 0
  const filteredRows = isAll ? rows : rows.filter(r => selectedStatuses.has(r.status))

  //----------------------------------------------------------------------------------------------
  //  toggleStatus — status filter checkbox state
  //----------------------------------------------------------------------------------------------
  function toggleStatus(value: string) {
    setSelectedStatuses(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  return (
    <div className='border rounded bg-white w-fit'>
      <table className='text-xs'>
        <thead className='bg-gray-50 sticky top-0'>
          <tr>
            <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Table</th>
            <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>
              <details className='relative'>
                <summary className='cursor-pointer list-none font-medium text-gray-500 hover:text-gray-700'>
                  {isAll ? 'Status ▾' : `Status (${selectedStatuses.size}/${STATUS_FILTER_OPTIONS.length}) ▾`}
                </summary>
                <div className='absolute z-20 bg-white border border-gray-200 rounded shadow-md p-2 space-y-1 min-w-28'>
                  <label className='flex items-center gap-1 cursor-pointer whitespace-nowrap border-b border-gray-100 pb-1 mb-1'>
                    <input type='checkbox' checked={isAll} onChange={() => setSelectedStatuses(new Set())} />
                    <span className='text-xs font-semibold'>All</span>
                  </label>
                  {STATUS_FILTER_OPTIONS.map(o => (
                    <label key={o.value} className='flex items-center gap-1 cursor-pointer whitespace-nowrap'>
                      <input
                        type='checkbox'
                        checked={!isAll && selectedStatuses.has(o.value)}
                        onChange={() => toggleStatus(o.value)}
                      />
                      <span className='text-xs'>{o.label}</span>
                    </label>
                  ))}
                </div>
              </details>
            </th>
            {showCounts && <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>{label1}</th>}
            {showCounts && <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>{label2}</th>}
            {showCounts && <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Counts</th>}
          </tr>
        </thead>
        <tbody>
          {filteredRows.map(r => {
            const meta         = statusMeta(r.status)
            const sc           = sourceCounts[r.table_name]
            const tc           = targetCounts[r.table_name]
            const countsLoaded = showCounts && sc != null && tc != null
            const countsMatch  = countsLoaded && sc === tc
            return (
              <tr
                key={r.table_name}
                onClick={() => onSelectTable(r.table_name)}
                className={`border-b border-gray-100 cursor-pointer hover:bg-blue-50 ${selectedTable === r.table_name ? 'bg-blue-100' : ''}`}
              >
                <td className={`px-2 py-1 font-mono ${r.status !== 'identical' ? 'font-semibold' : 'text-gray-500'}`}>
                  {r.table_name}
                </td>
                <td className='px-2 py-1'>
                  <span className={`px-1 rounded ${meta.className}`}>{meta.label}</span>
                </td>
                {showCounts && <td className='px-2 py-1 text-right tabular-nums text-gray-600'>{sc != null ? sc.toLocaleString() : '—'}</td>}
                {showCounts && <td className='px-2 py-1 text-right tabular-nums text-gray-600'>{tc != null ? tc.toLocaleString() : '—'}</td>}
                {showCounts && (
                  <td className='px-2 py-1'>
                    {countsLoaded && (
                      <span className={`px-1 rounded ${countsMatch ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                        {countsMatch ? 'Identical' : 'Different'}
                      </span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
