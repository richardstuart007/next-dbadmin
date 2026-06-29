'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyInput } from 'nextjs-shared/MyInput'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import { compareSchemasFromUrls } from '@/src/actions/schemaSyncActions'
import { generateTableSQL } from '@/src/actions/schemaUtils'
import type { SchemaCompareResult, TableSummary } from '@/src/actions/schemaUtils'
import { fetchTableCountsFromUrl } from '@/src/actions/schemaSyncActions'
import ConnectionPicker from './ConnectionPicker'
import type { ConnectionEntry } from '@/src/types/connections'

const HELP_ITEMS: HelpItem[] = [
  {
    heading: 'Compare Schemas',
    body: 'Select a source and target database then click Compare. Source is the reference; generated SQL brings the target in line with it.',
  },
  {
    heading: 'Generated SQL',
    body: 'ALTER TABLE / CREATE TABLE statements that will bring the target in line with the source. Review and edit before applying.',
  },
  {
    heading: 'Row Counts',
    body: 'After comparing, row counts for each table are fetched from both databases so you can verify data parity.',
  },
]

//----------------------------------------------------------------------------------------------
//  SchemaSyncConn — compare schemas between two databases selected via ConnectionPicker
//  Calls compareSchemasFromUrls and generateAlterSQL from nextjs-shared/schemaSync.
//  Row counts fetched via fetchTableCountsFromUrl local server action.
//----------------------------------------------------------------------------------------------
export default function SchemaSyncConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey  = connections[0]?.key ?? ''
  const secondKey = connections[1]?.key ?? connections[0]?.key ?? ''

  const [sourceKey, setSourceKey]         = useState(firstKey)
  const [targetKey, setTargetKey]         = useState(secondKey)
  const [result, setResult]               = useState<SchemaCompareResult | null>(null)
  const [excludePrefix, setExcludePrefix] = useState('bk_,local_,prod_,dev_,z1_')
  const [message, setMessage]             = useState('')
  const [running, setRunning]             = useState(false)
  const [sourceCounts, setSourceCounts]   = useState<Record<string, number>>({})
  const [targetCounts, setTargetCounts]   = useState<Record<string, number>>({})
  const [selectedTable, setSelectedTable] = useState('')

  const sourceConn  = connections.find(c => c.key === sourceKey)
  const targetConn  = connections.find(c => c.key === targetKey)
  const sameUrl     = !!(sourceConn?.url && targetConn?.url && sourceConn.url === targetConn.url)
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
  //  handleCompare — calls compareSchemasFromUrls then fetches row counts
  //----------------------------------------------------------------------------------------------
  async function handleCompare() {
    if (!sourceConn?.url || !targetConn?.url) return
    setRunning(true)
    setResult(null)
    setSourceCounts({})
    setTargetCounts({})
    setMessage('Comparing schemas...')
    try {
      const r = await compareSchemasFromUrls({
        url1:            sourceConn.url,
        url2:            targetConn.url,
        label1:          sourceConn.label,
        label2:          targetConn.label,
        excludePrefixes: excludePrefix,
      })
      setResult(r)
      setSelectedTable('')
      const diffCount = r.tableSummary.filter(t => t.status !== 'identical').length
      setMessage(diffCount === 0 ? 'Schemas are identical' : `Found differences in ${diffCount} table${diffCount !== 1 ? 's' : ''}`)
      const allTables = r.tableSummary.map(t => t.table_name)
      const [sc, tc] = await Promise.all([
        fetchTableCountsFromUrl(sourceConn.url, allTables),
        fetchTableCountsFromUrl(targetConn.url, allTables),
      ])
      setSourceCounts(sc)
      setTargetCounts(tc)
    } catch {
      setMessage('URL to database is invalid')
    } finally {
      setRunning(false)
    }
  }

  const tableSql     = result && selectedTable ? generateTableSQL(result, selectedTable) : ''
  const statusCounts   = result ? result.tableSummary.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {}) : {}

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
        <ConnectionPicker
          label='Target'
          connections={connections}
          value={targetKey}
          onChange={v => { setTargetKey(v); setResult(null); setMessage('') }}
          highlight={!!diffProject}
        />
      </div>

      {/* Exclude prefixes */}
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

      <div className='ml-20'>
        {sameUrl ? (
          <p className='text-xs font-bold text-red-700'>Same URL for Source and Target</p>
        ) : (
          <MyButton onClick={handleCompare} overrideClass='h-6 px-2 py-2' disabled={!sourceKey || !targetKey || running}>
            Compare Schemas
          </MyButton>
        )}
      </div>

      {message && <p className='text-xs text-red-700'>{message}</p>}

      {/* Table summary + per-table SQL side by side */}
      {result && (
        <div className='space-y-2'>
          <div className='flex items-center gap-3'>
            <p className='text-xs font-semibold'>Table Summary ({result.tableSummary.length} tables)</p>
            <span className='text-xs text-green-700'>{statusCounts.identical ?? 0} Identical</span>
            {(statusCounts.different ?? 0) > 0 && <span className='text-xs text-yellow-700'>{statusCounts.different} Different</span>}
            {(statusCounts.only_in_source ?? 0) > 0 && <span className='text-xs text-blue-700'>{statusCounts.only_in_source} Source</span>}
            {(statusCounts.only_in_target ?? 0) > 0 && <span className='text-xs text-orange-700'>{statusCounts.only_in_target} Target</span>}
          </div>
          <div className='flex items-start gap-4'>
            <TableSummarySection
              rows={result.tableSummary}
              label1={result.label1}
              label2={result.label2}
              sourceCounts={sourceCounts}
              targetCounts={targetCounts}
              selectedTable={selectedTable}
              onSelectTable={t => setSelectedTable(prev => prev === t ? '' : t)}
            />
            {tableSql && (
              <pre className='text-xs font-mono bg-gray-50 border rounded px-3 py-2 whitespace-pre-wrap overflow-auto max-h-96 max-w-2xl'>{tableSql}</pre>
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
    case 'identical':      return { label: 'Identical',  className: 'bg-green-100 text-green-800' }
    case 'different':      return { label: 'Different',  className: 'bg-yellow-100 text-yellow-800' }
    case 'only_in_source': return { label: 'Source',     className: 'bg-blue-100 text-blue-800' }
    case 'only_in_target': return { label: 'Target',     className: 'bg-orange-100 text-orange-800' }
    default:               return { label: status,       className: 'bg-gray-100 text-gray-800' }
  }
}

export const STATUS_FILTER_OPTIONS = [
  { value: 'identical'      as const, label: 'Identical' },
  { value: 'different'      as const, label: 'Different' },
  { value: 'only_in_source' as const, label: 'Source' },
  { value: 'only_in_target' as const, label: 'Target' },
]

//----------------------------------------------------------------------------------------------
//  TableSummarySection — per-table status grid with row counts
//----------------------------------------------------------------------------------------------
function TableSummarySection({
  rows, label1, label2, sourceCounts, targetCounts, selectedTable, onSelectTable,
}: {
  rows:          TableSummary[]
  label1:        string
  label2:        string
  sourceCounts:  Record<string, number>
  targetCounts:  Record<string, number>
  selectedTable: string
  onSelectTable: (table: string) => void
}) {
  // empty set = All (show everything); non-empty = filter to selected statuses
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set())

  if (rows.length === 0) return null

  const isAll        = selectedStatuses.size === 0
  const filteredRows = isAll ? rows : rows.filter(r => selectedStatuses.has(r.status))

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
              <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>{label1}</th>
              <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>{label2}</th>
              <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Counts</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(r => {
              const meta         = statusMeta(r.status)
              const sc           = sourceCounts[r.table_name]
              const tc           = targetCounts[r.table_name]
              const countsLoaded = sc != null && tc != null
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
                  <td className='px-2 py-1 text-right tabular-nums text-gray-600'>{sc != null ? sc.toLocaleString() : '—'}</td>
                  <td className='px-2 py-1 text-right tabular-nums text-gray-600'>{tc != null ? tc.toLocaleString() : '—'}</td>
                  <td className='px-2 py-1'>
                    {countsLoaded && (
                      <span className={`px-1 rounded ${countsMatch ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                        {countsMatch ? 'Identical' : 'Different'}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
  )
}
