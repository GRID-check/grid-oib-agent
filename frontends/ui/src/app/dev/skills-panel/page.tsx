'use client'

/**
 * Dev preview for the Agent Skills tab. Renders the REAL SkillsPanel — which is
 * the org skill TOOLBOX and nothing else, since everything schedule-shaped moved
 * to the Jobs tab — with a fetch shim serving the merged toolbox
 * (`/api/skills`), so every row variant is reviewable without a backend:
 * a builtin, an org skill, and a disabled clone of a builtin.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { SkillsPanel } from '@/features/skills/components/skills-panel'

const SKILLS = [
  {
    id: null,
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Read the project brief and identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2 (brandschutztechnische Anforderungen).\n3. List deviations with the exact clause number and a suggested fix.',
    metadata: { 'grid-execution': 'chat' },
    origin: 'platform',
    enabled: true,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'skill-1',
    name: 'acoustic-report',
    description: 'Drafts the acoustic compliance report (OIB-Richtlinie 5).',
    body: 'Draft a report on sound insulation per OIB-Richtlinie 5.\n\nUse the project documents as the source of truth for the building’s construction.',
    metadata: { 'grid-execution': 'deep-research', 'grid-schedulable': 'false' },
    origin: 'org',
    enabled: true,
    clonedFrom: null,
    createdAt: '2026-07-10T09:00:00Z',
    updatedAt: '2026-07-16T09:00:00Z',
  },
  {
    id: 'skill-2',
    name: 'oib-fire-check-adapt',
    description: 'Adapted fire check that also verifies escape routes against OIB 2.3.',
    body: 'Like the built-in fire check, plus:\n\n4. Verify every escape route’s width and length against OIB-Richtlinie 2.3.',
    metadata: { 'grid-execution': 'chat' },
    origin: 'platform-clone',
    enabled: false,
    clonedFrom: 'oib-fire-check',
    createdAt: '2026-07-12T10:00:00Z',
    updatedAt: '2026-07-12T10:00:00Z',
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __skillsPanelShim?: boolean }
  if (!w.__skillsPanelShim) {
    w.__skillsPanelShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/skills') {
        return Response.json({ skills: SKILLS })
      }
      return real(input, init)
    }
  }
}

export default function SkillsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex flex-col gap-6 p-8" data-testid="skills-panel-preview">
        <SkillsPanel canManageOrgSkills />
      </main>
    </I18nProvider>
  )
}
