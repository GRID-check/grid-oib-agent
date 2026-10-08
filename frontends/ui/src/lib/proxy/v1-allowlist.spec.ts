/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { isForwardableV1Request } from './v1-allowlist'

describe('isForwardableV1Request', () => {
  it.each([
    ['GET', ['data_sources']],
    ['GET', ['documents', 'job-1', 'status']],
    ['POST', ['collections']],
    ['GET', ['collections', 's_abc']],
    ['GET', ['collections', 's_abc', 'documents']],
    ['get', ['data_sources']],
  ])('forwards %s %j, which a product client makes', (method, path) => {
    expect(isForwardableV1Request(method, path)).toBe(true)
  })

  it.each([
    ['POST', ['chat', 'completions']],
    ['POST', ['chat', 'stream']],
    ['POST', ['workflow']],
    ['POST', ['generate']],
    ['POST', ['jobs', 'async', 'submit']],
    ['GET', ['jobs', 'async', 'job', 'j1']],
    // The run listing goes through the job proxy, which signs its project.
    ['GET', ['jobs', 'async', 'jobs']],
    ['GET', ['admin', 'oib', 'sync']],
    ['POST', ['maintenance', 'purge-project-resources']],
    ['GET', ['collections']],
    // A chat's attachments go through `/api/session/documents`, and no shelf
    // takes a raw upload or loses its whole collection from a browser.
    ['POST', ['collections', 's_abc', 'documents']],
    ['POST', ['collections', 'proj_abc', 'documents']],
    ['DELETE', ['collections', 's_abc']],
    // The chunk-only file delete, which a document-id caller turned into a
    // no-op that left the row and the object behind.
    ['DELETE', ['collections', 'proj_abc', 'documents']],
    ['POST', ['collections', 's_abc', 'search']],
    ['GET', ['documents', 'job-1']],
    ['GET', ['documents', '', 'status']],
    ['PATCH', ['collections', 's_abc', 'folder-paths']],
    ['GET', []],
  ])('refuses %s %j', (method, path) => {
    expect(isForwardableV1Request(method, path)).toBe(false)
  })
})
