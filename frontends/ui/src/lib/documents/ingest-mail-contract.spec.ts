/**
 * @vitest-environment node
 */
/**
 * A filed mail's two ingest records, pinned across the BFF ↔ backend seam
 * (ADR-0134): `mail_thread` on a Fassung of an E-Mail-Verlauf, `mail_origin`
 * on an attachment filed with a message (`lib/mail-thread/ingest-facts`).
 *
 * Both Python models are `extra="forbid"`, so a key the BFF spells differently
 * is not a quiet loss but a 422 on every filed mail, and an absent record is a
 * Verlauf indexed as an ordinary document or an attachment that forgot its
 * mail: also quiet. So the wire names are read out of the Python sources rather
 * than restated, as `ingest-document-type-contract.spec.ts` does for
 * `document_type`, and this spec fails when one side is edited alone. The
 * behaviour of the backend's half is `frontends/aiq_api/tests/test_ingest_mail.py`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  mailOriginIngestFactsSchema,
  mailThreadIngestFactsSchema,
} from '@/lib/mail-thread/ingest-facts'
import { SENDER_TRUSTS } from '@/lib/inbound-mail/inbound-mail-vocabulary'
import { MAIL_THREAD_LOCALES } from '@/lib/mail-thread/mail-thread-vocabulary'

/** Repo root, from this spec's own location. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..')
const read = (...path: string[]): string => readFileSync(join(REPO_ROOT, ...path), 'utf8')

const SERVICE = read('frontends', 'ui', 'src', 'lib', 'documents', 'service.ts')
const REQUESTS = read('frontends', 'aiq_api', 'src', 'aiq_api', 'models', 'requests.py')

/** The body of a top-level Python class, up to the next top-level definition. */
const pythonClass = (name: string): string => {
  const body = new RegExp(`^class ${name}\\(BaseModel\\):\\n([\\s\\S]*?)(?=^\\S)`, 'm').exec(
    REQUESTS
  )
  expect(body, `class ${name} not found in requests.py`).not.toBeNull()
  return body![1]!
}

/** The field names a Pydantic model declares, in order. */
const fieldsOf = (name: string): string[] =>
  [...pythonClass(name).matchAll(/^ {4}([a-z_]+): /gm)]
    .map((match) => match[1]!)
    .filter((field) => field !== 'model_config')

/** The values of a `Literal[...]` alias in requests.py. */
const literal = (alias: string): string[] => {
  const found = new RegExp(`^${alias} = Literal\\[([^\\]]+)\\]`, 'm').exec(REQUESTS)
  expect(found, `${alias} not found in requests.py`).not.toBeNull()
  return [...found![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

/** The wire key `dispatchIngest` writes `extras.<field>` under. */
const sentKey = (field: string): string => {
  const sent = new RegExp(`\\{\\s*(\\w+):\\s*extras\\.${field}\\s*\\}`).exec(SERVICE)
  expect(sent, `dispatchIngest no longer sends extras.${field}`).not.toBeNull()
  return sent![1]!
}

describe('ingest mail contract', () => {
  it('sends each record under the key IngestRequest declares for it', () => {
    const request = pythonClass('IngestRequest')
    expect(request).toMatch(
      new RegExp(`^ {4}${sentKey('mailThread')}: MailThreadFacts \\| None = Field\\(`, 'm')
    )
    expect(request).toMatch(
      new RegExp(`^ {4}${sentKey('mailOrigin')}: MailOrigin \\| None = Field\\(`, 'm')
    )
  })

  it('writes exactly the fields each forbid-extra model declares', () => {
    expect(pythonClass('MailThreadFacts')).toMatch(/extra="forbid"/)
    expect(pythonClass('MailOrigin')).toMatch(/extra="forbid"/)
    expect(Object.keys(mailThreadIngestFactsSchema.shape).sort()).toEqual(
      fieldsOf('MailThreadFacts').sort()
    )
    expect(Object.keys(mailOriginIngestFactsSchema.shape).sort()).toEqual(
      fieldsOf('MailOrigin').sort()
    )
  })

  it('names the trusts and locales the backend accepts, and no other', () => {
    expect([...SENDER_TRUSTS].sort()).toEqual(literal('SenderTrust').sort())
    expect([...MAIL_THREAD_LOCALES].sort()).toEqual(literal('MailLocale').sort())
  })

  it('never sends both records on one document, which the backend refuses', () => {
    expect(pythonClass('IngestRequest')).toMatch(
      /mail_thread is not None and self\.mail_origin is not None/
    )
    expect(SERVICE).toMatch(/extras\.mailOrigin && !extras\.mailThread/)
  })
})
