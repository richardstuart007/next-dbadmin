import type { ArbitraryDb } from '@/src/lib/dbArbitrary'

//
//  Types — mirror nextjs-shared/src/backup/schemaUtils.ts
//
export type SchemaRow = {
  table_name: string
  column_name: string
  data_type: string
  max_len: number | null
  is_nullable: string
  column_default: string | null
  is_identity: string
  identity_generation: string | null
  is_pk: boolean
  is_unique: boolean
  has_index: boolean
}

export type DiffRow = SchemaRow & { side: string }

export type ChangeRow = {
  table_name: string
  column_name: string
  source: SchemaRow
  target: SchemaRow
}

export type TableStatus = 'identical' | 'different' | 'only_in_source' | 'only_in_target'

export type TableSummary = {
  table_name: string
  status: TableStatus
  count1?: number | null
  count2?: number | null
}

export type SchemaCompareResult = {
  label1: string
  label2: string
  schema1: SchemaRow[]
  onlyIn1: DiffRow[]
  onlyIn2: DiffRow[]
  changed: ChangeRow[]
  tableSummary: TableSummary[]
}

export type DDLComparisonRow = {
  table_name: string
  status:     TableStatus
  sourceDDL:  string | null
  targetDDL:  string | null
}

export type DDLCompareResult = {
  label1: string
  label2: string
  rows:   DDLComparisonRow[]
}

//----------------------------------------------------------------------------------
//  diffDDLMaps — pure function: compare two pre-built DDL maps → DDLCompareResult.
//  DDL is normalised (trim + collapse blank lines) before comparison so whitespace
//  differences between pg_dump versions don't create false positives.
//  Used by both compareDDLsFromUrls (DB vs DB) and compareDDLWithFile (DB vs file).
//----------------------------------------------------------------------------------
export function diffDDLMaps(
  srcMap: Map<string, string>,
  tgtMap: Map<string, string>,
  label1: string,
  label2: string
): DDLCompareResult {
  const allTables = [...new Set([...srcMap.keys(), ...tgtMap.keys()])].sort()

  function normalize(sql: string): string {
    return sql.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !/^START WITH \d+$/.test(l))
      .join('\n')
  }

  const rows: DDLComparisonRow[] = allTables.map(table_name => {
    const sourceDDL = srcMap.get(table_name) ?? null
    const targetDDL = tgtMap.get(table_name) ?? null
    let status: TableStatus
    if (sourceDDL !== null && targetDDL !== null) {
      status = normalize(sourceDDL) === normalize(targetDDL) ? 'identical' : 'different'
    } else {
      status = sourceDDL !== null ? 'only_in_source' : 'only_in_target'
    }
    const result: DDLComparisonRow = { table_name, status, sourceDDL, targetDDL }
    return result
  })

  const result: DDLCompareResult = { label1, label2, rows }
  return result
}

//----------------------------------------------------------------------------------
//  fetchSchema — query all columns in the public schema with PK, unique, index flags
//----------------------------------------------------------------------------------
export async function fetchSchema(db: ArbitraryDb): Promise<SchemaRow[]> {
  const result = await db.query({
    query: `
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.character_maximum_length AS max_len,
        c.is_nullable,
        c.column_default,
        c.is_identity,
        c.identity_generation,
        EXISTS(
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema    = kcu.table_schema
          WHERE tc.table_schema    = 'public'
            AND tc.constraint_type = 'PRIMARY KEY'
            AND kcu.table_name     = c.table_name
            AND kcu.column_name    = c.column_name
        ) AS is_pk,
        EXISTS(
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema    = kcu.table_schema
          WHERE tc.table_schema    = 'public'
            AND tc.constraint_type = 'UNIQUE'
            AND kcu.table_name     = c.table_name
            AND kcu.column_name    = c.column_name
        ) AS is_unique,
        EXISTS(
          SELECT 1 FROM pg_indexes ix
          WHERE ix.schemaname = 'public'
            AND ix.tablename  = c.table_name
            AND ix.indexdef  LIKE '%' || c.column_name || '%'
        ) AS has_index
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
      ORDER BY c.table_name, c.ordinal_position
    `,
  })
  return result.rows as SchemaRow[]
}

//----------------------------------------------------------------------------------
//  diffSchemas — compare two SchemaRow arrays, return per-column and per-table diffs
//----------------------------------------------------------------------------------
function normalizeDefault(d: string | null): string | null {
  if (!d) return d
  return d.replace(/nextval\('public\.([^']+)'(::regclass)?\)/g, "nextval('$1'$2)")
}

export function diffSchemas(
  rows1: SchemaRow[],
  rows2: SchemaRow[],
  label1: string,
  label2: string
): Omit<SchemaCompareResult, 'label1' | 'label2' | 'schema1'> {
  const key   = (r: SchemaRow) => `${r.table_name}::${r.column_name}`
  const map1  = new Map(rows1.map(r => [key(r), r]))
  const map2  = new Map(rows2.map(r => [key(r), r]))

  const onlyIn1: DiffRow[] = rows1.filter(r => !map2.has(key(r))).map(r => ({ ...r, side: label1 }))
  const onlyIn2: DiffRow[] = rows2.filter(r => !map1.has(key(r))).map(r => ({ ...r, side: label2 }))

  const changed: ChangeRow[] = []
  for (const [k, src] of map1) {
    const tgt = map2.get(k)
    if (!tgt) continue
    if (
      src.data_type !== tgt.data_type ||
      src.max_len !== tgt.max_len ||
      src.is_nullable !== tgt.is_nullable ||
      normalizeDefault(src.column_default) !== normalizeDefault(tgt.column_default) ||
      src.is_identity !== tgt.is_identity ||
      src.identity_generation !== tgt.identity_generation
    ) {
      changed.push({ table_name: src.table_name, column_name: src.column_name, source: src, target: tgt })
    }
  }

  const tables1   = [...new Set(rows1.map(r => r.table_name))].sort()
  const tables2   = new Set(rows2.map(r => r.table_name))
  const diffTables = new Set([
    ...onlyIn1.map(r => r.table_name),
    ...onlyIn2.map(r => r.table_name),
    ...changed.map(r => r.table_name),
  ])
  const allTables = [...new Set([...tables1, ...rows2.map(r => r.table_name)])].sort()

  const tableSummary: TableSummary[] = allTables.map(t => {
    const inSource = tables1.includes(t)
    const inTarget = tables2.has(t)
    let status: TableStatus
    if (inSource && inTarget) {
      status = diffTables.has(t) ? 'different' : 'identical'
    } else {
      status = inSource ? 'only_in_source' : 'only_in_target'
    }
    return { table_name: t, status }
  })

  return { onlyIn1, onlyIn2, changed, tableSummary }
}

//----------------------------------------------------------------------------------
//  generateAlterSQL — produce ALTER TABLE / CREATE TABLE SQL to sync target to source
//----------------------------------------------------------------------------------
export function buildTypeStr(col: SchemaRow): string {
  if ((col.data_type === 'character varying' || col.data_type === 'character') && col.max_len) {
    return col.data_type === 'character varying' ? `VARCHAR(${col.max_len})` : `CHAR(${col.max_len})`
  }
  return col.data_type.toUpperCase()
}

export function generateAlterSQL(result: SchemaCompareResult): string[] {
  const sqls: string[] = []

  const missingTables = new Set(
    result.tableSummary.filter(t => t.status === 'only_in_source').map(t => t.table_name)
  )
  const byTable = new Map<string, DiffRow[]>()
  for (const col of result.onlyIn1) {
    ;(byTable.get(col.table_name) ?? byTable.set(col.table_name, []).get(col.table_name)!).push(col)
  }

  for (const [tableName, cols] of byTable) {
    if (missingTables.has(tableName)) {
      sqls.push(`-- CREATE TABLE ${tableName} — use pg_dump --schema-only for full DDL including indexes`)
    } else {
      for (const col of cols) {
        const typeStr = buildTypeStr(col)
        const nullStr = col.is_nullable === 'NO' ? ' NOT NULL' : ''
        const defStr  = col.column_default ? ` DEFAULT ${col.column_default}` : ''
        sqls.push(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${col.column_name} ${typeStr}${nullStr}${defStr};`)
      }
    }
  }

  for (const c of result.changed) {
    if (c.source.data_type !== c.target.data_type || c.source.max_len !== c.target.max_len) {
      const typeStr = buildTypeStr(c.source)
      sqls.push(`ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} TYPE ${typeStr} USING ${c.column_name}::text::${typeStr};`)
    }
    if (c.source.is_nullable !== c.target.is_nullable) {
      sqls.push(
        c.source.is_nullable === 'NO'
          ? `ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} SET NOT NULL;`
          : `ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} DROP NOT NULL;`
      )
    }
    if (c.source.column_default !== c.target.column_default) {
      if (c.source.column_default?.startsWith('nextval(') && !c.target.column_default) {
        sqls.push(`-- Skipped: ${c.table_name}.${c.column_name} — target may be an IDENTITY column`)
      } else {
        sqls.push(
          c.source.column_default
            ? `ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} SET DEFAULT ${c.source.column_default};`
            : `ALTER TABLE ${c.table_name} ALTER COLUMN ${c.column_name} DROP DEFAULT;`
        )
      }
    }
  }

  const targetOnlyTables = new Set(
    result.tableSummary.filter(t => t.status === 'only_in_target').map(t => t.table_name)
  )
  const droppedTables = new Set<string>()
  for (const col of result.onlyIn2) {
    if (targetOnlyTables.has(col.table_name)) {
      if (!droppedTables.has(col.table_name)) {
        droppedTables.add(col.table_name)
        sqls.push(`-- Table only in ${result.label2}, not in ${result.label1} — drop if intended:`)
        sqls.push(`-- DROP TABLE ${col.table_name};`)
      }
    } else {
      sqls.push(`-- Column only in ${result.label2}, not in ${result.label1} — drop if intended:`)
      sqls.push(`-- ALTER TABLE ${col.table_name} DROP COLUMN ${col.column_name};`)
    }
  }

  return sqls
}

//----------------------------------------------------------------------------------
//  generateTableSQL — per-table SQL shown when a row is clicked in the schema summary
//----------------------------------------------------------------------------------
export function generateTableSQL(result: SchemaCompareResult, tableName: string): string {
  const summary = result.tableSummary.find(t => t.table_name === tableName)
  if (!summary) return ''

  if (summary.status === 'only_in_target') {
    const cols = result.onlyIn2.filter(r => r.table_name === tableName)
    const lines = [`CREATE TABLE ${tableName} (`]
    cols.forEach((col, i) => {
      const typeStr = buildTypeStr(col)
      const nullStr = col.is_nullable === 'NO' ? ' NOT NULL' : ''
      const defStr  = col.column_default ? ` DEFAULT ${col.column_default}` : ''
      lines.push(`  ${col.column_name} ${typeStr}${nullStr}${defStr}${i < cols.length - 1 ? ',' : ''}`)
    })
    lines.push(');')
    return lines.join('\n')
  }

  // identical, only_in_source, different — all use schema1 for CREATE TABLE
  const sourceCols = result.schema1.filter(r => r.table_name === tableName)
  const createLines = [`CREATE TABLE ${tableName} (`]
  sourceCols.forEach((col, i) => {
    const typeStr = buildTypeStr(col)
    const nullStr = col.is_nullable === 'NO' ? ' NOT NULL' : ''
    const defStr  = col.column_default ? ` DEFAULT ${col.column_default}` : ''
    createLines.push(`  ${col.column_name} ${typeStr}${nullStr}${defStr}${i < sourceCols.length - 1 ? ',' : ''}`)
  })
  createLines.push(');')

  if (summary.status !== 'different') return createLines.join('\n')

  const filtered: SchemaCompareResult = {
    ...result,
    onlyIn1:      result.onlyIn1.filter(r => r.table_name === tableName),
    onlyIn2:      result.onlyIn2.filter(r => r.table_name === tableName),
    changed:      result.changed.filter(r => r.table_name === tableName),
    tableSummary: result.tableSummary.filter(t => t.table_name === tableName),
  }
  const alterLines = generateAlterSQL(filtered)
  return [createLines.join('\n'), '', '-- Changes to apply', ...alterLines].join('\n')
}
