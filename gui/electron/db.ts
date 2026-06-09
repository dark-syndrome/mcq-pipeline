import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { DB_PATH } from './paths'

// Read-only access to logs/runs.db via sql.js (WASM). The Python pipeline owns
// all writes; the GUI only reads, so an in-memory snapshot is sufficient.
// Replaceable with better-sqlite3 later if interactive perf on a large DB
// demands native bindings (see docs/BUILD_CHECKLIST.md deviation note).

let SQL: SqlJsStatic | null = null
let db: Database | null = null

async function ensure(): Promise<Database | null> {
  if (!SQL) {
    SQL = await initSqlJs({
      locateFile: (file) =>
        path.join(path.dirname(require.resolve('sql.js')), file),
    })
  }
  if (!fs.existsSync(DB_PATH)) return null
  if (!db) db = new SQL.Database(fs.readFileSync(DB_PATH))
  return db
}

// Drop the cached snapshot so the next query re-reads the file from disk
// (call after a pipeline run writes new rows).
export function reload(): void {
  if (db) {
    db.close()
    db = null
  }
}

function rowsToObjects(d: Database, sql: string): Record<string, unknown>[] {
  const res = d.exec(sql)
  if (!res.length) return []
  const { columns, values } = res[0]
  return values.map((row) =>
    Object.fromEntries(row.map((v, i) => [columns[i], v])),
  )
}

export async function rowCounts(): Promise<{
  runs: number
  mcqs: number
  concept_maps: number
}> {
  const d = await ensure()
  if (!d) return { runs: 0, mcqs: 0, concept_maps: 0 }
  const count = (table: string): number => {
    const r = d.exec(`SELECT COUNT(*) FROM ${table}`)
    return r.length ? (r[0].values[0][0] as number) : 0
  }
  return { runs: count('runs'), mcqs: count('mcqs'), concept_maps: count('concept_maps') }
}

export async function recentRuns(limit = 15): Promise<Record<string, unknown>[]> {
  const d = await ensure()
  if (!d) return []
  const n = Math.max(1, Math.floor(Number(limit) || 15))
  return rowsToObjects(
    d,
    `SELECT run_id, generation_number, timestamp, input_file,
            generated_count, passed_count, cost_usd
       FROM runs
   ORDER BY timestamp DESC
      LIMIT ${n}`,
  )
}

export async function lastRun(): Promise<Record<string, unknown> | null> {
  const rows = await recentRuns(1)
  return rows[0] ?? null
}
