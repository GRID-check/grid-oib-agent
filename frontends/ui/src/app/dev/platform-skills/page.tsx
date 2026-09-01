'use client'

/**
 * Dev preview for Platform → Skills: the catalogue Piloti writes for every
 * organization. Renders the REAL `PlatformSkillCatalog` with a fetch shim
 * serving `/api/platform/skills`, so every row state is reviewable without a
 * backend: a published OFFER (on every org's Skills tab, each deciding), a
 * published STANDARD (running for the whole fleet, on nobody's tab) and a draft
 * (invisible until the switch is flipped).
 *
 * The shim is installed at MODULE scope, not in an effect: a child's effect
 * fires first and would race a parent's fetch patch.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import type { JSX } from 'react'
import { I18nProvider } from '@/i18n'
import { PlatformSkillCatalog } from '@/app/app/(shell)/platform/skills/platform-skill-catalog'

const SKILLS = [
  {
    id: 'ps-1',
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2.\n3. List deviations with the exact clause number.',
    metadata: { 'grid-agents': 'deep_researcher' },
    published: true,
    delivery: 'offer' as const,
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-10T09:00:00Z',
  },
  {
    id: 'ps-3',
    name: 'oib-paragraph-citations',
    description:
      'Every normative claim carries the OIB clause it rests on — the house rule for the whole fleet.',
    body: 'When you state that something is required, permitted or forbidden, name the OIB-Richtlinie and the exact clause number it comes from.',
    metadata: {},
    published: true,
    // The state the tier exists for: live for every organization, on nobody's
    // Skills tab, and nothing a tenant can switch off.
    delivery: 'standard' as const,
    createdAt: '2026-08-12T09:00:00Z',
    updatedAt: '2026-08-12T09:00:00Z',
  },
  {
    id: 'ps-2',
    name: 'energy-certificate-check',
    description: 'Reviews the energy certificate against OIB-Richtlinie 6.',
    body: 'Compare the project’s energy certificate against OIB-Richtlinie 6 and list every value that misses its limit.',
    metadata: {},
    published: false,
    delivery: 'offer' as const,
    createdAt: '2026-08-11T09:00:00Z',
    updatedAt: '2026-08-11T09:00:00Z',
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformSkillsShim?: boolean }
  if (!w.__platformSkillsShim) {
    w.__platformSkillsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url === '/api/platform/skills') {
        return Response.json({ skills: SKILLS })
      }
      // The publish switch and the delete action. Unanswered, both roll back
      // against the real backend and the preview shows an error toast instead
      // of the control working.
      if (url.startsWith('/api/platform/skills/')) {
        return Response.json({ skill: SKILLS[0] })
      }
      return real(input, init)
    }
  }
}

export default function PlatformSkillsDevPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8" data-testid="platform-skills-preview">
        <PlatformSkillCatalog />
      </main>
    </I18nProvider>
  )
}
