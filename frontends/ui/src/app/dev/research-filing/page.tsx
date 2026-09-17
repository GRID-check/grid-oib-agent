'use client'

/**
 * Dev preview for the deep-research banner's filing surfaces — the two moments
 * a person is told that Piloti is about to write, and then has written, a file
 * into their project.
 *
 * Four panels, in the order they happen:
 *
 *  1. `starting`, inside a project — the DISCLOSURE. One quiet line naming the
 *     destination, on the banner that is on screen while the run can still be
 *     stopped. This is the whole of the authorization: deep research has no
 *     submit form to carry it, and there is deliberately no modal, because a
 *     dialog asked after the run is only ever answered yes.
 *  2. `starting` after an ESCALATION — the same disclosure under the narration
 *     that says the agent, not the reader, decided this run should happen.
 *     The pair is the point: when „the user asked for a report" is not even
 *     true, the destination line is the only thing standing between the reader
 *     and a file appearing in a folder nobody mentioned.
 *  3. `success` with a filed document — the report named by its real filename
 *     and two actions that go to two different places: `Bericht anzeigen`
 *     opens the research panel, `Im Projekt öffnen` opens the file in the
 *     project through the same `/files?doc=` deep link every other document
 *     surface uses.
 *  4. `success` with NOTHING filed and nothing promised — a run that predates
 *     the feature, or one whose chat was never in a project. The banner says
 *     nothing at all about a file. Panels 3 and 4 side by side are the evidence
 *     for the rule: never claim a file that does not exist.
 *  5. `success` after a filing that was PROMISED and then failed — the case
 *     panel 4 used to swallow. The disclosure in panel 1 was on screen, so this
 *     reader is on their way to Berichte for a document that is not there. One
 *     muted line takes the promise back, in the register it was made in: the
 *     same `text-subtle text-xs` slot, the same `success` variant (the research
 *     did succeed), no red, no icon, no reason. Panels 4 and 5 are the whole
 *     distinction — absence is silent, a broken promise is not.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`) because the
 * copy under review is the German copy. The banner reads the active project off
 * the chat store — it is a fact about where the chat is, not about the message —
 * so the fixture puts one there before anything renders.
 */

import { I18nProvider } from '@/i18n'
import { DeepResearchBanner } from '@/features/chat/components'
import { useChatStore } from '@/features/chat/store'

/**
 * The chat these banners are sitting in. Set at module scope so the first
 * render already has it: `projectId` is not persisted (it is not in the store's
 * `partialize`), so nothing here survives into a real session.
 */
if (typeof window !== 'undefined') {
  useChatStore.setState({ projectId: 'proj-demo' })
}

/**
 * A filename this code can actually produce, not one that merely looks like it.
 *
 * Every character of it is what `generatedFilename` (`lib/documents/generated.ts`)
 * returns for the title „Fluchtweglängen GK 4" filed on 2026-08-20:
 *
 *  - `.pdf`, because the extension is derived from the CONTENT TYPE
 *    (`EXTENSION_BY_CONTENT_TYPE`) and a filed report is `application/pdf`. It
 *    read `.docx` here for a while — a format Piloti does not file, and a
 *    reviewer who read this page came away believing the feature writes Word
 *    files. The `.docx` in this product is the saved-answer export, which is a
 *    different document with a different job.
 *  - `fluchtweglangen`, not `fluchtweglaengen`: the slug is NFKD-normalised and
 *    stripped of combining marks, so `ä` becomes `a`. Only `ß` is spelled out,
 *    because it has no decomposition and would otherwise vanish mid-word.
 *  - `gk-4`, not `gk4`: every run of non-alphanumerics collapses to one hyphen.
 */
const FILED = { documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf' }

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground max-w-2xl text-xs">{note}</p>
      <div className="max-w-2xl rounded-xl border p-4">{children}</div>
    </section>
  )
}

export default function ResearchFilingPreviewPage(): JSX.Element {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6" data-testid="research-filing-preview">
        <div>
          <h1 className="text-lg font-semibold">Bericht wird abgelegt — was gesagt wird, und wann</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Die Offenlegung steht auf dem Start-Banner, weil das der einzige Moment ist, in dem sie
            etwas wert ist: Der Lauf lässt sich noch abbrechen. Kein Dialog, keine Rückfrage.
          </p>
        </div>

        <Panel
          title="1 — Start, im Projekt"
          note="Die eine leise Zeile, die den Ablageort nennt, bevor die Datei existiert."
        >
          <DeepResearchBanner bannerType="starting" jobId="job-1" />
        </Panel>

        <Panel
          title="2 — Start, nach automatischer Eskalation"
          note="Der Lauf beginnt, weil der Agent selbst eskaliert hat — nicht, weil jemand einen Bericht bestellt hat. Genau dann trägt die Zeile darunter die ganze Last."
        >
          <DeepResearchBanner
            bannerType="starting"
            jobId="job-2"
            escalationReason="Die Kurzrecherche hat die Frage nicht belegt beantwortet."
          />
        </Panel>

        <Panel
          title="3 — Fertig, abgelegt"
          note="Zwei Aktionen, zwei Orte: Recherchebereich und Projektablage. Die Datei wird beim Namen genannt."
        >
          <DeepResearchBanner
            bannerType="success"
            jobId="job-3"
            toolCallCount={14}
            filedDocument={FILED}
          />
        </Panel>

        <Panel
          title="4 — Fertig, nichts zugesagt"
          note="Chat ohne Projekt oder Lauf von vor dieser Funktion: Es wurde nie etwas zugesagt. Das Banner behauptet keine Datei — es schweigt."
        >
          <DeepResearchBanner bannerType="success" jobId="job-4" toolCallCount={14} />
        </Panel>

        <Panel
          title="5 — Fertig, zugesagt und nicht abgelegt"
          note="Die Zusage aus Panel 1 stand auf dem Bildschirm, die Ablage ist gescheitert (Kontingent, entzogene Berechtigung, zu langer Bericht). Eine leise Zeile nimmt sie zurück — gleiche Schriftgröße, gleiche Farbe, kein Fehlerzustand, kein Grund."
        >
          <DeepResearchBanner
            bannerType="success"
            jobId="job-5"
            toolCallCount={14}
            filingFailed
          />
        </Panel>
      </main>
    </I18nProvider>
  )
}
