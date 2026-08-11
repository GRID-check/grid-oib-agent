/**
 * @vitest-environment node
 *
 * CI guard for the GENERATED platform-skills module: running the sync script in
 * --check mode must pass, or the generated module is stale. A skill file change
 * (builtin skill markdown under src/aiq_agent/skills) therefore fails the build
 * until `node scripts/sync-platform-skills.mjs` has been re-run (same shape as
 * the other generated-asset guards, e.g. scripts/generate-card-schemas.mjs).
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPlatformSkills } from './platform-skills'
import { KNOWN_SKILL_AGENTS, METADATA_AGENTS } from './types'

const here = dirname(fileURLToPath(import.meta.url))
// src/lib/skills -> src/lib -> src -> frontends/ui
const uiRoot = join(here, '..', '..', '..')
const script = join(uiRoot, 'scripts', 'sync-platform-skills.mjs')

describe('sync-platform-skills --check', () => {
  it('reports the generated module as up-to-date', () => {
    let output = ''
    try {
      output = execFileSync('node', [script, '--check'], { cwd: uiRoot, encoding: 'utf8' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect.fail(`platform skills are stale: ${message}`)
    }
    expect(output).toContain('ok')
  })
})

/**
 * The shipped builtins are DeepAgents subagent skills: their instructions call
 * `execute` and write `/shared/`, neither of which exists in a chat turn.
 *
 * `grid-agents: deep_researcher` is now the ONLY thing keeping them out of the
 * composer's `/` menu — `grid-execution` stopped gating availability when it
 * went back to meaning "what a scheduled run produces". A builtin that loses
 * this key would start being offered in chat, where following it fails on the
 * first tool call, and nothing else in the build would notice.
 */
describe('every builtin scopes itself to the agent that can run it', () => {
  it.each(listPlatformSkills().map((skill) => [skill.name, skill] as const))(
    '%s declares grid-agents',
    (_name, skill) => {
      const raw = skill.metadata[METADATA_AGENTS] ?? ''
      const listed = raw
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
      expect(listed).not.toHaveLength(0)
      // A name outside the known set is IGNORED by both resolvers, so a typo
      // here is the same as declaring nothing at all.
      expect(
        listed.filter((name) => (KNOWN_SKILL_AGENTS as readonly string[]).includes(name)),
      ).not.toHaveLength(0)
    },
  )
})
