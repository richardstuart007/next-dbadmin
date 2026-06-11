'use client'

import { useState } from 'react'
import CopyTableConn from './CopyTableConn'
import SchemaSyncConn from './SchemaSyncConn'
import BackupConn from './BackupConn'
import CreateSQLConn from './CreateSQLConn'
import type { ConnectionEntry } from '@/src/types/connections'

type Tab = 'backup' | 'copy' | 'schema' | 'createsql'

const TABS: { id: Tab; label: string }[] = [
  { id: 'backup',    label: 'Backup' },
  { id: 'copy',      label: 'Copy Tables' },
  { id: 'schema',    label: 'Schema Sync' },
  { id: 'createsql', label: 'Create SQL' },
]

//----------------------------------------------------------------------------------------------
//  DatabaseToolsConn — tab container for CopyTableConn and SchemaSyncConn
//  Receives flattened ConnectionEntry[] from the server page (read from connections.json).
//----------------------------------------------------------------------------------------------
export default function DatabaseToolsConn({ connections }: { connections: ConnectionEntry[] }) {
  const [activeTab, setActiveTab] = useState<Tab>('backup')

  if (connections.length === 0) {
    return (
      <div className='p-4 border border-red-300 rounded bg-red-50 text-xs text-red-700'>
        No connections found. Edit <code>connections.json</code> in the project root and restart the dev server.
      </div>
    )
  }

  return (
    <div className='flex flex-col w-full'>
      <div className='flex border-b border-gray-300 shrink-0'>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'border-b-2 border-blue-600 text-blue-700 bg-white'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className='pt-3'>
        <div className={activeTab === 'backup'    ? '' : 'hidden'}><BackupConn     connections={connections} /></div>
        <div className={activeTab === 'copy'      ? '' : 'hidden'}><CopyTableConn  connections={connections} /></div>
        <div className={activeTab === 'schema'    ? '' : 'hidden'}><SchemaSyncConn connections={connections} /></div>
        <div className={activeTab === 'createsql' ? '' : 'hidden'}><CreateSQLConn  connections={connections} /></div>
      </div>
    </div>
  )
}
