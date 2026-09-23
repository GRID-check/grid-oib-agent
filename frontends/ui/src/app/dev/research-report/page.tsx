'use client'

/**
 * Dev preview for what a reader steers a deep research with, and what it hands
 * back: the Rechercheplan checklist (its document step opens the picker, which
 * lists nothing here: nothing is fetched; `/dev/run-plan` routes a listing),
 * and the report's
 * Befundmatrix in both of its forms — a table that judged (Befunde, with a
 * status per row) and one that only compared (Ergebnisse, no status column).
 *
 * The REAL components over fixtures; nothing is fetched. Not linked from
 * anywhere; 404s outside development. Pinned to German, the copy that ships.
 */

import { useState, type ReactNode } from 'react'
import { notFound } from 'next/navigation'

import { FindingsMatrix } from '@/features/chat/components/FindingsMatrix'
import { PlanChecklist, type PlanShape } from '@/features/runs/components/PlanChecklist'
import { I18nProvider } from '@/i18n'
import type { Findings } from '@/lib/conversations/message-findings'
import type { PlanDocument } from '@/lib/runs/plan-documents'

const UNTERLAGEN: PlanDocument[] = [
  { name: 'Einreichplan_EG.pdf', title: 'Einreichplan Erdgeschoß', shelf: 'project' },
  { name: 'Brandschutzkonzept_v3.pdf', title: 'Brandschutzkonzept, Stand 3', shelf: 'project' },
  { name: 'Baubeschreibung.docx', shelf: 'project' },
  { name: 'Stellungnahme_MA37_alt.pdf', title: 'Stellungnahme MA 37 (überholt)', shelf: 'project' },
  { name: 'Musterbrandschutzkonzept.pdf', shelf: 'archiv' },
]

const PLAN: PlanShape = {
  title: 'Brandschutz Wohnhausanlage Seestadt, Bauteil B',
  sections: [
    'Rechtsrahmen und Gebäudeklasse',
    'Fluchtwege',
    'Brandabschnitte',
    'Tragende Bauteile',
  ],
  genre: 'pruefbericht',
  depth: 'kurzpruefung',
  grundlage: ['Brandschutzkonzept_v3.pdf', 'Einreichplan_EG.pdf'],
  ausgeschlossen: ['Stellungnahme_MA37_alt.pdf'],
  nurGrundlage: false,
  unterlagen: UNTERLAGEN,
}

const JUDGED: Findings = {
  v: 1,
  items: [
    {
      requirement: 'Feuerwiderstand tragender Bauteile',
      value: 'REI 60',
      status: 'erfuellt',
      grounding: 'belegt',
      reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', page: 12 },
      citations: [1],
      comment: 'Gilt für GK 4; im Kellergeschoß REI 90.',
    },
    {
      requirement: 'Fluchtweglänge zum Treppenhaus',
      value: '38 m',
      status: 'nicht_erfuellt',
      grounding: 'belegt',
      reference: { document: 'OIB-Richtlinie 2', section: '5.1.1' },
      citations: [2],
      comment:
        'Zulässig sind 40 m ab der Wohnungseingangstür; gemessen wurde ab dem Aufenthaltsraum.',
    },
    { requirement: 'Zweiter Fluchtweg', status: 'offen', grounding: 'offen', citations: [] },
  ],
}

const COMPARED: Findings = {
  v: 1,
  items: [
    { requirement: 'Variante A — Außentreppe', value: '12 m', grounding: 'belegt', citations: [1] },
    {
      requirement: 'Variante B — zweites Treppenhaus',
      value: '15 m',
      grounding: 'belegt',
      citations: [2],
    },
  ],
}

const Section = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">{label}</h2>
    {children}
  </section>
)

export default function ResearchReportPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const [plan, setPlan] = useState<PlanShape>(PLAN)

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main
        data-testid="research-report-preview"
        className="text-foreground mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-8"
      >
        <header>
          <h1 className="text-xl font-semibold tracking-tight">
            Tiefenrecherche: Plan, Unterlagen, Befunde
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Was die Leserin vor dem Lauf festlegt, und was der Bericht zurückgibt.
          </p>
        </header>

        <Section label="Rechercheplan — Abschnitte, Genre, Tiefe, Unterlagen">
          <PlanChecklist plan={plan} onChange={setPlan} />
        </Section>

        <Section label="Befundmatrix — ein Bericht, der prüft">
          <FindingsMatrix findings={JUDGED} anchorPrefix="src-" />
        </Section>

        <Section label="Ergebnisse — ein Vergleich ohne Urteil">
          <FindingsMatrix findings={COMPARED} anchorPrefix="src-" />
        </Section>
      </main>
    </I18nProvider>
  )
}
