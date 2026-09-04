/**
 * The in-app RIS reader's host promise, pinned to the backend's enforcement.
 *
 * `isRisUrl` decides whether a citation chip OFFERS the in-app reader;
 * `ALLOWED_DOCUMENT_HOSTS` in `sources/ris_adapter/src/client.py` decides
 * whether the fetch behind it succeeds. If the first is ever wider than the
 * second, a chip promises a viewer and delivers a 404 — worse than the
 * outbound link it replaced, because the reader has already committed a click.
 *
 * So the promise is read out of the enforcing file rather than restated: this
 * spec fails when someone edits either side alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRisUrl } from './target'

/** Repo root, from this spec's own location. */
const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', '..')
const CLIENT = join(REPO_ROOT, 'sources', 'ris_adapter', 'src', 'client.py')

const backendHosts = (): string[] => {
  const source = readFileSync(CLIENT, 'utf8')
  const block = /ALLOWED_DOCUMENT_HOSTS\s*=\s*frozenset\(\s*\{([^}]*)\}/.exec(source)
  expect(block, 'ALLOWED_DOCUMENT_HOSTS not found in the RIS client').not.toBeNull()
  return Array.from(block![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]!)
}

describe('RIS reader host contract', () => {
  it('offers the reader for exactly the hosts the backend will fetch', () => {
    const hosts = backendHosts()
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) {
      expect(isRisUrl(`https://${host}/Dokumente/Bundesnormen/NOR40217157/NOR40217157.html`)).toBe(
        true
      )
    }
  })

  it('refuses anything else, however RIS-shaped', () => {
    expect(isRisUrl('https://ris.bka.gv.at.evil.example/Dokument.wxe')).toBe(false)
    expect(isRisUrl('https://example.org/ris.bka.gv.at')).toBe(false)
    // Plain HTTP is refused on both sides — the backend client requires https.
    expect(isRisUrl('http://www.ris.bka.gv.at/Dokument.wxe')).toBe(false)
    expect(isRisUrl(undefined)).toBe(false)
    expect(isRisUrl('not a url')).toBe(false)
  })
})
