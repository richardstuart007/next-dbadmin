import { NextRequest } from 'next/server'
import { Client } from 'pg'

const BATCH = 500

//----------------------------------------------------------------------------------
//  sse — encode a JSON event as Server-Sent Events format
//----------------------------------------------------------------------------------
function sse(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)
}

//----------------------------------------------------------------------------------
//  stripUnsupported — remove query params unsupported by pg (e.g. timezone=)
//----------------------------------------------------------------------------------
function stripUnsupported(url: string): string {
  return url.replace(/[&?]timezone=[^&]*/g, '')
}

//----------------------------------------------------------------------------------
//  POST — stream table copy progress as SSE
//  Body: { sourceUrl, targetUrl, tables }
//  Streams: { table, status: 'starting'|'truncating'|'progress'|'done'|'error', ... }
//  Final:   { done: true, ok, errors }
//----------------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  const { tables, sourceUrl, targetUrl } = (await req.json()) as {
    tables: string[]
    sourceUrl: string
    targetUrl: string
  }

  if (!tables?.length || !sourceUrl || !targetUrl) {
    return new Response(JSON.stringify({ error: 'tables, sourceUrl, and targetUrl are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const src = new Client({ connectionString: stripUnsupported(sourceUrl) })
  const tgt = new Client({ connectionString: stripUnsupported(targetUrl) })

  const stream = new ReadableStream({
    async start(controller) {
      let ok     = 0
      let errors = 0

      try {
        await src.connect()
        await tgt.connect()
        await tgt.query('SET session_replication_role = replica')

        for (const table of tables) {
          controller.enqueue(sse({ table, status: 'starting' }))
          try {
            const colRes = await src.query<{ column_name: string }>(
              `SELECT column_name FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = $1
               ORDER BY ordinal_position`,
              [table]
            )
            const cols    = colRes.rows.map(r => r.column_name)
            const colList = cols.map(c => `"${c}"`).join(', ')

            const countRes = await src.query<{ count: string }>(`SELECT COUNT(*) FROM "${table}"`)
            const total    = parseInt(countRes.rows[0].count, 10)

            controller.enqueue(sse({ table, status: 'truncating' }))
            await tgt.query(`TRUNCATE "${table}" CASCADE`)

            let done = 0
            while (true) {
              const rows = await src.query(
                `SELECT ${colList} FROM "${table}" ORDER BY 1 LIMIT $1 OFFSET $2`,
                [BATCH, done]
              )
              if (rows.rows.length === 0) break
              const placeholders = rows.rows
                .map((_: unknown, ri: number) => `(${cols.map((_: unknown, ci: number) => `$${ri * cols.length + ci + 1}`).join(', ')})`)
                .join(', ')
              const values = rows.rows.flatMap((row: Record<string, unknown>) => cols.map(c => row[c]))
              await tgt.query(`INSERT INTO "${table}" (${colList}) VALUES ${placeholders}`, values)
              done += rows.rows.length
              controller.enqueue(sse({ table, status: 'progress', done, total }))
              if (rows.rows.length < BATCH) break
            }

            controller.enqueue(sse({ table, status: 'done', rows: done }))
            ok++
          } catch (error) {
            controller.enqueue(sse({ table, status: 'error', error: (error as Error).message }))
            errors++
          }
        }

        await tgt.query('SET session_replication_role = DEFAULT')
      } catch (error) {
        controller.enqueue(sse({ error: (error as Error).message }))
      } finally {
        await src.end().catch(() => {})
        await tgt.end().catch(() => {})
      }

      controller.enqueue(sse({ done: true, ok, errors }))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
