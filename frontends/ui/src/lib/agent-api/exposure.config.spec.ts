/**
 * @vitest-environment node
 */
/**
 * `exposure.config.ts` is the one file that decides who sees each capability
 * (ADR-0122, amendment of 2026-10-21). These cases hold it whole and coherent:
 * an entry for every operation and nothing else, a reason wherever an entry is
 * not plainly offered, the platform domain on the platform door only, and no
 * entry that offers Piloti what Piloti may never propose.
 *
 * The config is also written as JSON, `tests/fixtures/exposure.json`, for the
 * docs and for Python (`tests/aiq_agent/tools/test_exposure_config.py` checks
 * every `native:<tool>` against Piloti's tool list in
 * `configs/config_oib_openrouter.yml`). A changed entry fails here until the
 * fixture is regenerated:
 *
 *   UPDATE_FIXTURES=1 bunx vitest run src/lib/agent-api/exposure.config.spec.ts
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { PILOTI_ASK_OPERATIONS } from '@/lib/piloti-asks/ask-wire'
import { PROPOSAL_DECISION_OPERATIONS } from '@/lib/proposals/operation-applier'
import { BACKEND_OPERATIONS } from './backend-operations'
import { AGENT_OPERATIONS } from './catalog'
import { EXPOSURE, type Exposure, WITHHELD_CATEGORIES } from './exposure.config'

const FIXTURE = join(process.cwd(), 'tests/fixtures/exposure.json')
const NATIVE = /^native:[a-z][a-z0-9_]*$/

const entries = EXPOSURE as Readonly<Record<string, Exposure>>
const entry = (name: string): Exposure => entries[name] as Exposure
const plainlyOffered = (exposure: Exposure): boolean => exposure.external && exposure.piloti === true

describe('the exposure config', () => {
  it('has an entry for every operation and the read tools, and for nothing else (no silent default)', () => {
    const names = [...AGENT_OPERATIONS.map((op) => op.name), ...BACKEND_OPERATIONS.map((op) => op.name)]
    expect(names.filter((name) => !Object.hasOwn(entries, name)), 'give each an entry in exposure.config.ts').toEqual([])
    expect(Object.keys(entries).filter((name) => !names.includes(name)), 'no operation has this name').toEqual([])
  })

  it('withholds from everyone, with a category and a reason', () => {
    for (const [name, exposure] of Object.entries(entries)) {
      if (!exposure.withheld) continue
      expect(WITHHELD_CATEGORIES, name).toContain(exposure.withheld.category)
      expect(exposure.withheld.reason.length, name).toBeGreaterThan(30)
      expect({ external: exposure.external, piloti: exposure.piloti, platform: exposure.platform }, name).toEqual({
        external: false,
        piloti: false,
        platform: undefined,
      })
    }
  })

  it('says why wherever an entry is not plainly offered to an outside agent and to Piloti', () => {
    const silent = Object.entries(entries)
      .filter(([, exposure]) => !plainlyOffered(exposure) && !exposure.withheld)
      .filter(([, exposure]) => (exposure.reason ?? '').length < 20)
      .map(([name]) => name)
    expect(silent, 'give the entry a `reason`').toEqual([])
  })

  it('offers the platform domain on the platform door, and only there', () => {
    for (const op of AGENT_OPERATIONS) {
      const exposure = entry(op.name)
      if (exposure.withheld) continue
      expect(exposure.platform === true, op.name).toBe(op.domain === 'platform')
      if (op.domain === 'platform') expect([exposure.external, exposure.piloti], op.name).toEqual([false, false])
    }
    for (const op of BACKEND_OPERATIONS) expect(entry(op.name).platform, op.name).toBeUndefined()
  })

  it('never offers Piloti what it may not propose: a sensitive operation, an ask, a decision on a proposal', () => {
    for (const op of AGENT_OPERATIONS) {
      if (op.sensitivity && !entry(op.name).withheld) expect(entry(op.name).piloti, op.name).toBe(false)
    }
    for (const name of [...PILOTI_ASK_OPERATIONS, ...PROPOSAL_DECISION_OPERATIONS]) {
      expect(entry(name).piloti, name).toBe(false)
    }
  })

  it('keeps a held mail’s text and bytes from Piloti, and evidence off every door (ADR-0134, D22)', () => {
    // Piloti reads a mail once a person filed it; before, metadata only (RT-S6).
    for (const name of ['inbound-mail-text-get', 'inbound-mail-part-content-get']) expect(entry(name).piloti, name).toBe(false)
    // The original `.eml` is proof: no model reads it, whoever asks (ADR-0122, amendment "evidence is on no door").
    const evidence = Object.entries(entries).filter(([, exposure]) => exposure.withheld?.category === 'evidence').map(([name]) => name)
    expect(evidence).toContain('inbound-mail-original-get')
    for (const op of AGENT_OPERATIONS.filter((candidate) => /\/original$/.test(candidate.path))) {
      expect(entry(op.name).withheld?.category, op.name).toBe('evidence')
    }
  })

  it('lets the person decide held mail: filing and dismissing run for an outside agent only on their yes', () => {
    for (const name of ['inbound-mail-file', 'inbound-mail-dismiss']) {
      expect(AGENT_OPERATIONS.find((op) => op.name === name)?.requiresPersonConfirmation, name).toBeDefined()
    }
  })

  it('names a native tool by its bound name, and gives each read tool its own', () => {
    for (const [name, exposure] of Object.entries(entries)) {
      if (typeof exposure.piloti === 'string') expect(exposure.piloti, name).toMatch(NATIVE)
    }
    for (const op of BACKEND_OPERATIONS) expect(entry(op.name).piloti, op.name).toBe(`native:${op.tool}`)
  })

  it('is what tests/fixtures/exposure.json says (UPDATE_FIXTURES=1 rewrites it)', () => {
    const rendered = render()
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, rendered)
    expect(readFileSync(FIXTURE, 'utf8')).toBe(rendered)
  })
})

/** The config as JSON, one row per operation with what a reader needs beside it: kind, domain, sensitivity. */
function render(): string {
  const row = (name: string, kind: 'catalog' | 'backend', domain: string, sensitivity: string | null) => {
    const exposure = entry(name)
    return [
      name,
      {
        kind,
        domain,
        sensitivity,
        external: exposure.external,
        piloti: exposure.piloti,
        platform: exposure.platform === true,
        withheld: exposure.withheld ?? null,
        reason: exposure.reason ?? null,
      },
    ] as const
  }
  const operations = Object.fromEntries([
    ...AGENT_OPERATIONS.map((op) => row(op.name, 'catalog', op.domain, op.sensitivity ?? null)),
    ...BACKEND_OPERATIONS.map((op) => row(op.name, 'backend', op.domain, null)),
  ])
  const fixture = {
    comment:
      'Who sees each capability: frontends/ui/src/lib/agent-api/exposure.config.ts, written by exposure.config.spec.ts ' +
      '(UPDATE_FIXTURES=1). `piloti` is true, false or "native:<tool>" (Piloti uses that tool; the door hides the operation from it).',
    operations,
  }
  return `${JSON.stringify(fixture, null, 1)}\n`
}
