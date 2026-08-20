/**
 * @vitest-environment node
 */

/**
 * The guard that makes the status vocabulary knowable.
 *
 * `documents.status` is an open `text` column with no CHECK, so nothing has
 * ever failed when a writer invented a value: the badge fell back to a neutral
 * chip, the poller's in-flight set silently disagreed with the badge's table by
 * two members, and migration 0063 added a twelfth value to a set nobody owned.
 * That is the "correlated substrate debt" failure `AGENTS.md` names — a shared
 * vocabulary with no owner and no test.
 *
 * This spec is the owner. It reads the WRITERS' own source and fails when one
 * of them emits a status that `document-status.ts` never declared, so the next
 * value costs one entry there instead of a grey badge nobody notices.
 *
 * What it deliberately does NOT assert: that the writers agree with each other.
 * They do not — `reconcile-status.ts` writes `completed`/`failed` while the
 * column's documentation says `processed`/`error` — and unifying them is a
 * migration over live rows, not this change.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { de } from '@/i18n/dictionaries/de'
import { en } from '@/i18n/dictionaries/en'
import { getByPath } from '@/i18n/translate'
import {
  DOCUMENT_STATUS_FACTS,
  IN_FLIGHT_DOCUMENT_STATUSES,
  KNOWN_DOCUMENT_STATUSES,
  documentStatusFacts,
  isKnownDocumentStatus,
} from './document-status'

/**
 * The modules that WRITE `documents.status` — the documents domain and the two
 * shelves that upload through their own services (Archiv, session documents).
 * Directories rather than a file list on purpose: a new writer in one of them
 * is caught the day it lands, which is the whole point of scanning at all.
 */
const WRITER_DIRS = ['src/lib/documents', 'src/lib/session-documents', 'src/lib/archiv']

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(path, found)
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) found.push(path)
  }
  return found
}

/**
 * Every status literal a writer commits to, as `status: 'x'` or as the union
 * `status: 'x' | 'y'` a service declares for its own return type. Both forms
 * are a promise about what may end up in the column.
 *
 * Comparisons (`file.status === 'success'`) are left out: they READ someone
 * else's vocabulary — the Python backend's job and file states — and pinning
 * those here would make this spec fail for a change on the other side of an
 * HTTP boundary that this column never sees.
 */
const EMITTED_RE = /\bstatus\??:\s*((?:'[a-z_]+'\s*\|\s*)*'[a-z_]+')/g

function emittedStatuses(): Map<string, string[]> {
  const byStatus = new Map<string, string[]>()
  for (const dir of WRITER_DIRS) {
    for (const file of sourceFiles(join(process.cwd(), dir))) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(EMITTED_RE)) {
        for (const literal of match[1].matchAll(/'([a-z_]+)'/g)) {
          const seen = byStatus.get(literal[1]) ?? []
          if (!seen.includes(file)) seen.push(file)
          byStatus.set(literal[1], seen)
        }
      }
    }
  }
  return byStatus
}

describe('every status a writer emits is declared', () => {
  const emitted = emittedStatuses()

  it('finds the writers at all', () => {
    // Half of the assertion below is that the scan found the real vocabulary
    // rather than nothing, which would pass an "everything is declared" check
    // for the wrong reason.
    expect([...emitted.keys()].sort()).toContain('pending')
    expect([...emitted.keys()].sort()).toContain('completed')
  })

  it('declares every one of them', () => {
    const undeclared = [...emitted.entries()]
      .filter(([status]) => !isKnownDocumentStatus(status))
      .map(([status, files]) => `${status}  (${files.join(', ')})`)
    expect(
      undeclared.sort(),
      'These statuses are written to documents.status but are not declared in ' +
        'src/lib/documents/document-status.ts, so the badge renders them grey ' +
        'and the poller ignores them. Add an entry with its variant and phase.',
    ).toEqual([])
  })
})

describe('the vocabulary is derived, not restated', () => {
  it('reconcile-status takes the in-flight set from the declaration', () => {
    // The poller's set was a literal, and it drifted from the badge's table by
    // two values without anything failing. Reading the source keeps that from
    // silently coming back — an import cannot be half-done.
    const source = readFileSync(join(process.cwd(), 'src/lib/documents/reconcile-status.ts'), 'utf8')
    expect(source).toContain("import { IN_FLIGHT_DOCUMENT_STATUSES } from './document-status'")
    expect(source).not.toMatch(/const IN_FLIGHT_STATUSES = new Set\(\[/)
  })

  it('the badge takes its variants and labels from the declaration', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/features/documents/components/document-status.tsx'),
      'utf8',
    )
    expect(source).toContain("from '@/lib/documents/document-status'")
    // The two `Record<string, …>` tables this replaced, by their old names.
    expect(source).not.toContain('const STATUS_VARIANT')
    expect(source).not.toContain('const STATUS_LABEL_KEY')
  })
})

describe('stored is terminal and neutral', () => {
  it('is never polled', () => {
    // No ingestion job was ever dispatched for an agent-authored report, so
    // nothing will ever report on it: a `stored` row in the in-flight set is a
    // spinner that never resolves, plus a backend call on every read.
    expect(IN_FLIGHT_DOCUMENT_STATUSES.has('stored')).toBe(false)
    expect(DOCUMENT_STATUS_FACTS.stored.phase).toBe('terminal')
  })

  it('is neither a success nor a failure', () => {
    // It must not read as either: the document is not in the knowledge base
    // (so not green — nothing can cite it) and nothing went wrong (so not red).
    expect(DOCUMENT_STATUS_FACTS.stored.variant).toBe('secondary')
  })

  it('leaves the states that ARE in flight alone', () => {
    expect([...IN_FLIGHT_DOCUMENT_STATUSES].sort()).toEqual([
      'ingesting',
      'pending',
      'processing',
      'uploading',
    ])
  })
})

describe('the declaration answers about values, not about prototypes', () => {
  it('does not mistake an Object.prototype key for a status', () => {
    // The lookup key comes from a text column, so `constructor` and `toString`
    // are values a row can hold. On a plain object they answer with something
    // truthy from the prototype, and every predicate downstream then reads
    // facts off a function.
    expect(documentStatusFacts('constructor')).toBeNull()
    expect(documentStatusFacts('toString')).toBeNull()
  })

  it('reads a status the way the column writes it', () => {
    expect(documentStatusFacts('READY')).toEqual(DOCUMENT_STATUS_FACTS.ready)
    expect(documentStatusFacts(null)).toBeNull()
    expect(documentStatusFacts('')).toBeNull()
  })
})

describe('every declared status has a label in both locales', () => {
  // `documentStatusLabel` calls `t(facts.labelKey)` with a value from the data
  // above, so the key never appears as a literal in a component and the
  // key-coverage scanner cannot see it. This is that check, for this table.
  it.each(KNOWN_DOCUMENT_STATUSES)('%s', (status) => {
    const key = DOCUMENT_STATUS_FACTS[status].labelKey
    expect(typeof getByPath(en.files, key), `en.files.${key}`).toBe('string')
    expect(typeof getByPath(de.files, key), `de.files.${key}`).toBe('string')
  })
})
