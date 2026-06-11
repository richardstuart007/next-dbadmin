'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyInput } from 'nextjs-shared/MyInput'
import { MyConfirmDialog } from 'nextjs-shared/MyConfirmDialog'
import type { ConfirmDialogInt } from 'nextjs-shared/MyConfirmDialog'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import { get_tables, copy_tables, backup_tables } from '@/src/actions/copyTablesActions'
import type { CopyLog } from '@/src/actions/copyTablesActions'
import ConnectionPicker from './ConnectionPicker'
import type { ConnectionEntry } from '@/src/types/connections'

const HELP_ITEMS: HelpItem[] = [
  {
    heading: 'Load Tables',
    body: 'Fetches the list of user tables from the source database. Select which tables to copy using the checkboxes.',
  },
  {
    heading: 'Copy Tables',
    body: 'Each selected table is copied using pg_dump / psql. Target rows must be empty — tables with existing rows are skipped.',
  },
  {
    heading: 'FK constraints',
    body: 'Foreign-key constraints are bypassed during the copy (session_replication_role = replica). They are re-enabled automatically when the session ends.',
  },
  {
    heading: 'Sequence repair',
    body: 'After each table copy the sequence (auto-increment) is reset to MAX(pk) so future inserts do not collide with the copied rows.',
  },
  {
    heading: 'Backup',
    body: 'Creates a snapshot copy of selected tables in the target database before overwriting. Backup names are prefixed with the backup prefix value.',
  },
]

//----------------------------------------------------------------------------------------------
//  CopyTableConn — copy tables between databases selected via ConnectionPicker
//  Calls get_tables, copy_tables, backup_tables server actions from nextjs-shared/copyTables.
//----------------------------------------------------------------------------------------------
export default function CopyTableConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey  = connections[0]?.key ?? ''
  const secondKey = connections[1]?.key ?? connections[0]?.key ?? ''

  const [sourceKey, setSourceKey]         = useState(firstKey)
  const [targetKey, setTargetKey]         = useState(secondKey)
  const [availableTables, setAvailableTables] = useState<string[]>([])
  const [selectedTables, setSelectedTables]   = useState<Set<string>>(new Set())
  const [logs, setLogs]                   = useState<CopyLog[]>([])
  const [message, setMessage]             = useState('')
  const [running, setRunning]             = useState(false)
  const [backupPrefix, setBackupPrefix]   = useState('')
  const [backupLogs, setBackupLogs]       = useState<CopyLog[]>([])
  const [backupConflicts, setBackupConflicts] = useState<string[]>([])
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogInt>({
    isOpen: false, title: '', subTitle: '', onConfirm: () => {},
  })

  const sourceConn  = connections.find(c => c.key === sourceKey)
  const targetConn  = connections.find(c => c.key === targetKey)
  const sameConn    = sourceKey && targetKey && sourceKey === targetKey
  const diffProject = sourceConn && targetConn && sourceConn.projectKey !== targetConn.projectKey

  //----------------------------------------------------------------------------------------------
  //  handleSourceChange — clears table list when source changes
  //----------------------------------------------------------------------------------------------
  function handleSourceChange(key: string) {
    setSourceKey(key)
    setAvailableTables([])
    setSelectedTables(new Set())
    setLogs([])
  }

  //----------------------------------------------------------------------------------------------
  //  handleLoadTables — calls get_tables with the selected source URL
  //----------------------------------------------------------------------------------------------
  async function handleLoadTables() {
    if (!sourceConn?.url) return
    setMessage('Loading tables...')
    setRunning(true)
    try {
      const tables = await get_tables({ url: sourceConn.url, caller: 'CopyTableConn' })
      setAvailableTables(tables)
      setSelectedTables(new Set())
      setMessage(`Loaded ${tables.length} tables from ${sourceConn.label}`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  handleCopy — shows confirmation dialog before performing copy
  //----------------------------------------------------------------------------------------------
  function handleCopy() {
    const tableList = Array.from(selectedTables)
    const preview   = tableList.slice(0, 5).join(', ') + (tableList.length > 5 ? `, … (+${tableList.length - 5} more)` : '')
    setConfirmDialog({
      isOpen: true,
      title: `Copy ${tableList.length} table${tableList.length !== 1 ? 's' : ''}`,
      subTitle: `FROM ${sourceConn?.label ?? ''}  →  TO ${targetConn?.label ?? ''}`,
      line1: preview,
      line2: 'Tables with existing rows in target will be skipped.',
      line3: 'To replace: backup and clear manually in pgAdmin4 first.',
      onConfirm: performCopy,
    })
  }

  //----------------------------------------------------------------------------------------------
  //  performCopy — calls copy_tables server action
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
  //  toggleTable / toggleAll — checkbox state for table selection
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
    if (selectedTables.size === availableTables.length) {
      setSelectedTables(new Set())
    } else {
      setSelectedTables(new Set(availableTables))
    }
  }

  return (
    <div>
      <div className='flex items-center gap-2 mb-4'>
        <MyHelp items={HELP_ITEMS} title='Copy Tables Help' label='Help' />
      </div>

      <div className='space-y-2 mb-4'>
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
          onChange={v => { setTargetKey(v); setBackupLogs([]); setBackupConflicts([]) }}
          highlight={!!diffProject}
        />
      </div>

      <div className='flex items-center gap-2 mb-4 ml-20'>
        {sameConn ? (
          <span className='text-xs font-bold text-red-700'>⚠ Source and target are the same — cannot copy</span>
        ) : (
          <MyButton
            onClick={handleLoadTables}
            overrideClass='h-6 px-2 py-2 shrink-0'
            disabled={!sourceKey || running}
          >
            Display {sourceConn?.label ?? 'Source'} Tables
          </MyButton>
        )}
      </div>

      {availableTables.length > 0 && (
        <div className='mb-4'>
          <div className='flex items-center gap-2 mb-2'>
            <span className='text-xs font-semibold'>Tables ({availableTables.length})</span>
            <MyButton
              onClick={toggleAll}
              overrideClass='h-6 px-2 py-2 bg-gray-400 hover:bg-gray-500'
            >
              {selectedTables.size === availableTables.length ? 'Deselect All' : 'Select All'}
            </MyButton>
            <MyButton
              onClick={handleCopy}
              overrideClass='h-6 px-2 py-2 bg-red-500 hover:bg-red-600'
              disabled={selectedTables.size === 0 || running}
            >
              Copy {selectedTables.size} Tables
            </MyButton>
          </div>

          <div className='grid grid-cols-3 gap-1 border p-2 rounded bg-white'>
            {availableTables.map(table => (
              <label key={table} className='flex items-center gap-1 text-xs cursor-pointer'>
                <input
                  type='checkbox'
                  checked={selectedTables.has(table)}
                  onChange={() => toggleTable(table)}
                />
                {table}
              </label>
            ))}
          </div>

          {/* Backup section */}
          {selectedTables.size > 0 && (
            <div className='mt-3 pt-3 border-t space-y-2'>
              <div className='flex items-center gap-2'>
                <label className='text-xs w-28 text-right shrink-0'>Backup prefix</label>
                <MyInput
                  overrideClass='w-32 font-mono text-xs'
                  type='text'
                  value={backupPrefix}
                  onChange={e => { setBackupPrefix(e.target.value); setBackupConflicts([]); setBackupLogs([]) }}
                  placeholder={targetConn?.label ?? 'prefix'}
                />
                <MyButton
                  onClick={handleBackup}
                  overrideClass='h-6 px-2 py-2 bg-amber-500 hover:bg-amber-600'
                  disabled={!backupPrefix.trim() || selectedTables.size === 0 || running}
                >
                  Backup {selectedTables.size} Tables
                </MyButton>
              </div>
              {backupPrefix.trim() && selectedTables.size > 0 && (
                <p className='text-xs text-gray-400 ml-32'>
                  {Array.from(selectedTables).slice(0, 3).map(t => `${backupPrefix}_${t}`).join(', ')}
                  {selectedTables.size > 3 ? ', …' : ''}
                </p>
              )}
              {backupConflicts.length > 0 && (
                <p className='text-xs text-red-700 ml-32'>
                  Already exist — drop before retrying: {backupConflicts.join(', ')}
                </p>
              )}
              {backupLogs.length > 0 && (
                <div className='ml-32 border rounded bg-white'>
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
        </div>
      )}

      {message && <p className='text-xs text-red-700 mb-2'>{message}</p>}

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
