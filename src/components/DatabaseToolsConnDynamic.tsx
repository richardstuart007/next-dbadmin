'use client'

import dynamic from 'next/dynamic'
import type { ConnectionEntry } from '@/src/types/connections'

const DatabaseToolsConn = dynamic(() => import('./DatabaseToolsConn'), { ssr: false })

//----------------------------------------------------------------------------------------------
//  DatabaseToolsConnDynamic — client-side wrapper that lazy-loads DatabaseToolsConn
//  ssr: false prevents hydration mismatches from browser extensions modifying inputs.
//  Must be a 'use client' component — Next.js 15 disallows ssr:false in Server Components.
//----------------------------------------------------------------------------------------------
export default function DatabaseToolsConnDynamic({ connections }: { connections: ConnectionEntry[] }) {
  return <DatabaseToolsConn connections={connections} />
}
