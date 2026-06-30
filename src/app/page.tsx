import { readFileSync } from 'fs'
import { join } from 'path'
import DatabaseToolsConnDynamic from '@/src/components/DatabaseToolsConnDynamic'
import type { ConnectionsFile, ConnectionEntry } from '@/src/types/connections'

//----------------------------------------------------------------------------------------------
//  Page — reads connections.json from the project root, flattens to ConnectionEntry[],
//  and passes to DatabaseToolsConn. Runs only on the server so the file read is safe.
//----------------------------------------------------------------------------------------------
export default function Page() {
  let connections: ConnectionEntry[] = []
  try {
    const raw  = readFileSync(join(process.cwd(), 'connections.json'), 'utf8')
    const file = JSON.parse(raw) as ConnectionsFile
    for (const [project, envs] of Object.entries(file)) {
      for (const [env, conn] of Object.entries(envs)) {
        if (!conn.url) continue
        connections.push({
          key:        `${project}.${env}`,
          projectKey: project,
          label:      conn.label,
          url:        conn.url,
          colour:     conn.colour,
        })
      }
    }
  } catch {
    // connections.json missing or malformed — DatabaseToolsConn will show the empty-state message
  }

  return (
    <div className='mx-4 my-4'>
      <h1 className='text-lg font-bold mb-4'>DB Admin</h1>
      <DatabaseToolsConnDynamic connections={connections} />
    </div>
  )
}
