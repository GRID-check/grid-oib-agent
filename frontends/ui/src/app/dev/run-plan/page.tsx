'use client'

/**
 * Dev preview for the research plan (ADR-0065) — the REAL `RunPlan` in the
 * states a plan passes through, and the REAL „Recherche planen" dialog:
 *
 *   1. proposed: the brief and the countdown; the reader owes nothing, and
 *      the run starts on its own,
 *   2. held: „Anpassen" pressed, the plan open as its three steps with the
 *      optional „Was Piloti liest", „Starten",
 *   3. a plan confined to its documents („Nur diese"), approved,
 *   4. started: the brief the run is running, read-only.
 *
 * Fetch-free for the blocks: edits go through `applyPlanEdit`, the client's
 * own guess of the BFF's answer, so every block is clickable in dev. The
 * document picker lists the project's documents from `/api/documents`, which
 * answers nothing here, so the picker is empty unless a capture routes the
 * listing (and `/api/documents/{id}/thumbnail` for the page images). Not linked from anywhere; 404s outside
 * development. Pinned to German, the product's primary language, so a
 * capture carries the copy that ships.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { PlanDialog } from '@/features/runs/components/PlanDialog'
import { RunPlan } from '@/features/runs/components/RunPlan'
import { I18nProvider } from '@/i18n'
import { applyPlanEdit } from '@/lib/plans/plan-edit'
import type { ResearchPlan } from '@/lib/plans/plan-types'

const NOW = Date.now()

const UNTERLAGEN = [
  { name: 'Einreichplan_EG.pdf', title: 'Einreichplan EG', shelf: 'project' },
  { name: 'Einreichplan_OG1.pdf', title: 'Einreichplan 1. OG', shelf: 'project' },
  { name: 'Brandschutzkonzept_v2.pdf', title: 'Brandschutzkonzept v2', shelf: 'project' },
  { name: 'Brandschutzkonzept_v1.pdf', title: 'Brandschutzkonzept v1 (überholt)', shelf: 'project' },
  { name: 'Raumbuch.xlsx', shelf: 'project' },
  { name: 'Architekturmodell.ifc', title: 'Architekturmodell (IFC)', shelf: 'project' },
  { name: 'OIB-RL 2 Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv' },
  { name: 'Musterstellungnahme_Brandschutz.docx', title: 'Musterstellungnahme Brandschutz', shelf: 'archiv' },
]

const BASE: ResearchPlan = {
  id: 'plan-dev',
  projectId: 'proj-dev',
  conversationId: 's_dev',
  runId: 'run-dev',
  author: 'agent',
  status: 'proposed',
  question: 'Welche Brandschutzanforderungen gelten für Gebäudeklasse 4 in Wien?',
  title: 'Brandschutzanforderungen für Gebäudeklasse 4 in Wien',
  sections: [
    'Rechtsrahmen und Gebäudeklasse',
    'Anforderungen an Fluchtwege',
    'Brandabschnitte und Bauteile',
    'Rauchableitung im Stiegenhaus',
    'Abweichungen und Kompensation',
    'Befunde und offene Punkte',
  ],
  genre: 'pruefbericht',
  depth: 'gutachten',
  grundlage: [UNTERLAGEN[0], UNTERLAGEN[6]],
  ausgeschlossen: [UNTERLAGEN[3]],
  nurGrundlage: false,
  dataSources: ['knowledge_base'],
  unterlagen: UNTERLAGEN,
  startsAt: new Date(NOW + 42_000).toISOString(),
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
}

const Block = ({ label, initial, testId }: { label: string; initial: ResearchPlan; testId: string }) => {
  const [plan, setPlan] = useState(initial)
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
      <div className="rounded-lg border border-border bg-card" data-testid="dev-run-plan">
        <RunPlan
          plan={plan}
          projectId="proj-dev"
          rahmen={{ labels: ['Wissensbasis', 'Projektunterlagen'] }}
          onEdit={(edit) => setPlan((current) => applyPlanEdit(current, edit))}
          onHold={() => setPlan((current) => ({ ...current, status: 'held', startsAt: null }))}
          onStart={() => setPlan((current) => ({ ...current, status: 'approved', startsAt: null }))}
        />
      </div>
    </section>
  )
}

export default function RunPlanPreviewPage() {
  const [dialog, setDialog] = useState(false)
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 text-foreground md:p-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Rechercheplan am Laufblock</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Der Plan wartet am Auftrag, nicht als Frage im Verlauf. Nichts tun startet ihn.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setDialog(true)} data-testid="dev-open-plan-dialog">
            Recherche planen
          </Button>
        </header>
        <Block testId="dev-proposed" label="1 · Vorgeschlagen, zählt herunter" initial={BASE} />
        <Block
          testId="dev-held"
          label="2 · Angehalten zum Anpassen"
          initial={{ ...BASE, status: 'held', startsAt: null, heldAt: new Date(NOW).toISOString() }}
        />
        <Block
          testId="dev-only"
          label="3 · Eigener Plan, nur diese Unterlagen, freigegeben"
          initial={{
            ...BASE,
            author: 'user',
            status: 'approved',
            startsAt: null,
            nurGrundlage: true,
            grundlage: [UNTERLAGEN[0], UNTERLAGEN[1], UNTERLAGEN[2]],
            ausgeschlossen: [],
          }}
        />
        <Block testId="dev-started" label="4 · Gestartet" initial={{ ...BASE, status: 'started', startsAt: null }} />
        <PlanDialog open={dialog} onOpenChange={setDialog} projectId="proj-dev" conversationId="s_dev" />
      </main>
    </I18nProvider>
  )
}
