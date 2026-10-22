/**
 * The document type a filing chose, pinned across the BFF ↔ backend seam.
 *
 * `ShelfUploadInput.documentType` reaches the ingest job in four hops, each
 * written in another file and two languages: `dispatchIngest` sends
 * `document_type`, `IngestRequest` accepts it and refuses anything outside the
 * vocabulary, `_job_config` copies it into the job config, and the ingest job
 * reads it there and stores it as the person's type tag
 * (`_chosen_document_type`, `_keep_chosen_document_type`). A typo on any hop is
 * silent: the field is optional everywhere, so the classifier simply decides,
 * which looks like a working upload. So the key and the vocabulary are read out
 * of the Python sources rather than restated, and this spec fails when someone
 * edits one side alone.
 *
 * The behaviour of each hop has its own test: `dispatch.spec.ts` (the body),
 * `frontends/aiq_api/tests/test_ingest_document_type.py` (the route) and
 * `tests/knowledge_layer_tests/test_upload_document_type.py` (the job).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_TYPE_TAGS } from './tag-vocabulary'

/** Repo root, from this spec's own location. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..')
const read = (...path: string[]): string => readFileSync(join(REPO_ROOT, ...path), 'utf8')

const SERVICE = read('frontends', 'ui', 'src', 'lib', 'documents', 'service.ts')
const REQUESTS = read('frontends', 'aiq_api', 'src', 'aiq_api', 'models', 'requests.py')
const ROUTE = read('frontends', 'aiq_api', 'src', 'aiq_api', 'routes', 'ingest.py')
const ADAPTER = read('sources', 'knowledge_layer', 'src', 'llamaindex', 'adapter.py')
const VOCABULARY = read('src', 'aiq_agent', 'knowledge', 'document_classification.py')

/** The wire key the BFF writes the chosen type under. */
const sentKey = (): string => {
  const sent = /\{\s*(\w+):\s*extras\.documentType\s*\}/.exec(SERVICE)
  expect(sent, 'dispatchIngest no longer sends extras.documentType').not.toBeNull()
  return sent![1]!
}

/** The body of `class IngestRequest`, up to the next top-level definition. */
const ingestRequest = (): string => {
  const body = /^class IngestRequest\(BaseModel\):\n([\s\S]*?)(?=^\S)/m.exec(REQUESTS)
  expect(body, 'class IngestRequest not found in requests.py').not.toBeNull()
  return body![1]!
}

describe('ingest document type contract', () => {
  it('sends the key IngestRequest declares', () => {
    expect(ingestRequest()).toMatch(new RegExp(`^\\s{4}${sentKey()}: str \\| None = Field\\(`, 'm'))
  })

  it('has the backend refuse a type outside the vocabulary the BFF types the field with', () => {
    const validator = new RegExp(
      `@field_validator\\("${sentKey()}"\\)[\\s\\S]*?DOCUMENT_TYPE_TAGS[\\s\\S]*?raise ValueError`,
    )
    expect(ingestRequest()).toMatch(validator)

    // The vocabulary itself, read from the tuple the validator imports: the
    // TypeScript type of the field is this list, so a type the BFF may send is
    // one the backend accepts. `tests/test_tag_vocabulary_parity.py` is the
    // Python side of the same pin.
    const tuple = /^DOCUMENT_TYPE_TAGS: tuple\[str, \.\.\.\] = \(([\s\S]*?)^\)/m.exec(VOCABULARY)
    expect(tuple, 'DOCUMENT_TYPE_TAGS not found in document_classification.py').not.toBeNull()
    const backend = Array.from(tuple![1]!.matchAll(/"([^"]+)"/g), (match) => match[1])
    expect([...DOCUMENT_TYPE_TAGS]).toEqual(backend)
  })

  it('carries the key from the request into the job config the ingest job reads', () => {
    const key = sentKey()
    expect(ROUTE).toContain(`config["${key}"] = request.${key}`)
    expect(ADAPTER).toContain(`config.get("${key}")`)
  })
})
