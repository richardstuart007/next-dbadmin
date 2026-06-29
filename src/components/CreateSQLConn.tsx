'use client'

import { useState } from 'react'
import { MyButton } from 'nextjs-shared/MyButton'
import { MyHelp } from 'nextjs-shared/MyHelp'
import type { HelpItem } from 'nextjs-shared/MyHelp'
import { generateCreateSQLFromUrl } from '@/src/actions/schemaSyncActions'
import type { TableDDL } from '@/src/actions/schemaSyncActions'
import ConnectionPicker from './ConnectionPicker'
import type { ConnectionEntry } from '@/src/types/connections'

const HELP_ITEMS: HelpItem[] = [
  {
    heading: 'Create SQL',
    body: 'Runs pg_dump --schema-only against the selected database and returns full CREATE TABLE + index DDL per table. Use this to recreate a schema from scratch or as the authoritative DDL for new tables.',
  },
  {
    heading: 'Select a table',
    body: 'Click a table name on the left to see its CREATE TABLE statement and associated indexes on the right.',
  },
]

//----------------------------------------------------------------------------------------------
//  CreateSQLConn — generate CREATE TABLE DDL from a database selected via ConnectionPicker
//  Calls generateCreateSQLFromUrl server action (runs pg_dump --schema-only).
//----------------------------------------------------------------------------------------------
export default function CreateSQLConn({ connections }: { connections: ConnectionEntry[] }) {
  const firstKey = connections[0]?.key ?? ''

  const [sourceKey, setSourceKey]           = useState(firstKey)
  const [tableDDLs, setTableDDLs]           = useState<TableDDL[]>([])
  const [selectedTable, setSelectedTable]   = useState('')
  const [message, setMessage]               = useState('')
  const [running, setRunning]               = useState(false)

  const sourceConn = connections.find(c => c.key === sourceKey)

  //----------------------------------------------------------------------------------------------
  //  handleGenerate — runs pg_dump --schema-only via server action and parses DDL by table
  //----------------------------------------------------------------------------------------------
  async function handleGenerate() {
    if (!sourceConn?.url) return
    setRunning(true)
    setTableDDLs([])
    setSelectedTable('')
    setMessage('Generating CREATE SQL...')
    try {
      const ddls = await generateCreateSQLFromUrl(sourceConn.url)
      setTableDDLs(ddls)
      setSelectedTable(ddls[0]?.table_name ?? '')
      setMessage(`${ddls.length} table${ddls.length !== 1 ? 's' : ''}`)
    } catch (error) {
      setMessage(`Error: ${(error as Error).message}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2'>
        <MyHelp items={HELP_ITEMS} title='Create SQL Help' label='Help' />
      </div>

      <ConnectionPicker
        label='Source'
        connections={connections}
        value={sourceKey}
        onChange={v => { setSourceKey(v); setTableDDLs([]); setSelectedTable(''); setMessage('') }}
      />

      <div className='ml-20'>
        <MyButton
          onClick={handleGenerate}
          overrideClass='h-6 px-2 py-2'
          disabled={!sourceKey || running}
        >
          Generate from {sourceConn?.label ?? 'source'}
        </MyButton>
      </div>

      {message && (
        <p className={`text-xs ${message.startsWith('Error') ? 'text-red-700' : 'text-gray-600'}`}>
          {message}
        </p>
      )}

      {tableDDLs.length > 0 && (
        <div className='flex gap-2 border rounded bg-white' style={{ minHeight: '300px' }}>
          <div className='w-48 shrink-0 border-r overflow-y-auto'>
            <button
              onClick={() => setSelectedTable('__all__')}
              className={`w-full text-left px-2 py-1 text-xs font-semibold truncate border-b border-gray-200 hover:bg-blue-50 ${
                selectedTable === '__all__' ? 'bg-blue-100 text-blue-800' : 'text-gray-500'
              }`}
            >
              All Tables
            </button>
            {tableDDLs.map(t => (
              <button
                key={t.table_name}
                onClick={() => setSelectedTable(t.table_name)}
                className={`w-full text-left px-2 py-1 text-xs font-mono truncate border-b border-gray-100 hover:bg-blue-50 ${
                  selectedTable === t.table_name ? 'bg-blue-100 font-semibold text-blue-800' : 'text-gray-700'
                }`}
              >
                {t.table_name}
              </button>
            ))}
          </div>
          <div className='flex-1 p-2 overflow-auto'>
            {selectedTable && (
              <pre className='text-xs font-mono whitespace-pre-wrap text-gray-800'>
                {selectedTable === '__all__'
                  ? tableDDLs.map(t => `-- ${t.table_name}\n${t.sql}`).join('\n\n')
                  : tableDDLs.find(t => t.table_name === selectedTable)?.sql ?? ''}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
