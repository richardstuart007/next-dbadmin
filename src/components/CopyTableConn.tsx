'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyInput } from 'nextjs-shared/MyInput'
import { MyConfirmDialog } from 'nextjs-shared/MyConfirmDialog'
import type { ConfirmDialogInt } from 'nextjs-shared/MyConfirmDialog'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import {
  compare_tables,
  copy_tables,
  backup_tables,
  truncate_table,
  drop_table,
  repair_sequence,
} from '@/src/actions/copyTablesActions'
import type { CopyLog, TableComparisonRow } from '@/src/actions/copyTablesActions'
import type { TableStatus } from '@/src/actions/schemaUtils'
import ConnectionPicker from './ConnectionPicker'
import { statusMeta, STATUS_FILTER_OPTIONS } from './SchemaSyncConn'
import type { ConnectionEntry } from '@/src/types/connections'

const HELP_ITEMS: HelpItem[] = [
  {
    heading: 'Load Tables',
    body: 'Fetches tables from both databases and compares row counts. Source → Target only; changes to the target never affect the source.',
  },
  {
    heading: 'Status',
    body: '"Source Only" — table exists in source but not target. "Different" — exists in both but row counts differ. "In Sync" — exists in both with matching row counts. "Target Only" — exists in target but not source (orphan).',
  },
  {
    heading: 'Copy Tables',
    body: 'Copies selected tables from source to target using pg_dump / psql. Tables with existing rows in target are skipped — use Truncate first to clear them.',
  },
  {
    heading: 'Truncate',
    body: 'Removes all rows from the table in the target database, leaving the table structure intact. Useful before re-copying.',
  },
  {
    heading: 'Drop',
    body: 'Permanently deletes the table from the target database.',
  },
  {
    heading: 'Backup',
    body: 'Creates a snapshot copy of selected tables in the target database. Backup names are prefixed with the backup prefix value.',
  },
  {
    heading: 'FK constraints',
    body: 'Foreign-key constraints are bypassed during copy (session_replication_role = replica) and re-enabled automatically when the session ends.',
  },
  {
    heading: 'Sequence repair',
    body: 'After each table copy the sequence (auto-increment) is reset to MAX(pk) so future inserts do not collide with the copied rows.',
  },
]


//----------------------------------------------------------------------------------------------
//  CopyTableConn — compare and copy tables between databases selected via ConnectionPicker
//----------------------------------------------------------------------------------------------
export default function CopyTableConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey  = connections[0]?.key ?? ''
  const secondKey = connections[1]?.key ?? connections[0]?.key ?? ''

  const [sourceKey, setSourceKey]             = useState(firstKey)
  const [targetKey, setTargetKey]             = useState(secondKey)
  const [rows, setRows]                       = useState<TableComparisonRow[]>([])
  const [selectedTables, setSelectedTables]   = useState<Set<string>>(new Set())
  const [logs, setLogs]                       = useState<CopyLog[]>([])
  const [message, setMessage]                 = useState('')
  const [running, setRunning]                 = useState(false)
  const [backupPrefix, setBackupPrefix]       = useState('')
  const [backupLogs, setBackupLogs]           = useState<CopyLog[]>([])
  const [backupConflicts, setBackupConflicts] = useState<string[]>([])
  const [selectedStatuses, setSelectedStatuses] = useState<Set<TableStatus>>(new Set())
  const [confirmDialog, setConfirmDialog]     = useState<ConfirmDialogInt>({
    isOpen: false, title: '', subTitle: '', onConfirm: () => {},
  })

  const sourceConn  = connections.find(c => c.key === sourceKey)
  const targetConn  = connections.find(c => c.key === targetKey)
  const sameConn    = sourceKey && targetKey && sourceKey === targetKey
  const diffProject = sourceConn && targetConn && sourceConn.projectKey !== targetConn.projectKey

  const isAll        = selectedStatuses.size === 0
  const filteredRows = isAll ? rows : rows.filter(r => selectedStatuses.has(r.status))
  const selectableRows = filteredRows.filter(r => r.status !== 'only_in_target')
  const allSelected    = selectableRows.length > 0 && selectableRows.every(r => selectedTables.has(r.table))

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})

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
    setRows([])
    setSelectedTables(new Set())
    setLogs([])
    setMessage('')
  }

  //----------------------------------------------------------------------------------------------
  //  handleTargetChange — clears comparison when target connection changes
  //----------------------------------------------------------------------------------------------
  function handleTargetChange(key: string) {
    setTargetKey(key)
    setRows([])
    setSelectedTables(new Set())
    setLogs([])
    setBackupLogs([])
    setBackupConflicts([])
    setMessage('')
  }

  //----------------------------------------------------------------------------------------------
  //  handleLoad — calls compare_tables to populate the comparison table
  //----------------------------------------------------------------------------------------------
  async function handleLoad() {
    if (!sourceConn?.url || !targetConn?.url) return
    setMessage('Loading tables...')
    setRunning(true)
    setRows([])
    setSelectedTables(new Set())
    setLogs([])
    try {
      const result = await compare_tables({
        sourceUrl: sourceConn.url,
        targetUrl: targetConn.url,
        caller:    'CopyTableConn',
      })
      setRows(result)
      setMessage(`Loaded ${result.length} table${result.length !== 1 ? 's' : ''}`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleRefresh — re-runs compare_tables silently after a mutating action
  //----------------------------------------------------------------------------------------------
  async function handleRefresh() {
    if (!sourceConn?.url || !targetConn?.url) return
    try {
      const result = await compare_tables({
        sourceUrl: sourceConn.url,
        targetUrl: targetConn.url,
        caller:    'CopyTableConn',
      })
      setRows(result)
    } catch {
      //
      //  silent — a failed refresh does not overwrite the action result message
      //
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleCopy — shows confirmation dialog before performing bulk copy
  //----------------------------------------------------------------------------------------------
  function handleCopy() {
    const tableList = Array.from(selectedTables)
    const preview   = tableList.slice(0, 5).join(', ') + (tableList.length > 5 ? `, … (+${tableList.length - 5} more)` : '')
    setConfirmDialog({
      isOpen:    true,
      title:     `Copy ${tableList.length} table${tableList.length !== 1 ? 's' : ''}`,
      subTitle:  `FROM ${sourceConn?.label ?? ''}  →  TO ${targetConn?.label ?? ''}`,
      line1:     preview,
      line2:     'Tables with existing rows in target will be skipped.',
      line3:     'To replace: Truncate the target table first.',
      onConfirm: performCopy,
    })
  }

  //----------------------------------------------------------------------------------------------
  //  performCopy — calls copy_tables server action then refreshes counts
  //----------------------------------------------------------------------------------------------
  async function performCopy() {
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    if (!sourceConn?.url || !targetConn?.url) {
      setMessage('Source or target connection URL is missing')
      return
    }
    setMessage('Copying tables...')
    setRunning(true)
    setLogs([])
    try {
      const result = await copy_tables({
        sourceUrl:   sourceConn.url,
        targetUrl:   targetConn.url,
        tables:      Array.from(selectedTables),
        sourceLabel: sourceConn.label,
        targetLabel: targetConn.label,
        caller:      'CopyTableConn',
      })
      setLogs(result.logs)
      setMessage(result.success ? 'Copy completed successfully' : 'Copy completed with errors — see log above')
      await handleRefresh()
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleTruncate — shows confirmation before removing all rows from a target table
  //----------------------------------------------------------------------------------------------
  function handleTruncate(table: string) {
    setConfirmDialog({
      isOpen:    true,
      title:     `Truncate ${table}`,
      subTitle:  `Remove all rows from ${targetConn?.label ?? ''}`,
      line1:     'The table structure is preserved.',
      onConfirm: () => performTruncate(table),
    })
  }

  //----------------------------------------------------------------------------------------------
  //  performTruncate — calls truncate_table server action then refreshes counts
  //----------------------------------------------------------------------------------------------
  async function performTruncate(table: string) {
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    if (!targetConn?.url) return
    setRunning(true)
    setMessage(`Truncating ${table}...`)
    try {
      const result = await truncate_table({ targetUrl: targetConn.url, table, caller: 'CopyTableConn' })
      setMessage(result.success ? `${table} truncated` : `Truncate failed: ${result.message}`)
      await handleRefresh()
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleDrop — shows confirmation before permanently deleting a target table
  //----------------------------------------------------------------------------------------------
  function handleDrop(table: string) {
    setConfirmDialog({
      isOpen:    true,
      title:     `Drop ${table}`,
      subTitle:  `Permanently delete from ${targetConn?.label ?? ''}`,
      line1:     'This cannot be undone.',
      onConfirm: () => performDrop(table),
    })
  }

  //----------------------------------------------------------------------------------------------
  //  performDrop — calls drop_table server action then refreshes counts
  //----------------------------------------------------------------------------------------------
  async function performDrop(table: string) {
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    if (!targetConn?.url) return
    setRunning(true)
    setMessage(`Dropping ${table}...`)
    try {
      const result = await drop_table({ targetUrl: targetConn.url, table, caller: 'CopyTableConn' })
      setMessage(result.success ? `${table} dropped` : `Drop failed: ${result.message}`)
      setSelectedTables(prev => { const next = new Set(prev); next.delete(table); return next })
      await handleRefresh()
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleFixSeq — resets a table's sequence to MAX(pk) in the given database
  //----------------------------------------------------------------------------------------------
  async function handleFixSeq(url: string, table: string) {
    setRunning(true)
    setMessage(`Repairing sequence for ${table}...`)
    try {
      const result = await repair_sequence({ targetUrl: url, table, caller: 'CopyTableConn' })
      setMessage(result.success ? `${table} — sequence repaired` : `Sequence repair failed: ${result.message}`)
      await handleRefresh()
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleBackup — calls backup_tables server action for selected tables in target
  //----------------------------------------------------------------------------------------------
  async function handleBackup() {
    if (!targetConn?.url) return
    setMessage('Creating backups...')
    setRunning(true)
    setBackupLogs([])
    setBackupConflicts([])
    try {
      const tables = Array.from(selectedTables).map(table => ({
        table,
        backupName: `${backupPrefix}_${table}`,
      }))
      const result = await backup_tables({ targetUrl: targetConn.url, tables, caller: 'CopyTableConn' })
      if (result.conflicts.length > 0) {
        setBackupConflicts(result.conflicts)
        setMessage('Backup blocked — resolve conflicts before retrying')
      } else {
        setBackupLogs(result.logs)
        const ok = result.logs.filter(l => l.event === 'BACKUP').length
        setMessage(`Backup completed: ${ok} table${ok !== 1 ? 's' : ''} backed up in ${targetConn.label}`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  toggleTable / toggleAll — checkbox state; target_only rows are excluded from selection
  //----------------------------------------------------------------------------------------------
  function toggleTable(table: string) {
    setSelectedTables(prev => {
      const next = new Set(prev)
      if (next.has(table)) next.delete(table)
      else next.add(table)
      return next
    })
  }

  function toggleAll() {
    if (allSelected) {
      setSelectedTables(new Set())
    } else {
      setSelectedTables(new Set(selectableRows.map(r => r.table)))
    }
  }

  //----------------------------------------------------------------------------------------------
  //  toggleStatus — status filter dropdown state
  //----------------------------------------------------------------------------------------------
  function toggleStatus(value: TableStatus) {
    setSelectedStatuses(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2'>
        <MyHelp items={HELP_ITEMS} title='Copy Tables Help' label='Help' />
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
          onChange={handleTargetChange}
          highlight={!!diffProject}
        />
      </div>

      <div className='flex items-center gap-2 ml-20'>
        {sameConn ? (
          <span className='text-xs font-bold text-red-700'>⚠ Source and target are the same — cannot copy</span>
        ) : (
          <MyButton
            onClick={handleLoad}
            overrideClass='h-6 px-2 py-2 shrink-0'
            disabled={!sourceKey || !targetKey || running}
          >
            {rows.length > 0 ? 'Refresh' : 'Load Tables'}
          </MyButton>
        )}
      </div>

      {message && <p className='text-xs text-red-700'>{message}</p>}

      {rows.length > 0 && (
        <div className='space-y-2'>

          {/* Summary badges */}
          <div className='flex items-center gap-3'>
            <p className='text-xs font-semibold'>Tables ({rows.length})</p>
            {(statusCounts.identical      ?? 0) > 0 && <span className='text-xs text-green-700'>{statusCounts.identical} Identical</span>}
            {(statusCounts.different      ?? 0) > 0 && <span className='text-xs text-yellow-700'>{statusCounts.different} Different</span>}
            {(statusCounts.only_in_source ?? 0) > 0 && <span className='text-xs text-blue-700'>{statusCounts.only_in_source} Source Only</span>}
            {(statusCounts.only_in_target ?? 0) > 0 && <span className='text-xs text-orange-700'>{statusCounts.only_in_target} Target Only</span>}
          </div>

          {/* Bulk action bar — visible when tables are selected */}
          {selectedTables.size > 0 && (
            <div className='flex items-center gap-2'>
              <MyButton
                onClick={handleCopy}
                overrideClass='h-6 px-2 py-2 bg-red-500 hover:bg-red-600 shrink-0'
                disabled={running}
              >
                Copy {selectedTables.size} Tables
              </MyButton>
              <MyInput
                overrideClass='w-28 font-mono text-xs h-6'
                type='text'
                value={backupPrefix}
                onChange={e => { setBackupPrefix(e.target.value); setBackupConflicts([]); setBackupLogs([]) }}
                placeholder='backup prefix'
              />
              <MyButton
                onClick={handleBackup}
                overrideClass='h-6 px-2 py-2 bg-amber-500 hover:bg-amber-600 shrink-0'
                disabled={!backupPrefix.trim() || running}
              >
                Backup {selectedTables.size}
              </MyButton>
            </div>
          )}

          {/* Comparison table */}
          <div className='border rounded bg-white w-fit'>
            <table className='text-xs'>
              <thead className='bg-gray-50 sticky top-0'>
                <tr>
                  <th className='px-2 py-1 border-b'>
                    <input
                      type='checkbox'
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableRows.length === 0}
                    />
                  </th>
                  <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Table</th>
                  <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>
                    <details className='relative'>
                      <summary className='cursor-pointer list-none font-medium text-gray-500 hover:text-gray-700'>
                        {isAll
                          ? 'Status ▾'
                          : `Status (${selectedStatuses.size}/${STATUS_FILTER_OPTIONS.length}) ▾`}
                      </summary>
                      <div className='absolute z-20 bg-white border border-gray-200 rounded shadow-md p-2 space-y-1 min-w-32'>
                        <label className='flex items-center gap-1 cursor-pointer whitespace-nowrap border-b border-gray-100 pb-1 mb-1'>
                          <input
                            type='checkbox'
                            checked={isAll}
                            onChange={() => setSelectedStatuses(new Set())}
                          />
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
                  <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>
                    {sourceConn?.label ?? 'Source'}
                  </th>
                  <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>Src Seq</th>
                  <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>
                    {targetConn?.label ?? 'Target'}
                  </th>
                  <th className='px-2 py-1 text-right text-gray-500 font-medium border-b'>Tgt Seq</th>
                  <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Counts</th>
                  <th className='px-2 py-1 text-left text-gray-500 font-medium border-b'>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map(r => {
                  const isTargetOnly  = r.status === 'only_in_target'
                  const bothExist     = r.sourceCount !== null && r.targetCount !== null
                  const countsMatch   = bothExist && r.sourceCount === r.targetCount
                  const sourceSeqBad  = r.sourceNextSeq !== null && r.sourceMaxId !== null && r.sourceNextSeq <= r.sourceMaxId
                  const targetSeqBad  = r.targetNextSeq !== null && r.targetMaxId !== null && r.targetNextSeq <= r.targetMaxId
                  return (
                    <tr key={r.table} className='border-b border-gray-100'>
                      <td className='px-2 py-1 text-center'>
                        {!isTargetOnly && (
                          <input
                            type='checkbox'
                            checked={selectedTables.has(r.table)}
                            onChange={() => toggleTable(r.table)}
                          />
                        )}
                      </td>
                      <td className={`px-2 py-1 font-mono ${r.status === 'identical' ? 'text-gray-500' : 'font-semibold'}`}>
                        {r.table}
                      </td>
                      <td className='px-2 py-1'>
                        <span className={`px-1 rounded ${statusMeta(r.status).className}`}>
                          {statusMeta(r.status).label}
                        </span>
                      </td>
                      <td className='px-2 py-1 text-right tabular-nums text-gray-600'>
                        {r.sourceCount !== null ? r.sourceCount.toLocaleString() : '—'}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums ${sourceSeqBad ? 'bg-red-50 text-red-700 font-semibold' : 'text-gray-500'}`}>
                        <div className='flex items-center justify-end gap-1'>
                          {sourceSeqBad && <span title={`Sequence (${r.sourceNextSeq?.toLocaleString()}) ≤ max id (${r.sourceMaxId?.toLocaleString()})`}>⚠</span>}
                          {r.sourceNextSeq !== null ? r.sourceNextSeq.toLocaleString() : '—'}
                          {sourceSeqBad && sourceConn?.url && (
                            <MyButton
                              onClick={() => handleFixSeq(sourceConn.url!, r.table)}
                              overrideClass='h-4 px-1 py-0 text-xs bg-red-500 hover:bg-red-600 shrink-0'
                              disabled={running}
                            >
                              Fix
                            </MyButton>
                          )}
                        </div>
                      </td>
                      <td className='px-2 py-1 text-right tabular-nums text-gray-600'>
                        {r.targetCount !== null ? r.targetCount.toLocaleString() : '—'}
                      </td>
                      <td className={`px-2 py-1 text-right tabular-nums ${targetSeqBad ? 'bg-red-50 text-red-700 font-semibold' : 'text-gray-500'}`}>
                        <div className='flex items-center justify-end gap-1'>
                          {targetSeqBad && <span title={`Sequence (${r.targetNextSeq?.toLocaleString()}) ≤ max id (${r.targetMaxId?.toLocaleString()})`}>⚠</span>}
                          {r.targetNextSeq !== null ? r.targetNextSeq.toLocaleString() : '—'}
                          {targetSeqBad && targetConn?.url && (
                            <MyButton
                              onClick={() => handleFixSeq(targetConn.url!, r.table)}
                              overrideClass='h-4 px-1 py-0 text-xs bg-red-500 hover:bg-red-600 shrink-0'
                              disabled={running}
                            >
                              Fix
                            </MyButton>
                          )}
                        </div>
                      </td>
                      <td className='px-2 py-1'>
                        {bothExist && (
                          <span className={`px-1 rounded ${countsMatch ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}`}>
                            {countsMatch ? 'Match' : 'Differs'}
                          </span>
                        )}
                      </td>
                      <td className='px-2 py-1'>
                        {r.targetCount !== null && (
                          <div className='flex items-center gap-1'>
                            <MyButton
                              onClick={() => handleTruncate(r.table)}
                              overrideClass='h-5 px-1.5 py-0 text-xs bg-amber-500 hover:bg-amber-600 shrink-0'
                              disabled={running}
                            >
                              Truncate
                            </MyButton>
                            <MyButton
                              onClick={() => handleDrop(r.table)}
                              overrideClass='h-5 px-1.5 py-0 text-xs bg-red-500 hover:bg-red-600 shrink-0'
                              disabled={running}
                            >
                              Drop
                            </MyButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Backup feedback */}
          {backupConflicts.length > 0 && (
            <p className='text-xs text-red-700'>
              Already exist — drop before retrying: {backupConflicts.join(', ')}
            </p>
          )}
          {backupLogs.length > 0 && (
            <div className='border rounded bg-white'>
              <table className='min-w-full text-xs'>
                <tbody>
                  {backupLogs.map((log, i) => (
                    <tr key={i} className={log.event === 'ERROR' ? 'text-red-600' : 'text-green-700'}>
                      <td className='px-2 py-0.5'>{log.event}</td>
                      <td className='px-2 py-0.5'>{log.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Copy log */}
      {logs.length > 0 && (
        <div className='mt-2'>
          <div className='flex items-center gap-3 mb-1'>
            <p className='text-xs font-semibold'>Copy Log</p>
            {sourceConn && targetConn && (
              <p className='text-xs text-gray-500'>{sourceConn.label} → {targetConn.label}</p>
            )}
          </div>
          <div className='border rounded bg-white'>
            <table className='min-w-full text-xs'>
              <thead className='bg-gray-100'>
                <tr>
                  <th className='px-2 py-1 text-left'>Event</th>
                  <th className='px-2 py-1 text-left'>Detail</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log, i) => (
                  <tr key={i} className={log.event === 'ERROR' || log.event === 'SKIPPED' ? 'text-red-600' : ''}>
                    <td className='px-2 py-0.5'>{log.event}</td>
                    <td className='px-2 py-0.5'>{log.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <MyConfirmDialog confirmDialog={confirmDialog} setConfirmDialog={setConfirmDialog} />
    </div>
  )
}
