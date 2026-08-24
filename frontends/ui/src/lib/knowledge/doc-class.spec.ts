/**
 * @vitest-environment node
 */
/**
 * Parity guard: the frontend Dokumentart vocabulary must match the backend enum.
 *
 * The canonical doc_class vocabulary lives in the Python backend
 * (`src/aiq_agent/knowledge/document_classification.py` — `DOCUMENT_CLASS_LABELS`,
 * whose ordered keys are `DOCUMENT_CLASSES`). The base-knowledge admin UI keeps a
 * hand-written TypeScript mirror (`doc-class.ts`) to render its dropdown + badge.
 * This test reads the Python file at test time and fails if the two ever drift —
 * so the backend stays the single source of truth and a stale TS copy is caught
 * in CI (mirrors `tests/test_tag_vocabulary_parity.py`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_DOC_CLASS,
  DOC_CLASSES,
  DOC_CLASS_LABELS,
  docClassAuthority,
  docClassSignal,
  isOibBinding,
} from './doc-class'

// frontends/ui/src/lib/knowledge → repo root is four levels up from src/.
const HERE = dirname(fileURLToPath(import.meta.url))
const BACKEND_SOURCE = resolve(
  HERE,
  '../../../../../src/aiq_agent/knowledge/document_classification.py',
)

/** Pull the ordered keys out of the Python `DOCUMENT_CLASS_LABELS` dict block. */
function backendDocClassKeys(): string[] {
  const source = readFileSync(BACKEND_SOURCE, 'utf-8')
  const block = source.match(/DOCUMENT_CLASS_LABELS: dict\[str, str\] = \{([\s\S]*?)\}/)
  expect(block, `DOCUMENT_CLASS_LABELS not found in ${BACKEND_SOURCE}`).toBeTruthy()
  return [...block![1].matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1])
}

/** Pull the ordered keys out of the Python `DOCUMENT_CLASS_LABELS` values. */
function backendDocClassLabels(): Record<string, string> {
  const source = readFileSync(BACKEND_SOURCE, 'utf-8')
  const block = source.match(/DOCUMENT_CLASS_LABELS: dict\[str, str\] = \{([\s\S]*?)\}/)!
  const out: Record<string, string> = {}
  for (const m of block[1].matchAll(/^\s*"([^"]+)":\s*"([^"]+)",/gm)) {
    out[m[1]] = m[2]
  }
  return out
}

describe('doc-class vocabulary parity', () => {
  test('key list + order match backend DOCUMENT_CLASSES', () => {
    expect([...DOC_CLASSES]).toEqual(backendDocClassKeys())
  })

  test('German labels match backend DOCUMENT_CLASS_LABELS', () => {
    expect(DOC_CLASS_LABELS).toEqual(backendDocClassLabels())
  })

  test('DEFAULT_DOC_CLASS matches backend DEFAULT_DOC_CLASS', () => {
    const source = readFileSync(BACKEND_SOURCE, 'utf-8')
    const match = source.match(/DEFAULT_DOC_CLASS = "([^"]+)"/)
    expect(DEFAULT_DOC_CLASS).toBe(match?.[1])
  })
})

describe('doc-class badge derivation', () => {
  test('every base class tints in the law family', () => {
    for (const dc of DOC_CLASSES) {
      expect(docClassSignal(dc)).toBe('law')
    }
  })

  test('authority tag matches the OIB / RIS / ÖNORM rung', () => {
    expect(docClassAuthority('oib_richtlinie')).toBe('OIB')
    expect(docClassAuthority('oib_begriffe')).toBe('OIB')
    expect(docClassAuthority('norm_extern')).toBe('ÖNORM')
    expect(docClassAuthority('gesetz')).toBe('RIS')
  })

  test('isOibBinding is true exactly for the oib_* classes', () => {
    for (const dc of DOC_CLASSES) {
      expect(isOibBinding(dc)).toBe(dc.startsWith('oib_'))
    }
  })

  test('unknown / null values resolve to the neutral default', () => {
    expect(docClassSignal(null)).toBe('law')
    expect(isOibBinding('nonsense')).toBe(false)
  })
})
