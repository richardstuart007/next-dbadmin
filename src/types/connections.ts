export type Connection = {
  url: string
  label: string
  colour?: string
}

export type ConnectionsFile = Record<string, Record<string, Connection>>

// Flattened for component use — key = "nextchess.local", "nextchess.production", etc.
export type ConnectionEntry = {
  key:        string
  projectKey: string
  label:      string
  url:        string
  colour?:    string
}
