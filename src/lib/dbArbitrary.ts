import { Client } from 'pg'

export type ArbitraryDb = {
  query: (opts: { query: string; params?: any[] }) => Promise<{ rows: any[]; rowCount: number | null; fields: Array<{ name: string }> }>
}

//
//  pg-connection-string treats sslmode=require as an alias for verify-full (full CA
//  chain + hostname verification) unless uselibpqcompat is set — see
//  node_modules/pg-connection-string/index.js. Managed providers like Aiven use their
//  own CA, which isn't in Node's trust store, so verification fails and every query
//  through this file would silently return empty results. Stripping sslmode and
//  passing ssl explicitly restores psql/pg_dump's traditional "encrypt, don't verify"
//  behavior for sslmode=require.
//
//  sslmode=disable (or absent) must resolve to ssl: false, not just an omitted sslmode —
//  passing any truthy ssl object makes pg require SSL, and if the server doesn't support
//  it at all (typical local Postgres), connect() throws "The server does not support SSL
//  connections" instead of falling back to plaintext.
//
function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString)
  url.searchParams.delete('sslmode')
  return url.toString()
}

function resolveSsl(connectionString: string): false | { rejectUnauthorized: boolean } {
  const sslmode = new URL(connectionString).searchParams.get('sslmode')
  if (!sslmode || sslmode === 'disable') return false
  return { rejectUnauthorized: false }
}

/** Create a query handler that connects to any PostgreSQL database via pg.Client.
 *  Use this for backup/admin operations that need arbitrary database connections — not the app's own POSTGRES_URL. */
export function createArbitraryDb(connectionString: string): ArbitraryDb {
  return {
    query: async ({ query, params = [] }) => {
      const client = new Client({ connectionString: stripSslMode(connectionString), ssl: resolveSsl(connectionString) })
      try {
        await client.connect()
        const result = await client.query(query.replace(/\s+/g, ' ').trim(), params)
        return { rows: result.rows, rowCount: result.rowCount, fields: result.fields ?? [] }
      } finally {
        await client.end().catch(() => {})
      }
    },
  }
}

/** Run multiple queries sequentially on a single pg.Client connection — use for batched operations like DROP + CREATE + many INSERTs. */
export async function runBatch(
  connectionString: string,
  queries: Array<{ query: string; params?: any[] }>
): Promise<void> {
  const client = new Client({ connectionString: stripSslMode(connectionString), ssl: resolveSsl(connectionString) })
  try {
    await client.connect()
    for (const { query, params = [] } of queries) {
      await client.query(query.replace(/\s+/g, ' ').trim(), params)
    }
  } finally {
    await client.end().catch(() => {})
  }
}
