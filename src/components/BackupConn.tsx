'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyInput } from 'nextjs-shared/MyInput'
import { MyConfirmDialog } from 'nextjs-shared/MyConfirmDialog'
import type { ConfirmDialogInt } from 'nextjs-shared/MyConfirmDialog'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import {
  list_tables_url,
  check_tables_url,
  table_duplicate_url,
  table_copy_url,
  table_truncate_url,
  table_drop_url,
  table_seqreset_url,
  table_export_json,
  table_import_json,
  directory_list_local,
  file_count_json_local,
} from '@/src/actions/backupActions'
import ConnectionPicker from './ConnectionPicker'
import type { ConnectionEntry } from '@/src/types/connections'

const DIR_PREFIX = 'C:/backups/'
const BACKUP_CHAR = 'z'

const HELP_ITEMS: HelpItem[] = [
  { heading: 'Backup tab', body: 'Manage in-database backup copies of your tables. Each backup is a full copy of the base table stored in the same database under a z{prefix}_{table} name. Use the PC Folder section to also download/upload table data as JSON files.' },
  { heading: 'Backup prefix', body: 'A short label (e.g. "1", "pre-release") used to name backup tables: z{prefix}_{table}. Change the prefix and click Refresh to load a different set of backups.' },
  { heading: 'SeqReset', body: 'Resets the auto-increment sequence on the base table to MAX(id). Run this after copying data in to avoid primary key conflicts on future inserts.' },
  { heading: 'Duplicate', body: 'Creates a new empty backup table with the same structure (columns, types, constraints) as the base table. Only available when no backup exists for this prefix.' },
  { heading: 'Clear', body: 'Deletes all rows from the backup table but keeps the table structure. Use before Copy if the backup already has data.' },
  { heading: 'Copy', body: 'Copies all rows from the base table into the backup table. Automatically clears the backup first if it already has rows.' },
  { heading: 'ToBase', body: 'Restores the base table from the backup: truncates the base table, copies all backup rows in, then resets the sequence.' },
  { heading: 'Drop', body: 'Permanently drops the backup table. The base table is not affected.' },
  { heading: 'PC Folder', body: 'Subfolder under C:/backups/ for JSON file operations. Type a name and click Refresh to scan it. Use Down to export a base table to JSON and Upload to import a JSON file into a backup table.' },
  { heading: 'Down', body: 'Exports all rows from the base table to a JSON file in the PC Folder. File is named {table}.json.' },
  { heading: 'Upload', body: 'Imports rows from a JSON file in the PC Folder into the backup table. Clears the backup first if it has rows, then resets the sequence.' },
]

type BaseRow    = { table: string; count: number }
type BackupRow  = { name: string; exists: boolean; count: number }
type JsonRow    = { exists: boolean; count: number }

//----------------------------------------------------------------------------------------------
//  BackupConn — URL-based backup management, mirroring nextjs-shared's table.tsx Backup tab
//  All pg operations use createArbitraryDb via server actions in backupActions.ts
//----------------------------------------------------------------------------------------------
export default function BackupConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey = connections[0]?.key ?? ''

  const [connKey, setConnKey]             = useState(firstKey)
  const [tables, setTables]               = useState<BaseRow[]>([])
  const [backupPrefix, setBackupPrefix]   = useState('1')
  const [backups, setBackups]             = useState<BackupRow[]>([])
  const [dataDirectory, setDataDirectory] = useState('')
  const [jsonRows, setJsonRows]           = useState<JsonRow[]>([])
  const [message, setMessage]             = useState('')
  const [running, setRunning]             = useState(false)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogInt>({
    isOpen: false, title: '', subTitle: '', onConfirm: () => {},
  })

  const conn = connections.find(c => c.key === connKey)
  const url  = conn?.url ?? ''

  function backupName(table: string) { return `${BACKUP_CHAR}${backupPrefix}_${table}` }

  //----------------------------------------------------------------------------------------------
  //  refreshBase — reload base tables with row counts
  //----------------------------------------------------------------------------------------------
  async function refreshBase() {
    if (!url) return
    setMessage('Loading tables...')
    setRunning(true)
    try {
      const rows = await list_tables_url(url)
      setTables(rows)
      setBackups([])
      setJsonRows([])
      setMessage(`${rows.length} tables`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  refreshBackups — reload backup table existence + counts
  //----------------------------------------------------------------------------------------------
  async function refreshBackups() {
    if (!url || tables.length === 0) return
    setMessage('Loading backups...')
    setRunning(true)
    try {
      const names  = tables.map(t => backupName(t.table))
      const result = await check_tables_url(url, names)
      setBackups(result)
      setMessage('Backups refreshed')
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  refreshDirectory — scan PC folder for JSON files
  //----------------------------------------------------------------------------------------------
  async function refreshDirectory() {
    if (!dataDirectory || tables.length === 0) return
    setMessage('Scanning folder...')
    setRunning(true)
    try {
      const dirPath = `${DIR_PREFIX}${dataDirectory}`
      const files   = await directory_list_local(dirPath)
      const stripped = new Set(files.map(f => f.replace(/\.json$/, '')))
      const rows: JsonRow[] = await Promise.all(
        tables.map(async t => {
          if (!stripped.has(t.table)) return { exists: false, count: 0 }
          const count = await file_count_json_local(`${dirPath}/${t.table}.json`)
          return { exists: true, count }
        })
      )
      setJsonRows(rows)
      setMessage('Folder scanned')
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  confirm — show confirm dialog before destructive operations
  //----------------------------------------------------------------------------------------------
  function confirm(title: string, subTitle: string, onConfirm: () => void) {
    setConfirmDialog({ isOpen: true, title, subTitle, onConfirm })
  }

  //----------------------------------------------------------------------------------------------
  //  Single-row operations
  //----------------------------------------------------------------------------------------------
  async function performSeqReset(index: number, many = false) {
    const t = tables[index]
    if (!t) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`SeqReset ${t.table}...`)
    try {
      await table_seqreset_url(url, t.table)
      if (!many) setMessage(`SeqReset ${t.table} done`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performDup(index: number, many = false) {
    const t   = tables[index]
    const bk  = backups[index]
    if (!t || bk?.exists) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Duplicating ${t.table}...`)
    try {
      await table_duplicate_url(url, t.table, backupName(t.table))
      if (!many) {
        setBackups(prev => { const n=[...prev]; n[index]={name:backupName(t.table),exists:true,count:0}; return n })
        setMessage(`Duplicate ${t.table} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performClear(index: number, many = false) {
    const bk = backups[index]
    if (!bk?.exists || bk.count === 0) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Clearing ${bk.name}...`)
    try {
      await table_truncate_url(url, bk.name)
      if (!many) {
        setBackups(prev => { const n=[...prev]; n[index]={...n[index],count:0}; return n })
        setMessage(`Clear ${bk.name} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performCopy(index: number, many = false) {
    const t   = tables[index]
    const bk  = backups[index]
    if (!bk?.exists || t.count === 0) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    if (bk.count > 0) await performClear(index, true)
    setMessage(`Copying ${t.table} → ${bk.name}...`)
    try {
      await table_copy_url(url, t.table, bk.name)
      if (!many) {
        setBackups(prev => { const n=[...prev]; n[index]={...n[index],count:t.count}; return n })
        setMessage(`Copy ${t.table} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performToBase(index: number, many = false) {
    const t   = tables[index]
    const bk  = backups[index]
    if (!bk?.exists || bk.count === 0) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Restoring ${bk.name} → ${t.table}...`)
    try {
      await table_truncate_url(url, t.table)
      await table_copy_url(url, bk.name, t.table)
      await table_seqreset_url(url, t.table)
      if (!many) {
        setTables(prev => { const n=[...prev]; n[index]={...n[index],count:bk.count}; return n })
        setMessage(`ToBase ${t.table} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performDrop(index: number, many = false) {
    const bk = backups[index]
    if (!bk?.exists) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Dropping ${bk.name}...`)
    try {
      await table_drop_url(url, bk.name)
      if (!many) {
        setBackups(prev => { const n=[...prev]; n[index]={...n[index],exists:false,count:0}; return n })
        setMessage(`Drop ${bk.name} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performDown(index: number, many = false) {
    const t       = tables[index]
    const dirPath = `${DIR_PREFIX}${dataDirectory}`
    if (t.count === 0) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Exporting ${t.table}...`)
    try {
      const ok = await table_export_json(url, t.table, `${dirPath}/${t.table}.json`)
      if (!many && ok) {
        setJsonRows(prev => { const n=[...prev]; n[index]={exists:true,count:t.count}; return n })
        setMessage(`Down ${t.table} done`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  async function performUpload(index: number, many = false) {
    const t       = tables[index]
    const bk      = backups[index]
    const jr      = jsonRows[index]
    const dirPath = `${DIR_PREFIX}${dataDirectory}`
    if (!bk?.exists || !jr?.exists) return
    if (!many) setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    if (bk.count > 0) await performClear(index, true)
    setMessage(`Uploading ${t.table}...`)
    try {
      const inserted = await table_import_json(url, bk.name, `${dirPath}/${t.table}.json`)
      await table_seqreset_url(url, bk.name)
      if (!many) {
        setBackups(prev => { const n=[...prev]; n[index]={...n[index],count:inserted}; return n })
        setMessage(`Upload ${t.table} done — ${inserted} rows`)
      }
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    }
  }

  //----------------------------------------------------------------------------------------------
  //  ALL-rows operations
  //----------------------------------------------------------------------------------------------
  async function performAll(routine: string) {
    setConfirmDialog(prev => ({ ...prev, isOpen: false }))
    setMessage(`Running ${routine} for all tables...`)
    setRunning(true)
    try {
      await Promise.all(tables.map((_, i) => performOne(routine, i)))
      await Promise.all([refreshBase(), refreshBackups()])
      if (routine === 'DOWN' && dataDirectory) await refreshDirectory()
      setMessage(`${routine} ALL done`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  async function performOne(routine: string, i: number) {
    switch (routine) {
      case 'SEQRESET': return performSeqReset(i, true)
      case 'DUP':      return performDup(i, true)
      case 'CLEAR':    return performClear(i, true)
      case 'COPY':     return performCopy(i, true)
      case 'TOBASE':   return performToBase(i, true)
      case 'DROP':     return performDrop(i, true)
      case 'DOWN':     return performDown(i, true)
      case 'UPLOAD':   return performUpload(i, true)
    }
  }

  function confirmAll(routine: string, title: string, subTitle: string) {
    confirm(title, subTitle, () => performAll(routine))
  }

  const anyBackupExists = backups.some(b => b?.exists)
  const noBackupExists  = backups.length > 0 && !anyBackupExists

  return (
    <div>
      <div className='flex items-center gap-2 mb-3'>
        <MyHelp items={HELP_ITEMS} title='Backup Help' label='Help' />
      </div>

      <div className='mb-3'>
        <ConnectionPicker
          label='Database'
          connections={connections}
          value={connKey}
          onChange={v => { setConnKey(v); setTables([]); setBackups([]); setJsonRows([]); setMessage('') }}
        />
      </div>

      {tables.length === 0 ? (
        <div className='ml-20'>
          <MyButton onClick={refreshBase} overrideClass='h-6 px-2 py-2' disabled={!url || running}>
            Load Tables
          </MyButton>
        </div>
      ) : (
        <div className='overflow-x-auto'>
          <table className='min-w-full text-gray-900 table-auto text-xs'>
            <thead className='sticky top-0 z-10 bg-gray-50 text-left font-normal'>
              {/* Header row 1 — section labels */}
              <tr>
                <th className='pb-1 px-2' colSpan={3}>
                  <div className='font-bold rounded border border-blue-500 py-1 text-center'>Postgres Base Tables</div>
                </th>
                <th className='pb-1 px-2' colSpan={8}>
                  <div className='font-bold rounded border border-blue-500 py-1 text-center'>Postgres Backup Tables</div>
                </th>
                <th className='pb-1 px-2' colSpan={4}>
                  <div className='font-bold rounded border border-blue-500 py-1 text-center'>{`PC Folder (${DIR_PREFIX}${dataDirectory})`}</div>
                </th>
              </tr>
              {/* Header row 2 — column names */}
              <tr>
                <th className='px-2'>Table</th>
                <th className='px-2 text-right'>Records</th>
                <th className='px-2 text-center'>Reset</th>
                <th className='px-2'>Backup table</th>
                <th className='px-2 text-center'>Exists</th>
                <th className='px-2 text-right'>Records</th>
                <th className='px-2 text-center'>Drop</th>
                <th className='px-2 text-center'>Duplicate</th>
                <th className='px-2 text-center'>Clear</th>
                <th className='px-2 text-center'>Copy</th>
                <th className='px-2 text-center'>ToBase</th>
                <th className='px-2 text-center'>
                  <div className='inline-flex items-center gap-1'>
                    <MyInput
                      overrideClass='w-32 text-center'
                      type='text'
                      value={dataDirectory}
                      onChange={e => setDataDirectory(e.target.value)}
                    />
                  </div>
                </th>
                <th className='px-2 text-center'>Exists</th>
                <th className='px-2 text-right'>Records</th>
                <th className='px-2 text-center'>Upload</th>
              </tr>
              {/* Header row 3 — ALL-row buttons */}
              <tr className='align-bottom'>
                <th className='px-2'></th>
                <th className='px-2 text-right'>
                  <MyButton onClick={refreshBase} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Refresh</MyButton>
                </th>
                <th className='px-2 text-center'>
                  <MyButton onClick={() => confirmAll('SEQRESET','RESET SEQUENCE for ALL','Reset Sequence on BASE')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>SeqReset</MyButton>
                </th>
                <th className='px-2 text-left'>
                  <div className='inline-flex items-center gap-1'>
                    <MyInput overrideClass='w-20' type='text' value={backupPrefix} onChange={e => setBackupPrefix(e.target.value)} />
                  </div>
                </th>
                <th className='px-2 text-center'>
                  <MyButton onClick={refreshBackups} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Refresh</MyButton>
                </th>
                <th className='px-2'></th>
                <th className='px-2 text-center'>
                  {anyBackupExists && <MyButton onClick={() => confirmAll('DROP','DROP for ALL','Drop BACKUP')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Drop ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {noBackupExists && <MyButton onClick={() => confirmAll('DUP','DUPLICATE for ALL','Duplicate from BASE to BACKUP')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Dup ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {anyBackupExists && <MyButton onClick={() => confirmAll('CLEAR','CLEAR for ALL','Clear BACKUP')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Clear ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {anyBackupExists && <MyButton onClick={() => confirmAll('COPY','COPY for ALL','Copy from BASE to BACKUP')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Copy ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {tables.length > 0 && <MyButton onClick={() => confirmAll('TOBASE','COPY for ALL to ToBase','Copy from BACKUP to BASE')} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>ToBase ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {tables.length > 0 && dataDirectory && <MyButton onClick={() => confirmAll('DOWN','DOWN for ALL',`Down from BASE to ${DIR_PREFIX}${dataDirectory}`)} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Down ALL</MyButton>}
                </th>
                <th className='px-2 text-center'>
                  {dataDirectory && <MyButton onClick={refreshDirectory} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Refresh</MyButton>}
                </th>
                <th className='px-2'></th>
                <th className='px-2 text-center'>
                  {jsonRows.some(j => j?.exists) && <MyButton onClick={() => confirmAll('UPLOAD','UPLOAD for ALL',`Upload from ${DIR_PREFIX}${dataDirectory} to BACKUP`)} overrideClass='h-6 px-2 py-1 bg-red-500 hover:bg-red-600' disabled={running}>Upload ALL</MyButton>}
                </th>
              </tr>
            </thead>
            <tbody>
              {tables.map((row, i) => {
                const bk = backups[i]
                const jr = jsonRows[i]
                return (
                  <tr key={row.table} className={i % 2 === 0 ? 'bg-white' : 'bg-blue-50'}>
                    <td className='px-2 py-1'>{row.table}</td>
                    <td className='px-2 py-1 text-right'>{row.count}</td>
                    <td className='px-2 py-1 text-center'>
                      <MyButton onClick={() => confirm('SEQRESET','Reset Sequence on BASE', () => performSeqReset(i))} overrideClass='h-6 px-2 py-1'>SeqReset</MyButton>
                    </td>
                    <td className='px-2 py-1'>{bk?.name ?? backupName(row.table)}</td>
                    <td className='px-2 py-1 text-center'>{bk?.exists ? 'Y' : ''}</td>
                    <td className='px-2 py-1 text-right'>{bk?.exists ? bk.count : ''}</td>
                    <td className='px-2 py-1 text-center'>
                      {bk?.exists && <MyButton onClick={() => confirm('DROP','Drop BACKUP', () => performDrop(i))} overrideClass='h-6 px-2 py-1'>Drop</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>
                      {!bk?.exists && <MyButton onClick={() => confirm('DUPLICATE','Duplicate BASE to BACKUP', () => performDup(i))} overrideClass='h-6 px-2 py-1'>Duplicate</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>
                      {bk?.exists && <MyButton onClick={() => confirm('CLEAR','Clear BACKUP', () => performClear(i))} overrideClass='h-6 px-2 py-1'>Clear</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>
                      {bk?.exists && <MyButton onClick={() => confirm('COPY','Copy BASE to BACKUP', () => performCopy(i))} overrideClass='h-6 px-2 py-1'>Copy</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>
                      {bk?.exists && (bk.count ?? 0) > 0 && <MyButton onClick={() => confirm('TOBASE','Restore BACKUP to BASE', () => performToBase(i))} overrideClass='h-6 px-2 py-1'>ToBase</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>
                      {row.count > 0 && dataDirectory && <MyButton onClick={() => confirm('DOWN','Export BASE to JSON', () => performDown(i))} overrideClass='h-6 px-2 py-1'>Down</MyButton>}
                    </td>
                    <td className='px-2 py-1 text-center'>{jr?.exists ? 'Y' : ''}</td>
                    <td className='px-2 py-1 text-right'>{jr?.exists ? jr.count : ''}</td>
                    <td className='px-2 py-1 text-center'>
                      {jr?.exists && bk?.exists && <MyButton onClick={() => confirm('UPLOAD','Upload JSON to BACKUP', () => performUpload(i))} overrideClass='h-6 px-2 py-1'>Upload</MyButton>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {message && (
        <div className='mt-3 text-xs text-red-700'>{message}</div>
      )}

      <MyConfirmDialog confirmDialog={confirmDialog} setConfirmDialog={setConfirmDialog} />
    </div>
  )
}
