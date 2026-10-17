/**
 * @vitest-environment node
 */
/**
 * The index a document's wakes are read by (migration 0148), written in three
 * places that nothing else makes agree: the drizzle table, the migration, and
 * the journal that decides whether the migration runs at all.
 *
 * `listLatestWakes` and `listAnsweringWakes` filter `piloti_wakes` by the
 * document. Without an index that leads with `document_id` each read scans the
 * organization's wakes, which is the cost this pins away.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig, IndexedColumn } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { pilotiWakes } from './document-annotations'

const NAME = 'idx_piloti_wakes_document_annotation_created'
const read = (file: string) => readFileSync(join(process.cwd(), 'drizzle', file), 'utf8')

describe('the index of a document’s wakes (migration 0148)', () => {
  it('is declared on the table: the document, then the mark, newest wake first', () => {
    const index = getTableConfig(pilotiWakes).indexes.find((entry) => entry.config.name === NAME)
    expect(index, `piloti_wakes declares no ${NAME}`).toBeDefined()
    const columns = (index?.config.columns ?? []).map((column) =>
      column instanceof IndexedColumn ? `${column.name} ${column.indexConfig?.order ?? 'asc'}` : 'expression'
    )
    expect(columns).toEqual(['document_id asc', 'annotation_id asc', 'created_at desc'])
  })

  it('is built by the migration with the same columns, and the journal runs it', () => {
    expect(read('0148_piloti_wakes_document_idx.sql')).toMatch(
      new RegExp(`CREATE INDEX IF NOT EXISTS "${NAME}"\\s+ON "piloti_wakes" \\("document_id", "annotation_id", "created_at" DESC\\)`)
    )
    const journal = JSON.parse(read('meta/_journal.json')) as { entries: Array<{ tag: string }> }
    expect(journal.entries.map((entry) => entry.tag)).toContain('0148_piloti_wakes_document_idx')
  })

  it('is dropped on the way down', () => {
    expect(read('0148_piloti_wakes_document_idx.down.sql')).toContain(`DROP INDEX IF EXISTS "${NAME}"`)
  })
})
