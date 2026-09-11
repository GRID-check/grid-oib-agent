/**
 * @vitest-environment node
 */
/**
 * What every file Piloti produces says about itself.
 *
 * Three claims are worth a test here, and one of them is not about behaviour at
 * all.
 *
 * **The default resolves.** Nothing overrides anything today, so the resolver's
 * whole job is to hand back the platform's own words with the organization's
 * name in them — and the placeholder substitution is where that quietly goes
 * wrong, because a template that fails to substitute still returns a plausible
 * string.
 *
 * **The override merges.** The seam is the reason this module exists rather
 * than a constant, and a seam nothing exercises is a seam that has never run.
 * The stub below is the whole of what an admin surface will one day write into
 * `organizations.settings`.
 *
 * **The prose is not Markdown.** This is the one that will actually catch
 * somebody. The same sentences are pasted verbatim into a `.md` file AND laid
 * out as a PDF text run, and the next person to edit them will be writing
 * German, not thinking about a lexer. A `|` opens a table, a leading `#` opens
 * a heading, a backtick opens a fence — in one of the two formats, silently.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getOrgSettings = vi.hoisted(() => vi.fn())
vi.mock('@/lib/organizations/service', () => ({ getOrgSettings }))

import { locales } from '@/i18n/config'
import {
  loadOrganizationBrandingOverride,
  mergeBrandingOverride,
  ORGANIZATION_BRANDING_SETTINGS_KEY,
  PLATFORM_DOCUMENT_BRANDING,
  resolveDocumentBranding,
} from './branding'

const noSettings = { displayName: null, defaultLocale: 'de', settings: {} }

/** The shape an admin surface will one day write into the jsonb bag. */
const storedOverride = (settings: Record<string, unknown>): void => {
  getOrgSettings.mockResolvedValue({ ...noSettings, settings })
}

beforeEach(() => {
  vi.clearAllMocks()
  getOrgSettings.mockResolvedValue(noSettings)
})

describe('the platform default', () => {
  it('names the organization in the header line', async () => {
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro ZT GmbH',
      locale: 'de',
    })
    expect(branding.headerLine).toBe('Erstellt mit Piloti für Musterbüro ZT GmbH')
    expect(branding.footerLine).toBe('Piloti · Entwurf, nicht freigegeben')
  })

  it('names the product alone when there is no organization to name', async () => {
    // An anonymous deployment, or WorkOS unreachable. „Erstellt mit Piloti für"
    // with nothing after it is worse than not naming an office at all.
    const branding = await resolveDocumentBranding({ organizationName: null, locale: 'de' })
    expect(branding.headerLine).toBe('Erstellt mit Piloti')
    expect(branding.headerLine).not.toContain('{')
  })

  it('says who carries the content, which is nobody until somebody approves it', async () => {
    // ADR-0047's rule about a byline, in the file rather than in the app: the
    // marking says how much to trust this, and the prose says who is answerable
    // for it. They are different sentences and this is the second one.
    const branding = await resolveDocumentBranding({ organizationName: 'X', locale: 'de' })
    expect(branding.prose).toContain('Verantwortung')
    expect(branding.prose).toContain('freigibt')
    expect(branding.prose).not.toContain('{product}')
  })

  it('leaves the marking’s generator name alone, because it is an interface', async () => {
    // Overridable copy would be a tenant able to make its own documents
    // undetectable while every printed word still said they were marked.
    storedOverride({
      [ORGANIZATION_BRANDING_SETTINGS_KEY]: { copy: { de: { productName: 'Bürotool' } } },
    })
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro',
      locale: 'de',
    })
    expect(branding.productName).toBe('Bürotool')
    expect(branding.aiGeneratorName).toBe('Piloti')
  })
})

describe('the language the document is in', () => {
  it('picks the English copy for an English reader', async () => {
    const branding = await resolveDocumentBranding({ organizationName: 'Acme', locale: 'en' })
    expect(branding.headerLine).toBe('Created with Piloti for Acme')
    expect(branding.prose).toContain('responsibility for its content')
  })

  it('falls back to the app default rather than rendering nothing', async () => {
    const branding = await resolveDocumentBranding({ organizationName: 'Acme' })
    expect(branding.headerLine).toBe('Created with Piloti for Acme')
  })

  it('inherits the office’s own language when the caller has none', async () => {
    // The agent's internal route sends no locale cookie and no Accept-Language,
    // so a document filed from a chat turn would otherwise carry an English
    // header line on a German Aktenvermerk for every tenant.
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro',
    })
    expect(branding.headerLine).toBe('Erstellt mit Piloti für Musterbüro')
  })

  it('lets an explicit language beat the office’s default', async () => {
    // Explicit beats inherited — the same order ADR-0014/0022 resolve a model
    // in. A filed report passes the locale its cover facts are already in.
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro',
      locale: 'en',
    })
    expect(branding.headerLine).toBe('Created with Piloti for Musterbüro')
  })

  it('carries every field in every language the app supports', () => {
    // A language added to the app with no document copy behind it would file
    // documents with an empty header line and nobody would see it until one
    // reached a Behörde.
    for (const locale of locales) {
      const template = PLATFORM_DOCUMENT_BRANDING.copy[locale]
      for (const value of Object.values(template)) {
        expect(value.trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the override seam', () => {
  it('lays one office’s header line over the platform copy and keeps the rest', () => {
    const merged = mergeBrandingOverride(PLATFORM_DOCUMENT_BRANDING, {
      copy: { de: { header: '{organization} · erstellt mit {product}' } },
    })
    expect(merged.copy.de.header).toBe('{organization} · erstellt mit {product}')
    // The office asked for a header line, not for the platform's prose to go
    // away. A merge that replaced the whole template would file a document with
    // no statement about who is answerable for it.
    expect(merged.copy.de.prose).toBe(PLATFORM_DOCUMENT_BRANDING.copy.de.prose)
    expect(merged.copy.en).toEqual(PLATFORM_DOCUMENT_BRANDING.copy.en)
  })

  it('reads the override out of the settings bag and applies it end to end', async () => {
    storedOverride({
      [ORGANIZATION_BRANDING_SETTINGS_KEY]: {
        copy: { de: { header: '{organization} · erstellt mit {product}' } },
      },
    })
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro ZT GmbH',
      locale: 'de',
    })
    expect(branding.headerLine).toBe('Musterbüro ZT GmbH · erstellt mit Piloti')
    expect(branding.disclaimer).toBe(PLATFORM_DOCUMENT_BRANDING.copy.de.disclaimer)
  })

  it('keeps an organization name from rewriting the line it appears on', async () => {
    // Only the two known placeholders are substituted, and only once — so an
    // office called `{product}` gets its name printed, not the product's.
    storedOverride({})
    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: '{product}',
      locale: 'de',
    })
    expect(branding.headerLine).toBe('Erstellt mit Piloti für {product}')
  })

  it('is null when nothing is stored, which is every organization today', async () => {
    expect(await loadOrganizationBrandingOverride('org_1')).toBeNull()
  })

  it('does not read anything for a deployment with no organization', async () => {
    expect(await loadOrganizationBrandingOverride(null)).toBeNull()
    expect(getOrgSettings).not.toHaveBeenCalled()
  })

  it('falls back to the platform copy when the stored override is malformed', async () => {
    // Added matter, exactly as the report's cover facts are: a settings row
    // somebody hand-edited must not cost a user the filing of a document a
    // twelve-minute run just produced.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    storedOverride({ [ORGANIZATION_BRANDING_SETTINGS_KEY]: { copy: { de: { header: 42 } } } })

    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro',
      locale: 'de',
    })
    expect(branding.headerLine).toBe('Erstellt mit Piloti für Musterbüro')
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })

  it('files the document anyway when the settings read throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    getOrgSettings.mockRejectedValue(new Error('connection refused'))

    const branding = await resolveDocumentBranding({
      organizationId: 'org_1',
      organizationName: 'Musterbüro',
      locale: 'de',
    })
    expect(branding.prose).toBe(
      PLATFORM_DOCUMENT_BRANDING.copy.de.prose.replaceAll('{product}', 'Piloti'),
    )
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('the prose survives both formats', () => {
  /**
   * Characters that mean something to a Markdown lexer at the start of a line
   * or in the middle of one. `-` and `.` are deliberately absent: a hyphen only
   * opens a list at the start of a line followed by a space, and these strings
   * are inserted as a paragraph, never as a first line.
   */
  const MARKDOWN_ACTIVE = /[|`*_#[\]<>]/

  it('has no Markdown in any line that is printed as prose', () => {
    for (const locale of locales) {
      const template = PLATFORM_DOCUMENT_BRANDING.copy[locale]
      for (const line of [
        template.tagline,
        template.header,
        template.headerWithoutOrganization,
        template.footer,
        template.prose,
        template.disclaimer,
      ]) {
        expect(line).not.toMatch(MARKDOWN_ACTIVE)
      }
    }
  })

  it('is a block of sentences, not a wall and not a fragment', () => {
    for (const locale of locales) {
      const sentences = PLATFORM_DOCUMENT_BRANDING.copy[locale].prose.split(/(?<=\.)\s+/)
      expect(sentences.length).toBeGreaterThanOrEqual(2)
      expect(sentences.length).toBeLessThanOrEqual(3)
    }
  })

  it('ships no logo, so no renderer is fetching an asset at render time', () => {
    expect(PLATFORM_DOCUMENT_BRANDING.logo).toBeNull()
  })
})
