/**
 * Migration 0030 seeds the platform default model for every agent group, which
 * is what makes the DATABASE the thing that decides which model an org runs on.
 * Before it, `platform_model_defaults` was empty until an admin visited
 * Platform → Models, so resolution fell through to the workflow YAML and the
 * fleet silently ran a model nobody had declared anywhere.
 *
 * That defect cannot recur through a missing row — but it can recur through a
 * missing GROUP: adding an entry to `AGENT_GROUPS` without extending the seed
 * reintroduces exactly the same silent YAML fallthrough for the new group, and
 * nothing else in the suite would notice. So the seed is pinned against the
 * registry here.
 *
 * Deliberately a filesystem test with no database: the failure it catches is a
 * mismatch between two files, visible long before anything connects.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_GROUP_IDS, OPENROUTER_MODEL_ID_PATTERN } from '@/lib/model-config/agent-groups'
import { REASONING_MANDATORY_PREFIXES } from '@/lib/model-config/openrouter'

const REPO_ROOT = path.resolve(__dirname, '../../../..')
const MIGRATION = path.resolve(
  __dirname,
  '../../drizzle/0030_seed_platform_model_defaults.sql',
)
const WORKFLOW_CONFIG = path.join(REPO_ROOT, 'configs/config_oib_openrouter.yml')

const sql = fs.readFileSync(MIGRATION, 'utf8')

/** The `('intent'), ('clarifier'), …` tuple list of the seed's VALUES block. */
function seededGroups(): string[] {
  const values = sql.slice(sql.indexOf('VALUES'), sql.indexOf(') AS seed'))
  return [...values.matchAll(/\('([a-z_]+)'\)/g)].map((match) => match[1])
}

/** The single model id the seed writes for every group. */
function seededModel(): string {
  const match = sql.match(/^\s*'([^']+\/[^']+)',$/m)
  if (!match) throw new Error('could not find the seeded model id in migration 0030')
  return match[1]
}

describe('0030 platform model defaults seed', () => {
  it('seeds exactly the agent groups in the registry', () => {
    // Both directions matter: a missing group falls through to the YAML, and a
    // stale group is dropped at read time (`getPlatformModelDefaults`) so it
    // would sit in the table doing nothing.
    expect([...seededGroups()].sort()).toEqual([...AGENT_GROUP_IDS].sort())
  })

  it('seeds a well-formed OpenRouter model id', () => {
    expect(seededModel()).toMatch(OPENROUTER_MODEL_ID_PATTERN)
  })

  it('seeds a model the reasoning-off groups can actually use', () => {
    // `intent` runs `reasoning_effort: none`. A reasoning-mandatory model there
    // makes OpenRouter reject every intent call with HTTP 400 — the incident
    // `isReasoningSafeForOff` exists for. A seed reaches every tenant at once,
    // so it must clear that gate before it is ever written.
    const model = seededModel()
    expect(REASONING_MANDATORY_PREFIXES.some((prefix) => model.startsWith(prefix))).toBe(false)
  })

  it('only seeds an empty table', () => {
    // The guard is what makes the migration safe to run against a deployment
    // whose owner has already pinned defaults of their own.
    expect(sql).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "platform_model_defaults"\)/)
  })

  it('agrees with the workflow YAML boot floor', () => {
    // The YAML is the floor for processes with no BFF to ask. Two floors that
    // disagree mean a request served without a database resolves to a different
    // model than the same request served with one — the drift this whole change
    // exists to remove.
    const yaml = fs.readFileSync(WORKFLOW_CONFIG, 'utf8')
    const floors = [...yaml.matchAll(/model_name:\s*\$\{GRID_DEFAULT_MODEL:-([^}]+)\}/g)].map(
      (match) => match[1],
    )
    expect(floors.length).toBeGreaterThan(0)
    expect([...new Set(floors)]).toEqual([seededModel()])
  })
})
