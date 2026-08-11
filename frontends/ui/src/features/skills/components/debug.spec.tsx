import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'

vi.mock('@/adapters/api/skills-client', async (importActual) => {
  const actual = await importActual<typeof import('@/adapters/api/skills-client')>()
  return {
    ...actual,
    listSkills: vi.fn(),
    deleteSkill: vi.fn(),
  }
})

import * as client from '@/adapters/api/skills-client'
import { SkillToolbox } from './skill-toolbox'

const listSkillsMock = vi.mocked(client.listSkills)

const platformSkill: client.SkillListItem = {
  id: null,
  name: 'oib-fire-check',
  description: 'Checks the project against OIB fire-safety guidelines.',
  body: 'Act as a fire-safety reviewer. Check the project against OIB Richtlinie 2.',
  metadata: { 'grid-execution': 'chat' },
  origin: 'platform',
  enabled: true,
  clonedFrom: null,
  createdAt: null,
  updatedAt: null,
}

describe('debug', () => {
  test('dump', async () => {
    listSkillsMock.mockResolvedValue([platformSkill])
    render(<SkillToolbox canManage onClone={() => {}} onEdit={() => {}} />)
    await screen.findByText('oib-fire-check')
    const { writeFileSync } = await import('node:fs')
    writeFileSync('debug-dom.txt', document.body.innerHTML)
    const buttons = document.querySelectorAll('button')
    const { writeFileSync: ws } = await import('node:fs')
    ws(
      'debug-buttons.txt',
      Array.from(buttons).map((b) => JSON.stringify(b.textContent)).join('\n'),
    )
    expect(true).toBe(true)
  })
})
