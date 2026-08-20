/**
 * The first caller of `fileGeneratedDocument`: a finished deep-research run.
 *
 * A separate module from the jobs proxy for the reason every other route in
 * this app has one — a route handler validates a request shape and delegates —
 * and for one specific to this path: what a research report LOOKS like (its
 * title, its renderer, its marking) is a product decision that will change
 * without the proxy changing, and the next producer must be able to arrive as a
 * sibling of this file rather than as another branch inside the proxy.
 *
 * It owns exactly two things the service deliberately does not:
 *
 *   - the renderer. `@/lib/pdf` already turns Markdown into a PDF, so a
 *     research report is that pipeline with the two provenance options turned
 *     on — never a second exporter.
 *   - the title, which is read out of the report the writer agent produced
 *     rather than invented here.
 *
 * ## Why the filed report is a PDF and the saved-answer export is a .docx
 *
 * They are different documents with different jobs, and the format follows the
 * job. A saved answer is exported so somebody can EDIT it — paste it into a
 * Befund, revise it, sign it — and `answer-export/docx.ts` says so in its own
 * header. A filed report is exported so somebody can READ it in the app and
 * ATTACH it to an Einreichung, and both of those want a PDF:
 *
 *   - `PREVIEW_TYPES` in `features/documents/components/file-preview-pane.tsx`
 *     lists the content types the Files pane can render. `.docx` is not one of
 *     them, so the report a user had just commissioned landed in Berichte as a
 *     generic icon with no in-app preview — download-only, for the one document
 *     in the project nobody had read yet;
 *   - an Einreichung attachment is a PDF. Handing the Behörde an editable Word
 *     file is not the form the artifact takes at the end of this flow.
 *
 * The `.docx` export path for saved answers is untouched and stays. This is a
 * new renderer at an existing seam — `fileGeneratedDocument` takes the render
 * function precisely so a new output format is not a new pipeline.
 */

import 'server-only'
import { getLocale, getTranslations } from '@/i18n/server'
import type { Locale } from '@/i18n/config'
import type { Translator } from '@/i18n/translate'
import { PDF_MEDIA_TYPE, renderMarkdownPdf } from '@/lib/pdf/markdown-pdf'
import type { PdfFactRow } from '@/lib/pdf/ReactPdfDocument'
import { legalBasisSection } from '@/lib/pdf/legal-basis'
import { AI_GENERATOR_NAME } from '@/lib/ai-provenance'
import { buildProjectBriefView } from '@/lib/project-profile/brief-view'
import { findProjectInOrg } from '@/lib/projects/repository'
import type { AuthorizedSession } from '@/lib/auth/types'
import { fileGeneratedDocument, type FiledGeneratedDocument } from './generated'

export interface FileResearchReportInput {
  session: AuthorizedSession
  projectId: string
  /** The backend async job id of the run. */
  runId: string
  /** The report as the writer agent wrote it: Markdown. */
  report: string
  /**
   * The run's Grid cards, as `metadata.cards` stores them. The `legal_basis`
   * ones become the „Rechtsgrundlagen" section; every other type is ignored
   * here, because the report's prose already carries what they say.
   *
   * Optional, and `unknown[]` rather than a card type, for two separate
   * reasons. It is UNKNOWN because these are jsonb that crossed a process
   * boundary and `@/lib/pdf/legal-basis` is the module that narrows them. It is
   * OPTIONAL because a run need not have produced any — `JobReportResponse`
   * (`frontends/aiq_api/src/aiq_api/routes/jobs.py`) now returns `cards`
   * alongside the report, but returns it null when the run generated none, and
   * a scheduled or replayed run may pass none at all. A section that cannot be
   * built prints nothing rather than an empty heading, so absent is a
   * first-class value here, not a gap waiting to be filled.
   */
  cards?: unknown[]
  request?: Request
}

/**
 * The report's own heading, and the body without it.
 *
 * The writer agent opens `/shared/output.md` with an H1 that names the thing it
 * researched, which is a better document title than anything this module could
 * derive — and leaving it in the body as well would print the same line twice,
 * once as the document's H1 and once as the first paragraph under it.
 *
 * When there is no leading heading the body is returned untouched and the
 * caller falls back to the export's own generic title. A title guessed from the
 * first sentence would be the export stating something the run never did.
 */
export function splitReportTitle(report: string): { title: string | null; body: string } {
  const match = /^[\s]*#\s+(.+?)\s*(?:\n|$)/.exec(report)
  if (!match) return { title: null, body: report }
  return { title: match[1].trim(), body: report.slice(match[0].length) }
}

/**
 * The facts the cover block prints, and why each one is on it.
 *
 * A report that reaches a Behörde with no project, no place and no date is an
 * anonymous essay, and roadmap #3 asks for "a deliverable an architect can hand
 * to the authority". The opposite failure is just as real: a cover sheet that
 * reprints the intake is a second document standing in front of the first. So
 * the rule applied here is that a row earns its place only if the reader cannot
 * READ THE REPORT without it — either because it identifies the object, or
 * because it decides which rules the report's claims were checked against.
 *
 * On the sheet:
 *
 *   - **Projekt** — the object, as the app names it. The one fact a reader
 *     away from the app cannot recover; the .docx has carried it since the
 *     saved-answer export shipped.
 *   - **Standort** (`standort_adresse`, intake A2_adr) — the object, as a
 *     Behörde names it. A project name is an internal label; an Einreichung is
 *     about an address, and two projects in one office may share a name.
 *   - **Bundesland** (`bundesland`, intake A2_land) — the jurisdiction. Each
 *     Bundesland declares its own edition of the OIB-Richtlinien verbindlich
 *     and has its own Bauordnung (`skills/builtin/oib/brandschutz/SKILL.md`
 *     says the edition binds), so a compliance statement without it is not
 *     checkable — the reader cannot tell which law it was checked against.
 *   - **Gebäudeklasse** — the classification nearly everything hangs off.
 *     `lib/oib/applicable-standards.ts` derives which Richtlinien apply from
 *     it, and the brandschutz skill opens with "nearly every requirement in
 *     OIB Richtlinie 2 hangs off the Gebäudeklasse". A fire-resistance class
 *     printed without it is "a number with no claim attached to it".
 *   - **Erstellt am** — when. Already carried by the .docx.
 *   - **Erstellt von** — {@link AI_GENERATOR_NAME}, the same name the file's
 *     `Creator` field carries. The honest answer to the authorship question,
 *     and it makes the printed page and the metadata agree. The commissioning
 *     human is deliberately NOT named: on a document nobody has reviewed, a
 *     person's name in this row reads as a Verfasser claim, which is exactly
 *     what „nicht geprüft" says is not true yet.
 *   - **Analyse-ID** — the run, monospace. The only string that ties this page
 *     back to the run, to the `document.generated` audit event and to the
 *     `AIRunId` keyword in the file's own metadata. „Prüfen Sie jede Angabe"
 *     needs an address to check against.
 *
 * Deliberately NOT on it, and each for a reason:
 *
 *   - **Nutzung** (`hauptnutzung`). It belongs by every other measure — it is
 *     the second axis `applicable-standards.ts` reads. It is left off because
 *     its stored values are wire tokens (`wohnen`, `produzierend`) and this
 *     repo has no label set for them: `NUTZUNGEN` in `intake-definition.ts` is
 *     a DIFFERENT, unexported vocabulary (`produktion`, `handel`, `gastro`),
 *     so printing the fact would mean inventing a third list of German words
 *     with nothing to keep it in step with the first two. „produzierend" on a
 *     Behörde document is machine vocabulary leaking into a Bauakt, which
 *     `brief-view.ts` warns about by name. Add the row when the vocabulary has
 *     one home; do not add it by writing a second one here.
 *   - **Projektphase, Katastralgemeinde, Geschosse, Fluchtniveau, Widmung** —
 *     the rest of the brief. A cover identifies; it does not summarise. The
 *     brief is a page in the app and a section of no document.
 *   - **The organization's name or mark.** This is a report, not a letterhead.
 */
const COVER_FACT_PLACEHOLDER = '—'

/**
 * A confirmed fact from the project brief, as the app itself words it.
 *
 * Read through `buildProjectBriefView` rather than off `profile.facts`
 * directly, so the cover sheet and the Overview's Project Brief cannot disagree
 * about what „wien" is called: that builder resolves option labels out of the
 * intake definition („Wien", „Außerhalb Österreichs"), and a second resolution
 * here would be a second answer to the same question.
 *
 * The em dash is what the builder prints for a fact whose value is null. It is
 * meaningful in a fact sheet the reader can see is complete, and misleading on
 * a cover sheet, where it would look like the report deliberately declined to
 * state a jurisdiction — so it is filtered rather than printed.
 */
function briefFact(
  facts: ReadonlyMap<string, string>,
  key: string
): string | undefined {
  const value = facts.get(key)?.trim()
  if (!value || value === COVER_FACT_PLACEHOLDER) return undefined
  return value
}

/**
 * The cover block's rows.
 *
 * `answer-document.ts`'s rule holds unchanged and is the reason every row below
 * is its own `if`: **a field that has no value produces no line.** A report
 * filed from a project with no Bundesland must not print „Bundesland" with
 * nothing after it, because a reader away from the app cannot tell that apart
 * from a claim that there is none.
 */
function coverRows(
  projectName: string | undefined,
  profile: unknown,
  createdAt: Date,
  runId: string,
  t: Translator,
  locale: Locale
): PdfFactRow[] {
  const rows: PdfFactRow[] = []
  if (projectName?.trim()) rows.push({ label: t('project'), value: projectName.trim() })

  const brief = buildProjectBriefView(profile ?? {})
  const facts = new Map(
    brief.groups.flatMap((group) => group.facts.map((fact) => [fact.key, fact.value] as const))
  )

  const location = briefFact(facts, 'standort_adresse')
  if (location) rows.push({ label: t('reportCover.location'), value: location })

  const bundesland = briefFact(facts, 'bundesland')
  if (bundesland) rows.push({ label: t('reportCover.bundesland'), value: bundesland })

  // `fields.gebaeudeklasse` and not a new key: the .docx already labels this
  // exact fact on a card, and two names for the Gebäudeklasse across the two
  // documents an architect puts side by side is the drift `answerExport` exists
  // to prevent.
  const gebaeudeklasse = briefFact(facts, 'gebaeudeklasse')
  if (gebaeudeklasse) rows.push({ label: t('fields.gebaeudeklasse'), value: gebaeudeklasse })

  rows.push({
    label: t('createdAt'),
    value: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(createdAt),
  })
  rows.push({ label: t('reportCover.author'), value: AI_GENERATOR_NAME })
  // `mono` because a run id is transcribed, not read — see `PdfFactRow.mono`
  // and the design language's "monospace for identifiers".
  rows.push({ label: t('reportCover.analysisId'), value: runId, mono: true })

  return rows
}

/**
 * The project's brief, or nothing.
 *
 * A SECOND read of the row `fileGeneratedDocument` already loaded, and that is
 * deliberate: `GeneratedRenderContext` carries the project's name because the
 * service needed the name anyway, and widening it to hand every future producer
 * a whole profile is the service's decision to make, not this producer's.
 *
 * Failure is swallowed, which nothing else in this file does. The cover block
 * is ADDED MATTER: a database blip while reading a Gebäudeklasse must not cost
 * the user the filing of a report a multi-minute run just produced. The report
 * still files, with a cover that states what it could confirm.
 */
async function loadProfile(projectId: string, organizationId: string): Promise<unknown> {
  try {
    const project = await findProjectInOrg(projectId, organizationId)
    return project?.profile ?? null
  } catch (error) {
    console.error('[documents] could not read the project profile for a report cover', {
      projectId,
      cause: error instanceof Error ? error.name : 'unknown',
    })
    return null
  }
}

/**
 * Render a finished run's report and file it into the project.
 *
 * Both provenance options are set HERE, and they are independent by design: the
 * printed *"KI-generiert — nicht geprüft"* block on page one (`notice`) is what
 * a person reads, and the document metadata (`aiProvenance`) is what a records
 * system detects without OCR. A caller that sets one and not the other ships a
 * document that is marked for exactly one of its two audiences — so this caller
 * owns passing both, and this is the comment that says so.
 *
 * The notice's words come from `answerExport.aiNotice.*` — the SAME keys the
 * .docx export reads. There is one German sentence saying this and one English
 * one, and a format that spelled out its own copy would be a second sentence
 * with the same job, drifting from the first with nothing to catch it.
 */
export async function fileResearchReport(
  input: FileResearchReportInput,
): Promise<FiledGeneratedDocument> {
  const { session, projectId, runId, report, cards, request } = input
  const { title, body } = splitReportTitle(report)
  const [t, locale] = await Promise.all([getTranslations('answerExport'), getLocale()])
  const documentTitle = title ?? t('documentTitle')

  return fileGeneratedDocument({
    session,
    projectId,
    producer: 'deep_research',
    // The backend async job id. `deep_research` is declared in
    // `GENERATED_DOCUMENT_PRODUCER_REF_KINDS` as filing under `agent_run`, so
    // the row and the audit target say so without this caller asserting it.
    ref: runId,
    title: documentTitle,
    request,
    render: async ({ projectName }) => {
      const profile = await loadProfile(projectId, session.organizationId)
      // `renderMarkdownPdf` refuses a body over `MAX_MARKDOWN_PDF_CHARS` and
      // this call does NOT catch that, deliberately. Three things follow, and
      // they are the whole of what happens when a report is too long:
      //
      //   1. Nothing is filed and nothing is left behind. `fileGeneratedDocument`
      //      calls `render` before it creates the folder, PUTs the object or
      //      inserts the row, so a throwing renderer leaves no half-filed
      //      document — the ordering its own comment calls out.
      //   2. The user still gets the report. It is a chat answer first and a
      //      document second; filing is the second thing that happens to it,
      //      and `fileReportIfCommissioned` swallows this failure exactly as it
      //      swallows a quota refusal, so the answer they waited minutes for is
      //      never at risk from the filing.
      //   3. The reader is TOLD. This lands in the `status: 'failed'` arm of
      //      `fileReportIfCommissioned`, so the report response carries
      //      `filingFailed: true` — the promise the starting banner made
      //      („wird abgelegt") was made and broken, and that is the one case
      //      that key exists for. No reason travels with it, deliberately: a
      //      quota refusal, a revoked permission and a report too long to
      //      render are one fact to an architect — the document is not there.
      //      The length and the limit are on the error, and the error is in the
      //      log the operator reads.
      //
      // Not pre-checked here even though the length is known before the
      // permission read and the two lookups it would save. The bound is the
      // renderer's invariant, and a caller that re-states it is a caller that
      // can re-state it wrongly — which is precisely how this path came to have
      // no bound while `POST /api/generate-pdf` had one.
      const bytes = await renderMarkdownPdf(body, {
        title: documentTitle,
        // The writer agent is not taught mermaid, but a skill scope does not
        // stop a model from writing a fence — and when it does, the thread
        // draws a picture while this document would otherwise print
        // `flowchart TD` in a grey box. Same dictionary, same locale as every
        // other word on the page.
        diagramPlaceholder: t('diagramPlaceholder'),
        notice: { title: t('aiNotice.title'), body: t('aiNotice.body') },
        // The title moves OUT of the markdown and onto the cover block, so the
        // document's own name and the facts identifying it are one thing rather
        // than a heading followed by two loose paragraphs. The notice is still
        // rendered above it — that order lives in `MarkdownPDF` and not in this
        // call, so no caller can reorder the marking away.
        header: {
          title: documentTitle,
          rows: coverRows(
            projectName,
            profile,
            // The instant the report is filed. Unlike a saved answer — which
            // has its own older `createdAt` and must not be re-dated by a
            // download — this document comes into existence now, and the run
            // that produced it finished moments ago.
            new Date(),
            runId,
            t,
            locale
          ),
        },
        // Appended AFTER the markdown, deliberately. The writer agent's report
        // ends with its own „Quellen" section — `citation_verification
        // .sanitize_report` normalises the heading, strips body URLs, drops
        // shortened and unsafe ones and renumbers what survives — and that
        // section is the report's text, not this export's. Cutting the
        // markdown open to slot a section in front of it would mean a second
        // parser for a shape the backend already owns, and a re-serialised
        // source list that has lost the `[KB]`/`[Web]`/`[RIS]` origin tokens
        // the sanitizer put there. So the citations the answer was BUILT on go
        // at the back, as the apparatus they are, and the sources it cites
        // stay exactly where the sanitizer left them.
        sections: legalBasisSection(cards, t),
        aiProvenance: { runId },
      })
      return { bytes, contentType: PDF_MEDIA_TYPE }
    },
  })
}
