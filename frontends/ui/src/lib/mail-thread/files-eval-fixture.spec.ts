/**
 * @vitest-environment node
 */
/**
 * The office-file eval's E-Mail-Verlauf, written by the real renderer
 * (`tests/fixtures/files_eval/mail/`, ADR-0134, DECISION §10).
 *
 * The answer suite's `--set files` seeds this thread into the knowledge layer
 * through the real Markdown chunker (`scripts/turn_census/fixture_files.py`),
 * because message boundaries are what its rows test: a citation must land on
 * one message, a forged section must stay inside its real sender's section, a
 * quote must stay labelled by the message that kept it. Python cannot run this
 * renderer, so the bytes are pinned here, from the entries in
 * `parking-thread.json`, the way the filing job would make them:
 *
 * - `parking-thread.md`, the rendition (`renderMailThread`);
 * - `parking-thread.facts.json`, what the BFF sends `POST /v1/ingest` beside
 *   it (`mail_thread` for the Verlauf, `mail_origin` for each filed
 *   attachment), in the ingest contract's snake_case, from the filing job's
 *   own helpers (`./ingest-facts`).
 *
 * A change to the rendition's format fails here first;
 * `UPDATE_FIXTURES=1 bunx vitest run src/lib/mail-thread/files-eval-fixture.spec.ts`
 * rewrites both files, and the eval then seeds what production would write.
 * (Not `toMatchFileSnapshot`: vitest 5 never settles a file snapshot outside
 * its root, and the run hangs.)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkerReads } from '@/test-utils/markdown-chunker'
import { describe, expect, it } from 'vitest'
import { mailOriginIngestFacts, mailThreadIngestFacts } from './ingest-facts'
import { VERIFIED_SENDER_TRUSTS } from './mail-threading'
import { mailThreadEntryHeading, renderMailThread, type MailThreadRenderEntry } from './render'
import type { MailThreadRenderInput } from './render'

// frontends/ui/src/lib/mail-thread → repo root is five levels up.
const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '../../../../../tests/fixtures/files_eval/mail')

type FixtureEntry = Omit<MailThreadRenderEntry, 'heading' | 'sentAt' | 'receivedAt' | 'filedAt'> & {
  sentAt: string
  receivedAt: string
  filedAt: string
}
interface Fixture extends Omit<MailThreadRenderInput, 'entries'> {
  documentId: string
  entries: FixtureEntry[]
}

const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'parking-thread.json'), 'utf8')) as Fixture

/** The entries as the filing job inserts them: in filing order, each heading made against the ones before it. */
function entries(): MailThreadRenderEntry[] {
  const taken: string[] = []
  return [...fixture.entries]
    .sort((a, b) => Date.parse(a.filedAt) - Date.parse(b.filedAt))
    .map((raw) => {
      const fields = {
        ...raw,
        sentAt: new Date(raw.sentAt),
        receivedAt: new Date(raw.receivedAt),
        filedAt: new Date(raw.filedAt),
      }
      const heading = mailThreadEntryHeading(fields, taken, fixture.locale)
      taken.push(heading)
      return { ...fields, heading }
    })
}

/** Compare ``text`` with the fixture file, or write it there under ``UPDATE_FIXTURES=1``. */
function expectFixture(name: string, text: string) {
  const path = resolve(FIXTURE_DIR, name)
  if (process.env.UPDATE_FIXTURES === '1') writeFileSync(path, text, 'utf8')
  expect(readFileSync(path, 'utf8')).toBe(text)
}

/**
 * What `POST /v1/ingest` carries beside the rendition: the production helpers
 * (`./ingest-facts`), `mail_origins` keyed by the attachment's name. Every
 * named attachment of the fixture is a filed one.
 */
function ingestFacts(rows: readonly MailThreadRenderEntry[]) {
  const mailOrigins: Record<string, ReturnType<typeof mailOriginIngestFacts>> = {}
  for (const row of rows) {
    for (const attachment of row.attachments) {
      if (!attachment.name) continue
      mailOrigins[attachment.name] = mailOriginIngestFacts(row, { threadDocumentId: fixture.documentId, locale: fixture.locale })
    }
  }
  return { mail_thread: mailThreadIngestFacts(rows, fixture.locale), mail_origins: mailOrigins }
}

describe('the files eval mail thread', () => {
  const rows = entries()
  const { markdown } = renderMailThread({ ...fixture, entries: rows })

  it('is the bytes the renderer writes', () => {
    expectFixture('parking-thread.md', markdown)
  })

  it('travels with the facts the BFF would send to ingest', () => {
    expectFixture('parking-thread.facts.json', `${JSON.stringify(ingestFacts(rows), null, 2)}\n`)
  })

  it('gives the chunker one section per message, and the forged heading none', () => {
    const sections = chunkerReads(markdown).headings.filter((line) => line.startsWith('## '))
    expect(sections).toHaveLength(rows.length)
    expect(new Set(sections)).toEqual(new Set(rows.map((row) => `## ${row.heading}`)))
    expect(sections.some((line) => line.startsWith('## 14.05.2026 09:00'))).toBe(false)
  })

  it('names the Behörde only where a signature confirmed it', () => {
    for (const row of rows) {
      const verified = VERIFIED_SENDER_TRUSTS.includes(row.senderTrust) && row.signerDomain
      expect(row.heading.includes('Domain nicht bestätigt') || row.heading.includes('aus dem Outlook-Archiv')).toBe(
        !verified
      )
    }
    expect(markdown).not.toMatch(/@/)
  })
})
