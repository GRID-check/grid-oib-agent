/**
 * The ingest priority the BFF sends, pinned to the one the backend accepts.
 *
 * The reindex and rescan jobs send `priority: "bulk"` on `POST /v1/ingest`
 * (ADR-0079); `IngestRequest.priority` in the backend is a `Literal`, so a value
 * it does not list is a 422 and the whole reindex fails. The two sides were
 * written in separate changes, so the list is read out of the request model
 * rather than restated: this spec fails when someone edits either side alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INGEST_PRIORITIES } from './service'

/** Repo root, from this spec's own location. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..')
const REQUESTS = join(REPO_ROOT, 'frontends', 'aiq_api', 'src', 'aiq_api', 'models', 'requests.py')

const backendPriorities = (): string[] => {
  const source = readFileSync(REQUESTS, 'utf8')
  const literal = /priority:\s*Literal\[([^\]]*)\]/.exec(source)
  expect(literal, 'IngestRequest.priority Literal not found in requests.py').not.toBeNull()
  return Array.from(literal![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]!)
}

describe('ingest priority contract', () => {
  it('sends exactly the priorities POST /v1/ingest accepts', () => {
    expect([...INGEST_PRIORITIES].sort()).toEqual(backendPriorities().sort())
  })
})
