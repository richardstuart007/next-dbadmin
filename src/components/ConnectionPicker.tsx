'use client'

import MySelect from 'nextjs-shared/MySelect'
import type { ConnectionEntry } from '@/src/types/connections'

//----------------------------------------------------------------------------------------------
//  ConnectionPicker — two-step connection selector: project dropdown then environment dropdown
//  value is the full "project.env" key; both dropdowns are fully controlled from it.
//----------------------------------------------------------------------------------------------
export default function ConnectionPicker({
  label,
  connections,
  value,
  onChange,
  highlight = false,
}: {
  label:       string
  connections: ConnectionEntry[]
  value:       string
  onChange:    (key: string) => void
  highlight?:  boolean
}) {
  const [selectedProject, selectedEnv] = value.split('.')

  const projects   = [...new Set(connections.map(c => c.projectKey))]
  const envEntries = connections.filter(c => c.projectKey === selectedProject)
  const selected   = connections.find(c => c.key === value)

  function handleProjectChange(project: string) {
    const firstEnv = connections.find(c => c.projectKey === project)
    if (firstEnv) onChange(firstEnv.key)
  }

  function handleEnvChange(env: string) {
    onChange(`${selectedProject}.${env}`)
  }

  return (
    <div className='flex items-center gap-2'>
      <MySelect
        label={label}
        value={selectedProject}
        onChange={e => handleProjectChange((e.target as HTMLSelectElement).value)}
        overrideClass={`w-44 text-xs${highlight ? ' bg-yellow-100' : ''}`}
        labelClass='text-xs font-bold w-16 text-right shrink-0 whitespace-nowrap'
      >
        {projects.map(p => (
          <option key={p} value={p}>{p}</option>
        ))}
      </MySelect>
      <MySelect
        label=''
        value={selectedEnv}
        onChange={e => handleEnvChange((e.target as HTMLSelectElement).value)}
        overrideClass='w-28 text-xs'
        labelClass='hidden'
      >
        {envEntries.map(conn => {
          const env = conn.key.split('.')[1]
          return <option key={conn.key} value={env}>{env}</option>
        })}
      </MySelect>
      {selected?.colour && (
        <span
          className='w-2.5 h-2.5 rounded-full shrink-0'
          style={{ backgroundColor: selected.colour }}
        />
      )}
    </div>
  )
}
