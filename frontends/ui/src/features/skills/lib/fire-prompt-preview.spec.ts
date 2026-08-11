/**
 * @vitest-environment node
 */
/**
 * The WYSIWYG contract behind the schedule editor's preview pane: the text the
 * UI previews must equal the prompt the backend actually submits. The preview
 * is a client mirror (`fire-prompt-preview.ts`) of the server's
 * `buildFirePrompt` (`@/lib/skills/service`, `server-only`); this spec imports
 * the REAL server function in the node environment and pins the mirror to it,
 * so a divergence anywhere fails here rather than shipping a dishonest preview.
 */
import { describe, expect, it } from 'vitest'
import { buildFirePrompt } from '@/lib/skills/service'
import { buildFirePromptPreview } from './fire-prompt-preview'
import type { SkillSnapshot } from '@/adapters/api/skills-client'

const SNAPSHOT: SkillSnapshot = {
  name: 'data-table-analysis',
  description: 'Turn researched facts into structured tables.',
  body: '# Data Table Analysis\n\nCompute deterministically.',
  metadata: { 'grid-execution': 'deep-research' },
  origin: 'platform',
}

describe('buildFirePromptPreview mirrors buildFirePrompt', () => {
  it('produces byte-identical output for a platform skill snapshot', () => {
    expect(buildFirePromptPreview(SNAPSHOT)).toBe(buildFirePrompt(SNAPSHOT))
  })

  it('matches for an org-authored snapshot with metadata and long body', () => {
    const org: SkillSnapshot = {
      name: 'org-brief-check',
      description: 'Checks the org brief for open points.',
      body: 'Instruction body with multiple\nlines and special chars: "quotes", %-signs.',
      metadata: { 'grid-execution': 'chat', 'grid-schedulable': 'false' },
      origin: 'org',
    }
    expect(buildFirePromptPreview(org)).toBe(buildFirePrompt(org))
  })

  it('embeds the full body verbatim (no truncation in the preview)', () => {
    const long: SkillSnapshot = {
      ...SNAPSHOT,
      body: 'line a\nline b\n' + 'x'.repeat(10_000),
    }
    const preview = buildFirePromptPreview(long)
    expect(preview).toContain(long.body)
    expect(preview.length).toBe(buildFirePrompt(long).length)
  })
})