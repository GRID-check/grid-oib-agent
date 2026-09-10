'use client'

/**
 * Dev preview — the `file_operation_proposal` card, in the states it has.
 *
 *  1. **A batch of moves.** The shape a tidying turn actually produces: „räum
 *     die Einreichunterlagen zusammen" is three `move_document` calls that
 *     land on ONE card, so what has to read well is a LIST of „von → nach"
 *     rows under one question and one pair of buttons. Judge that the rows stay
 *     legible when a file name is long, that the arrow does not wrap away from
 *     its target, and that the „Oberste Ebene" placeholder reads as a place
 *     rather than as a missing value.
 *  2. **A single rename.** The other end of the range: one row, one target, no
 *     „from" folder. A card that only composes at three rows composes at none.
 *  3. **The operation nobody can run yet.** `set_doc_class` has no
 *     project-scoped route behind it (the Dokumentart is settable only on the
 *     platform corpus), so the buttons are ABSENT and the reason stands where
 *     they would be. What the shot is for: it must read as unavailable, not as
 *     a card that failed to finish loading.
 * The two SETTLED states (applied, applied in part) are deliberately not here.
 * Each is one sentence inside `ProposalShell`, whose accepted and dismissed
 * tones are already screenshotted through `memory_proposal` in the gallery —
 * and reaching them on this page would mean firing the real routes at a dev
 * server with no session, which produces the failure state and not the state
 * under review. What they SAY is pinned in
 * `FileOperationProposalCard.spec.tsx`.
 *
 * The panels are rendered WITHOUT a `messageId`, which is what the gallery does
 * everywhere: nothing owns them, so `useCardDecision` falls back to mount-local
 * state and the buttons stay pressable for judging. Pinned to German
 * (`I18nProvider initialLocale="de" fixedLocale`): the copy under review is the
 * German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { useChatStore } from '@/features/chat/store'
import { FileOperationProposalCard } from '@/features/grid-cards/components/FileOperationProposalCard'

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

export default function FileOperationProposalCardPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()
  // Every route behind this card is project-scoped, so a card with no project
  // in the store correctly draws its reason line instead of its buttons — and
  // the buttons are what this page exists to judge.
  useChatStore.setState({ projectId: 'proj-demo' })

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="file-operation-proposal-card-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Mehrere Verschiebungen auf einer Karte"
          note="Was ein „räum die Einreichunterlagen zusammen“-Zug erzeugt: drei Aufrufe, eine Karte, eine Entscheidung. Jede Zeile sagt, wo die Datei heute liegt — sonst muss die Lesende sich das merken, um überhaupt urteilen zu können."
        >
          <FileOperationProposalCard
            title="Drei Dateien nach „Einreichung/Pläne“ verschieben"
            operation="move"
            operations={[
              {
                document: 'Grundriss EG.pdf',
                source: 'projekt',
                current: 'Nachweise',
                target_folder: 'Einreichung/Pläne',
              },
              {
                document: 'Grundriss OG.pdf',
                source: 'projekt',
                current: '',
                target_folder: 'Einreichung/Pläne',
              },
              {
                document: 'Schnitt A-A – Bestand und Neubau (Revision 3).pdf',
                source: 'projekt',
                current: 'Nachweise',
                target_folder: 'Einreichung/Pläne',
              },
            ]}
            note="Vorschlag — es wurde noch nichts verschoben."
            cardKey="file_operation_proposal-0"
          />
        </Panel>

        <Panel
          title="Eine einzelne Umbenennung"
          note="Das andere Ende des Bereichs: eine Zeile, kein „von“. Eine Karte, die erst bei drei Zeilen zusammenhält, hält bei einer nicht zusammen."
        >
          <FileOperationProposalCard
            title="Datei umbenennen"
            operation="rename"
            operations={[
              {
                document: 'scan_2026-03-11_0004.pdf',
                source: 'projekt',
                current: 'scan_2026-03-11_0004.pdf',
                new_display_name: 'Bescheid Baubewilligung',
              },
            ]}
            cardKey="file_operation_proposal-1"
          />
        </Panel>

        <Panel
          title="Vorgang ohne Route"
          note="Die Dokumentart lässt sich an Projektunterlagen (noch) nicht setzen. Der Vorschlag bleibt lesbar, die Schaltflächen fehlen, und der Grund steht dort, wo sie stünden — unbenutzbar, nicht kaputt."
        >
          <FileOperationProposalCard
            title="Dokumentart setzen"
            operation="set_doc_class"
            operations={[
              {
                document: 'Bauordnung Wien – Auszug.pdf',
                source: 'buero',
                current: 'Sonstiges Basisdokument',
                doc_class: 'gesetz',
              },
            ]}
            cardKey="file_operation_proposal-2"
          />
        </Panel>
      </div>
    </I18nProvider>
  )
}
