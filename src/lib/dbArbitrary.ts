import { Client } from 'pg'

export type ArbitraryDb = {
  query: (opts: { query: string; params?: any[] }) => Promise<{ rows: any[]; rowCount: number | null; fields: Array<{ name: string }> }>
}

/** Create a query handler that connects to any PostgreSQL database via pg.Client.
 *  Use this for backup/admin operations that need arbitrary database connections — not the app's own POSTGRES_URL. */
export function createArbitraryDb(connectionString: string): ArbitraryDb {
  return {
    query: async ({ query, params = [] }) => {
      const client = new Client({ connectionString })
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
  const client = new Client({ connectionString })
  try {
    await client.connect()
    for (const { query, params = [] } of queries) {
      await client.query(query.replace(/\s+/g, ' ').trim(), params)
    }
  } finally {
    await client.end().catch(() => {})
  }
}
