/**
 * @vitest-environment node
 */
/**
 * The `piloti/` filename namespace (ADR-0054 § Indexing).
 *
 * Two properties, and only the second is about strings. The first is the reason
 * the namespace exists at all: a name inside it cannot be produced by any of the
 * three upload shelves, because no browser hands over a filename containing a
 * slash. That makes "a published Piloti document cannot collide with a human
 * upload" a structural fact rather than a probability, and migration 0083's
 * unique index is the same claim held by the database.
 */
import { describe, expect, it } from 'vitest'

import {
  AGENT_DOCUMENT_NAMESPACE,
  agentDocumentFilename,
  isAgentDocumentFilename,
} from './agent-namespace'

describe('agentDocumentFilename', () => {
  it('puts the document id between the prefix and the name', () => {
    expect(agentDocumentFilename('doc_1', 'aktenvermerk-2026-09-01.md')).toBe(
      'piloti/doc_1/aktenvermerk-2026-09-01.md',
    )
  })

  it('keeps two documents apart when the model writes one title twice', () => {
    // `generatedFilename` is deterministic — slug plus date plus extension — so
    // two Aktenvermerke written on one day are one string. The id is what makes
    // them two names, and it is what the unique index in 0083 keys on.
    const first = agentDocumentFilename('doc_1', 'aktenvermerk-2026-09-01.md')
    const second = agentDocumentFilename('doc_2', 'aktenvermerk-2026-09-01.md')
    expect(first).not.toBe(second)
  })

  it('produces a name the SQL predicate matches', () => {
    // `WHERE filename LIKE 'piloti/%'` in migration 0083 and this constant are
    // the same rule written twice, in two languages. A capital letter here
    // would make them disagree silently.
    expect(agentDocumentFilename('doc_1', 'x.md').startsWith('piloti/')).toBe(true)
    expect(AGENT_DOCUMENT_NAMESPACE).toBe('piloti/')
  })
})

describe('isAgentDocumentFilename', () => {
  it('accepts what the builder produces', () => {
    expect(isAgentDocumentFilename(agentDocumentFilename('doc_1', 'a.md'))).toBe(true)
  })

  it('rejects a name that merely mentions piloti', () => {
    // A person can type any of these. The prefix is a path segment, and a
    // substring test would hand every one of them the addressability that
    // belongs to a published Piloti document.
    for (const name of ['piloti-bericht.md', 'x/piloti/doc_1/a.md', 'Piloti/doc_1/a.md', 'apiloti/a.md']) {
      expect(isAgentDocumentFilename(name), name).toBe(false)
    }
  })

  it('rejects the names a person’s upload actually carries', () => {
    for (const name of ['plan.pdf', 'Brandschutz Gutachten.docx', 'aktenvermerk-2026-09-01.md']) {
      expect(isAgentDocumentFilename(name), name).toBe(false)
    }
  })
})
