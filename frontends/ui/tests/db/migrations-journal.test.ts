/**
 * `drizzle/meta/_journal.json` is the list `drizzle-kit migrate` actually
 * executes — the `.sql` files on disk are inert without an entry pointing at
 * them. That asymmetry is silent in every check we run: the migration is in the
 * diff, review sees it, `fe:build` and `fe:test` pass, and the deploy's migrate
 * step reports success having skipped the file entirely. The table simply never
 * exists, and the first symptom is a 500 from the route that queries it
 * (issue #283: `relation "platform_retrieval_settings" does not exist`, from a
 * migration merged one commit earlier).
 *
 * So the journal is pinned here instead of trusted: every forward migration
 * file has an entry, every entry has a file, and the two agree on order. This
 * is deliberately a filesystem test with no database — the failure it exists to
 * catch is a bookkeeping mismatch, visible long before anything connects.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DRIZZLE_DIR = path.resolve(__dirname, '../../drizzle')

interface JournalEntry {
  idx: number
  tag: string
  when: number
}

const journal: { entries: JournalEntry[] } = JSON.parse(
  fs.readFileSync(path.join(DRIZZLE_DIR, 'meta/_journal.json'), 'utf8'),
)

/**
 * Forward migrations only. A `*.down.sql` is the hand-run rollback companion
 * (`0019_org_archiv.down.sql` and friends) — drizzle never applies those, so
 * they must NOT appear in the journal.
 */
const migrationFiles = fs
  .readdirSync(DRIZZLE_DIR)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort()

describe('drizzle migration journal', () => {
  it('has an entry for every forward migration file', () => {
    const journalled = new Set(journal.entries.map((entry) => entry.tag))
    const unapplied = migrationFiles.filter((tag) => !journalled.has(tag))
    // Naming the files makes the fix obvious: add them to meta/_journal.json.
    expect(unapplied).toEqual([])
  })

  it('has a migration file for every entry', () => {
    const onDisk = new Set(migrationFiles)
    const dangling = journal.entries.map((entry) => entry.tag).filter((tag) => !onDisk.has(tag))
    expect(dangling).toEqual([])
  })

  it('orders entries by idx, matching the numeric file prefix', () => {
    const indexes = journal.entries.map((entry) => entry.idx)
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
    for (const entry of journal.entries) {
      expect(entry.tag.startsWith(String(entry.idx).padStart(4, '0'))).toBe(true)
    }
  })

  /**
   * `when` — not the hash, not `idx` — is what drizzle compares to decide
   * whether a migration has already run:
   *
   *   if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
   *
   * against `select … order by created_at desc limit 1`. So an entry whose
   * `when` is less than OR EQUAL TO an already-applied one is skipped — and
   * skipped SILENTLY, with `migrate()` reporting success. This repo stamps
   * hand-picked round midnight-UTC values rather than `drizzle-kit generate`'s
   * `Date.now()`, which makes an exact collision between two migrations authored
   * the same day not just possible but likely. Verified: two entries sharing a
   * `when` leave the second's table uncreated; +1 ms applies it.
   *
   * This is the same failure class as issue #283 (a migration in the diff that
   * never runs) on the axis the tests above do not cover.
   */
  it('has strictly increasing, unique `when` timestamps', () => {
    const whens = journal.entries.map((entry) => entry.when)
    const duplicated = whens.filter((value, index) => whens.indexOf(value) !== index)
    expect(duplicated).toEqual([])
    expect(whens).toEqual([...whens].sort((a, b) => a - b))
  })
})
