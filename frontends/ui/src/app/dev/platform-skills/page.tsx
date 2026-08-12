'use client'

/**
 * Dev preview for Platform → Skills: the catalogue Piloti curates for every
 * organization. Renders the REAL `PlatformSkillCatalog` with a fetch shim
 * serving `/api/platform/skills`, so both row states are reviewable without a
 * backend — a published skill (offered to the fleet) and a draft (invisible to
 * every tenant until the switch is flipped).
 *
 * The shim is installed at MODULE scope, not in an effect: a child's effect
 * fires first and would race a parent's fetch patch.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { PlatformSkillCatalog } from '@/app/app/platform/skills/platform-skill-catalog'

const SKILLS = [
  {
    id: 'ps-1',
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2.\n3. List deviations with the exact clause number.',
    metadata: { 'grid-agents': 'deep_researcher' },
    published: true,
    createdAt: '2026-08-01T09:00:00Z',
    updatedAt: '2026-08-10T09:00:00Z',
  },
  {
    id: 'ps-2',
    name: 'energy-certificate-check',
    description: 'Reviews the energy certificate against OIB-Richtlinie 6.',
    body: 'Compare the project’s energy certificate against OIB-Richtlinie 6 and list every value that misses its limit.',
    metadata: {},
    published: false,
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
