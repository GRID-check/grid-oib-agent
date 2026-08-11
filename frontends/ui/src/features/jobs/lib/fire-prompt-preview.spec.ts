/**
 * @vitest-environment node
 */
/**
 * The WYSIWYG contract behind the job builder's preview pane: the text the UI
 * previews must equal the prompt the backend actually submits. The preview is
 * a client mirror (`fire-prompt-preview.ts`) of the server's `buildFirePrompt`
 * (`@/lib/jobs/service`, `server-only`); this spec imports the REAL server
 * function in the node environment and pins the mirror to it, so a divergence
 * anywhere fails here rather than shipping a dishonest preview.
 */
import { describe, expect, it } from 'vitest'
import { buildFirePrompt } from '@/lib/jobs/service'
import { buildFirePromptPreview } from './fire-prompt-preview'
import type { SkillSnapshot } from '@/adapters/api/skills-client'

const SNAPSHOT: SkillSnapshot = {
  name: 'data-table-analysis',
  description: 'Turn researched facts into structured tables.',
  body: '# Data Table Analysis\n\nCompute deterministically.',
  metadata: { 'grid-agents': 'deep_researcher' },
  origin: 'platform',
}

const PROMPT = 'Prüfe die Projektunterlagen auf offene Brandschutzpunkte.'

describe('buildFirePromptPreview mirrors buildFirePrompt', () => {
  it('produces byte-identical output for a platform skill snapshot', () => {
    expect(buildFirePromptPreview({ prompt: PROMPT, skill: SNAPSHOT })).toBe(
      buildFirePrompt({ prompt: PROMPT, skill: SNAPSHOT }),
    )
  })

  it('matches for an org-authored snapshot with metadata and long body', () => {
    const org: SkillSnapshot = {
      name: 'org-brief-check',
      description: 'Checks the org brief for open points.',
      body: 'Instruction body with multiple\nlines and special chars: "quotes", %-signs.',
      metadata: { 'grid-cards': 'legal_basis' },
      origin: 'org',
    }
    expect(buildFirePromptPreview({ prompt: PROMPT, skill: org })).toBe(
      buildFirePrompt({ prompt: PROMPT, skill: org }),
    )
  })

  it('embeds the full body verbatim (no truncation in the preview)', () => {
    const long: SkillSnapshot = {
      ...SNAPSHOT,
      body: 'line a\nline b\n' + 'x'.repeat(10_000),
    }
    const preview = buildFirePromptPreview({ prompt: PROMPT, skill: long })
    expect(preview).toContain(long.body)
    expect(preview.length).toBe(buildFirePrompt({ prompt: PROMPT, skill: long }).length)
  })

  it('is the trimmed prompt and nothing else when no skill is attached', () => {
    const preview = buildFirePromptPreview({ prompt: `  ${PROMPT}\n`, skill: null })
    expect(preview).toBe(buildFirePrompt({ prompt: `  ${PROMPT}\n`, skill: null }))
    // Spelled out: no fences, no Skill:/Beschreibung: block — just the prompt.
    expect(preview).toBe(PROMPT)
    expect(preview).not.toContain('---')
    expect(preview).not.toContain('Skill:')
  })

  it('trims the prompt the same way on both sides when a skill is attached', () => {
    const padded = `\n  ${PROMPT}  \n`
    expect(buildFirePromptPreview({ prompt: padded, skill: SNAPSHOT })).toBe(
      buildFirePrompt({ prompt: padded, skill: SNAPSHOT }),
    )
  })
})
