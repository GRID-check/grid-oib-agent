'use client'

import type { SkillCategoryListItem } from '@/adapters/api/skills-client'

/**
 * Dev preview for Platform → Skills: the catalogue Piloti writes for every
 * organization. Renders the REAL `PlatformSkillCatalog` with a fetch shim
 * serving `/api/platform/skills`, so every row state is reviewable without a
 * backend: two published OFFERS (on every org's Skills tab, each deciding) and
 * a draft (invisible until the switch is flipped).
 *
 * There used to be a third state, a published STANDARD row running for the
 * whole fleet on nobody's tab. Migration 0088 retired the tier.
 *
 * The shim is installed at MODULE scope, not in an effect: a child's effect
 * fires first and would race a parent's fetch patch.
 * Not linked from anywhere and 404s outside development (see ../layout.tsx).
 */

import { I18nProvider } from '@/i18n'
import { PlatformSkillCatalog } from '@/app/app/(shell)/platform/skills/platform-skill-catalog'

const CATEGORIES: SkillCategoryListItem[] = [
  {
    id: 'cat-oib',
    name: 'OIB',
    description: null,
    slug: 'oib',
    sortOrder: 10,
    scope: 'platform',
  },
]

const SKILLS = [
  {
    id: 'ps-1',
    name: 'oib-fire-check',
    description: 'Checks a project against the OIB fire-safety guideline (OIB-Richtlinie 2).',
    body: 'Act as a fire-safety reviewer.\n\n1. Identify every fire-safety relevant building part.\n2. Verify each against OIB-Richtlinie 2.\n3. List deviations with the exact clause number.',
    metadata: { 'grid-agents': 'deep_researcher' },
    published: true,
    delivery: 'offer' as const,
    categoryId: 'cat-oib',
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
    delivery: 'offer' as const,
    categoryId: null,
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
    categoryId: 'cat-oib',
    createdAt: '2026-08-11T09:00:00Z',
    updatedAt: '2026-08-11T09:00:00Z',
  },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformSkillsShim?: boolean }
  if (!w.__platformSkillsShim) {
    w.__platformSkillsShim = true
    // Mutable working copy: the category manager's create/rename/remove runs
    // against this, so the preview shows the interaction rather than an error.
    // Annotated rather than inferred from the seed: the shim CREATES
    // categories too, and a created one has no slug (only the seeded
    // platform ones do). Inference from `CATEGORIES` alone narrows `slug`
    // to `string` and rejects the very rows this shim exists to make.
    const categories: SkillCategoryListItem[] = [...CATEGORIES]

    /** The JSON body the BFF clients send — unparseable means no fields. */
    const parseJsonBody = (body: BodyInit | null | undefined): { name?: unknown } => {
      if (typeof body !== 'string') return {}
      try {
        return JSON.parse(body) as { name?: unknown }
      } catch {
        return {}
      }
    }
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url === '/api/platform/skills') {
        return Response.json({ skills: SKILLS })
      }
      if (url === '/api/platform/skill-categories' && method === 'GET') {
        return Response.json({ categories })
      }
      if (url === '/api/platform/skill-categories' && method === 'POST') {
        const body = parseJsonBody(init?.body)
        const created = {
          id: `cat-dev-${Date.now()}`,
          name:
            typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'Neue Kategorie',
          description: null,
          slug: null,
          sortOrder: 0,
          scope: 'platform' as const,
        }
        categories.push(created)
        return Response.json({ category: created }, { status: 201 })
      }
      const match = /^\/api\/platform\/skill-categories\/([^/]+)$/.exec(
        new URL(url, location.origin).pathname,
      )
      if (match && (method === 'PATCH' || method === 'DELETE')) {
        const index = categories.findIndex((category) => category.id === match[1])
        if (index === -1) return Response.json({ error: 'not found' }, { status: 404 })
        if (method === 'DELETE') {
          categories.splice(index, 1)
          return Response.json({ deleted: true })
        }
        const body = parseJsonBody(init?.body)
        if (typeof body?.name === 'string' && body.name.trim()) {
          categories[index] = { ...categories[index], name: body.name.trim() }
        }
        return Response.json({ category: categories[index] })
      }
      if (url === '/api/platform/skill-categories') {
        return Response.json({ categories: CATEGORIES })
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
