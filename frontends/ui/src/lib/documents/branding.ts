/**
 * What every file Piloti produces says about itself.
 *
 * ## Why this is a module and not a paragraph in each renderer
 *
 * A generated document leaves the product. It is mailed, printed into a Befund
 * folder, attached to an Einreichung and opened two years later by somebody who
 * was never a user — and at that point the only thing standing between the
 * reader and a wrong conclusion is what is INSIDE the bytes. Three sentences
 * have to be there: what this document is, that Piloti drafted it, and that
 * nobody is answerable for its content until a person approves it (ADR-0047's
 * „Unvergeben" is the honest state, and ADR-0054's publish door is the act that
 * ends it).
 *
 * Those three sentences were about to be written twice — once in the Markdown
 * producer, once on the PDF cover — and two copies of a liability sentence is
 * the failure mode this repository has already paid for once with the AI
 * marking: `diagram_pdf` printed a footer line, `diagram_svg` printed nothing,
 * and both looked locally correct. So the words live here, once, and every
 * renderer is a READER of them.
 *
 * ## Why a resolver and not a constant
 *
 * The constant is what it returns today. The seam is the point: an office that
 * files a Befund under its own letterhead will want its own header line, and
 * the precedent for how that arrives is `platform_model_defaults` overridden by
 * an org row (ADR-0014/0022, `docs/architecture/org-model-configuration.md`) —
 * **platform default, tenant override, explicit beats inherited**. The design
 * spec's extension table names this exact shape for the sibling question
 * ("whether it files automatically … v1's resolver returns a constant … the
 * precedent is ADR-0014/0022").
 *
 * So the override layer is written, tested and reachable NOW, and the only
 * reason nothing overrides anything today is that no `organizations.settings`
 * row carries a `documentBranding` key. No migration is needed for it to start
 * working: that column is the repo's declared home for org-scoped settings
 * ("attach future org-scoped data via the `settings` jsonb without a schema
 * change each time", `db/schema/organizations.ts`).
 *
 * ## What is NOT overridable, and why
 *
 * {@link DocumentBranding.aiGeneratorName} is referenced from
 * `@/lib/ai-provenance`, never re-spelled and never merged from a tenant. It is
 * the name a downstream detector matches on, so a tenant that could rename it
 * would be a tenant that could switch its documents' machine-readable marking
 * off by making it unmatchable — while every printed word still said the file
 * was marked. Branding is copy; the marking is an interface.
 */

import { z } from 'zod'
import { AI_GENERATOR_NAME } from '@/lib/ai-provenance'
import { PRODUCT_NAME } from '@/lib/brand'
import { defaultLocale, isLocale, locales, type Locale } from '@/i18n/config'
import { getOrgSettings } from '@/lib/organizations/service'

/**
 * The key under which an organization's override lives in the `settings` jsonb
 * of its `organizations` row (`db/schema/organizations.ts`).
 *
 * Named here rather than spelled at the read site so the schema, the reader and
 * any later admin surface argue about one string.
 */
export const ORGANIZATION_BRANDING_SETTINGS_KEY = 'documentBranding'

/**
 * One language's copy, BEFORE an organization's name is substituted.
 *
 * Templates rather than finished lines because the one variable in them is the
 * reader's own office, and an override has to be able to move it — an office
 * whose header reads „Musterbüro ZT GmbH · erstellt mit Piloti" is putting the
 * organization first, which a fixed `Erstellt mit {product} für …` could not
 * express.
 *
 * `{product}` and `{organization}` are the only placeholders. An unknown one is
 * left standing rather than blanked: a visible `{buero}` on a cover sheet is a
 * typo somebody fixes, and a silently empty line is one nobody sees.
 */
export interface DocumentBrandingTemplate {
  /** The product, as the reader's document names it. */
  productName: string
  /**
   * One line saying what the product is. Printed beside the name, never alone.
   *
   * It is the MARKDOWN document's substitute for a mark: a `.md` file has no
   * cover band and no wordmark, so `Piloti — Die KI-Plattform …` is the only
   * thing in it that reads as a lockup. The PDF draws the mark itself and does
   * not print this, which is why {@link DocumentBrandingTemplate.prose} does
   * not restate the tagline — in the Markdown it would then say the same
   * sentence twice, two lines apart.
   */
  tagline: string
  /** The header line, when the organization has a name. */
  header: string
  /** The header line, when it does not — an anonymous deployment, or WorkOS down. */
  headerWithoutOrganization: string
  /** The line that repeats at the foot of every page / at the end of the file. */
  footer: string
  /**
   * The two-to-three-sentence block the reader sees on every generated
   * document: what it is, who drafted it, and who carries its content.
   *
   * Plain prose ON PURPOSE — no Markdown, no pipes, no backticks, no brackets.
   * It is pasted verbatim into a Markdown file AND laid out as a PDF text run,
   * and a `|` in it would open a table in one of the two. `branding.spec.ts`
   * asserts that, because the next person to edit this string will be writing
   * German, not thinking about a lexer.
   */
  prose: string
  /** One sentence about what the document is not. Same no-Markdown rule. */
  disclaimer: string
}

/** The platform's branding: one logo, one set of copy per supported language. */
export interface PlatformDocumentBranding {
  /**
   * A data URI or an asset path under `public/`, or null.
   *
   * `null` today and deliberately so: `public/` carries no raster logo, and the
   * PDF chrome redraws the mark as vector paths from `theme.ts` (see
   * `lib/pdf/branding.tsx`) rather than fetching an asset at render time. The
   * slot exists because the FIRST thing an office asks for after its own header
   * line is its own mark on it, and a slot added later would mean a renderer
   * change; a slot added now means a value change.
   */
  logo: string | null
  copy: Record<Locale, DocumentBrandingTemplate>
}

/**
 * The branding for one document, in one language, with nothing left to fill in.
 *
 * This is what a renderer sees. It has no placeholders, no locale map and no
 * optionality: a renderer that had to decide what to do when `headerLine` is
 * missing would be a renderer deciding what a document says.
 */
export interface DocumentBranding {
  productName: string
  tagline: string
  headerLine: string
  footerLine: string
  prose: string
  disclaimer: string
  logo: string | null
  /**
   * The generator name the machine-readable marking carries.
   *
   * Referenced from `@/lib/ai-provenance`, never duplicated and never
   * overridden — see the module docstring. It is here so a renderer has one
   * object to read instead of two imports, not so it can be changed.
   */
  aiGeneratorName: string
}

/**
 * The German source of this copy, and the English one beside it.
 *
 * German first because that is the language the documents are written in: an
 * OIB compliance report reaches an Austrian Behörde, and the English variant
 * exists for a reader who set the interface to English, not the other way
 * round.
 *
 * The prose says three things and stops. It does NOT repeat
 * `answerExport.aiNotice` („KI-generiert — nicht geprüft"), which is a
 * different statement made in a different place for a different reason: the
 * notice says how much of this document to trust, and this says who is
 * answerable for it. A document that printed both as one block would be a
 * document that says „ungeprüft" twice and „unvergeben" never.
 */
export const PLATFORM_DOCUMENT_BRANDING: PlatformDocumentBranding = {
  logo: null,
  copy: {
    de: {
      productName: PRODUCT_NAME,
      tagline: 'Die KI-Plattform für Architektur- und Planungsbüros',
      header: 'Erstellt mit {product} für {organization}',
      headerWithoutOrganization: 'Erstellt mit {product}',
      footer: '{product} · Entwurf, nicht freigegeben',
      prose:
        'Dieses Dokument hat {product} verfasst. Es ist ein Arbeitsstand und keine ' +
        'Freigabe: Die fachliche Verantwortung für den Inhalt trägt die Person, die ihn ' +
        'freigibt — vorher trägt sie niemand.',
      disclaimer:
        'Maßgeblich sind die geltenden Rechtsvorschriften in der jeweils gültigen Fassung.',
    },
    en: {
      productName: PRODUCT_NAME,
      tagline: 'The AI platform for architecture and planning practices',
      header: 'Created with {product} for {organization}',
      headerWithoutOrganization: 'Created with {product}',
      footer: '{product} · Draft, not approved',
      prose:
        '{product} wrote this document. It is a working draft and not an approval: ' +
        'responsibility for its content rests with the person who approves it, and until ' +
        'then it rests with nobody.',
      disclaimer: 'The applicable regulations, in their version in force, are what governs.',
    },
  },
}

/**
 * One language's override. Every field optional: an office that wants only its
 * own header line must not have to restate the prose to get it.
 *
 * Not `.strict()`. A key this build does not know is a key written by another
 * build — a newer admin surface, or an older one — and refusing the whole
 * object over it would take the office's header line away to punish a field
 * nobody reads. Unknown keys are dropped; the fields we know still apply.
 */
const templateOverrideSchema = z.object({
  productName: z.string().min(1).optional(),
  tagline: z.string().optional(),
  header: z.string().optional(),
  headerWithoutOrganization: z.string().optional(),
  footer: z.string().optional(),
  prose: z.string().optional(),
  disclaimer: z.string().optional(),
})

/** The shape `organizations.settings.documentBranding` is read as. */
export const documentBrandingOverrideSchema = z.object({
  logo: z.string().nullish(),
  copy: z
    .object({
      de: templateOverrideSchema.optional(),
      en: templateOverrideSchema.optional(),
    })
    .optional(),
})

export type DocumentBrandingOverride = z.infer<typeof documentBrandingOverrideSchema>

/**
 * The platform branding with one organization's override laid over it.
 *
 * Field-by-field rather than through a generic deep merge, because the shape is
 * two levels deep and a generic merge would have to decide what an override's
 * `null` means for every future field. Here it means one thing, stated once:
 * `logo: null` clears the logo, an absent `logo` inherits it.
 *
 * Pure, exported and locale-complete — the loop is over {@link locales}, so a
 * third language added to the app cannot silently lose its override.
 */
export function mergeBrandingOverride(
  base: PlatformDocumentBranding,
  override: DocumentBrandingOverride | null,
): PlatformDocumentBranding {
  if (!override) return base

  const copy = {} as Record<Locale, DocumentBrandingTemplate>
  for (const locale of locales) {
    copy[locale] = { ...base.copy[locale], ...(override.copy?.[locale] ?? {}) }
  }
  return {
    logo: override.logo === undefined ? base.logo : (override.logo ?? null),
    copy,
  }
}

/**
 * Fill `{product}` and `{organization}` in one template line.
 *
 * A placeholder with no value is left standing rather than replaced with an
 * empty string — see {@link DocumentBrandingTemplate}. Only the two known names
 * are substituted at all, so an organization name containing `{product}` cannot
 * make the line say something else.
 */
type TemplateValues = Partial<Record<'product' | 'organization', string>>

function fillTemplate(template: string, values: TemplateValues): string {
  return template.replace(
    /\{(product|organization)\}/g,
    (match, name: 'product' | 'organization') => values[name] ?? match,
  )
}

/**
 * The two facts one `organizations` row carries about a document's branding:
 * the override, and the language the office works in.
 *
 * Read together because they come out of the same row and the same round trip.
 * Splitting them would mean two reads of an uncached table per filed document,
 * to answer one question.
 */
interface OrganizationBrandingSettings {
  override: DocumentBrandingOverride | null
  /** `organizations.default_locale` — the office's own language, or null. */
  defaultLocale: Locale | null
}

const NO_BRANDING_SETTINGS: OrganizationBrandingSettings = { override: null, defaultLocale: null }

/**
 * Read both, or neither.
 *
 * ## Why every failure here is a default and not a throw
 *
 * Branding is ADDED MATTER, exactly as the research report's cover facts are
 * (`loadProfile` in `research-report.ts` makes the same trade for the same
 * reason). A database blip, an unreachable cache or a malformed jsonb written
 * by hand must not cost a user the filing of a document a twelve-minute run
 * just produced. The document still files, carrying the platform's own words —
 * which are true of every deployment and are never the wrong thing to print.
 *
 * A parse failure IS logged, because a tenant whose override silently does
 * nothing has a support ticket nobody can answer without this line.
 */
async function readOrganizationBrandingSettings(
  organizationId: string | null | undefined,
): Promise<OrganizationBrandingSettings> {
  if (!organizationId) return NO_BRANDING_SETTINGS

  try {
    const row = await getOrgSettings(organizationId)
    const defaultLocale = isLocale(row.defaultLocale) ? row.defaultLocale : null
    const stored = row.settings[ORGANIZATION_BRANDING_SETTINGS_KEY]
    if (stored === undefined || stored === null) return { override: null, defaultLocale }

    const parsed = documentBrandingOverrideSchema.safeParse(stored)
    if (parsed.success) return { override: parsed.data, defaultLocale }

    console.error('[documents] organization document-branding override is malformed', {
      organizationId,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
    return { override: null, defaultLocale }
  } catch (error) {
    console.error('[documents] could not read the organization document branding', {
      organizationId,
      cause: error instanceof Error ? error.name : 'unknown',
    })
    return NO_BRANDING_SETTINGS
  }
}

/**
 * An organization's stored branding override, or null — the typed hook the
 * override layer hangs on.
 *
 * Exported so the seam is addressable on its own: it is what an admin surface
 * will read back to show an office what it has stored, and it is where a test
 * proves the override layer is reached rather than assumed.
 */
export async function loadOrganizationBrandingOverride(
  organizationId: string | null | undefined,
): Promise<DocumentBrandingOverride | null> {
  return (await readOrganizationBrandingSettings(organizationId)).override
}

export interface ResolveDocumentBrandingInput {
  /** The tenant whose override applies. Absent for an anonymous deployment. */
  organizationId?: string | null
  /**
   * The organization's display name, as the app names it.
   *
   * Passed in rather than looked up here. `getOrganizationDisplayName` can
   * reach WorkOS, and a resolver that hid an identity round-trip inside a copy
   * lookup would put one in front of every renderer that ever reads a header
   * line. Null is a first-class value: the header then names the product alone.
   */
  organizationName?: string | null
  /**
   * The document's language, when the caller knows it.
   *
   * Optional, and the fallback chain is the point: **explicit beats inherited**,
   * the same order ADR-0014/0022 resolve a model in. A filed research report
   * passes the locale the reader read the answer in, because every other word on
   * that cover — the facts, the „KI-generiert" notice — is already in it, and
   * branding in a second language would be the one paragraph on the page that
   * disagrees with the rest.
   *
   * A document filed by the agent's own internal route has no reader and no
   * locale cookie to resolve one from, so it passes nothing and inherits
   * `organizations.default_locale` — the office's own language, which is the
   * language its documents are written in. Without that, a German Aktenvermerk
   * would carry an English header line for no better reason than that the agent
   * does not send cookies.
   */
  locale?: Locale | null
}

/**
 * The branding one document carries — the single entry point.
 *
 * Today this returns {@link PLATFORM_DOCUMENT_BRANDING} for every caller,
 * because no organization has an override stored. That is a statement about the
 * DATA, not about the code: the lookup runs, the merge runs, and the day a row
 * carries a `documentBranding` key its words are on the next filed document
 * with no renderer touched. See the module docstring for why that seam is worth
 * having before its first user.
 */
export async function resolveDocumentBranding(
  input: ResolveDocumentBrandingInput,
): Promise<DocumentBranding> {
  const settings = await readOrganizationBrandingSettings(input.organizationId)
  const locale = input.locale ?? settings.defaultLocale ?? defaultLocale
  const branding = mergeBrandingOverride(PLATFORM_DOCUMENT_BRANDING, settings.override)
  const template = branding.copy[locale] ?? branding.copy[defaultLocale]

  const organization = input.organizationName?.trim()
  const values: TemplateValues = { product: template.productName, organization }

  return {
    productName: template.productName,
    tagline: fillTemplate(template.tagline, values),
    headerLine: fillTemplate(
      organization ? template.header : template.headerWithoutOrganization,
      values,
    ),
    footerLine: fillTemplate(template.footer, values),
    prose: fillTemplate(template.prose, values),
    disclaimer: fillTemplate(template.disclaimer, values),
    logo: branding.logo,
    aiGeneratorName: AI_GENERATOR_NAME,
  }
}
