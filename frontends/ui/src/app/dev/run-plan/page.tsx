'use client'

/**
 * Dev preview for the plan on the run block (ADR-0065) — the REAL `RunPlan`
 * in the four states a plan passes through:
 *
 *   1. proposed: the one-line summary and the countdown; the reader owes
 *      nothing, and the run starts on its own,
 *   2. held: „Anpassen" pressed, the plan open as controls, „Starten",
 *   3. approved: a plan the reader wrote, starting in a moment,
 *   4. started: the brief the run is running, read-only.
 *
 * Fetch-free: the actions update local state, so every block is clickable in
 * dev. Not linked from anywhere; 404s outside development. Pinned to German,
 * the product's primary language, so a capture carries the copy that ships.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'

import { RunPlan } from '@/features/runs/components/RunPlan'
import { I18nProvider } from '@/i18n'
import type { ResearchPlan, ResearchPlanEdit } from '@/lib/plans/plan-types'

const NOW = Date.now()

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
    'Abweichungen und Kompensation',
  ],
  genre: 'pruefbericht',
  depth: 'gutachten',
  grundlage: [{ name: 'Einreichplan_EG.pdf', title: 'Einreichplan EG', shelf: 'project' }],
  ausgeschlossen: [],
  dataSources: ['knowledge_base'],
  unterlagen: [
    { name: 'Einreichplan_EG.pdf', title: 'Einreichplan EG', shelf: 'project' },
    { name: 'Brandschutzkonzept_v2.pdf', shelf: 'project' },
    { name: 'OIB-RL 2 Leitfaden.pdf', title: 'Leitfaden OIB 2', shelf: 'archiv' },
  ],
  startsAt: new Date(NOW + 42_000).toISOString(),
  heldAt: null,
  approvedAt: null,
  startedAt: null,
  createdAt: new Date(NOW).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
}

const Block = ({ label, initial }: { label: string; initial: ResearchPlan }) => {
  const [plan, setPlan] = useState(initial)
  const edit = (next: ResearchPlanEdit) =>
    setPlan((current) => ({
      ...current,
      ...(next.sections ? { sections: next.sections } : {}),
      ...(next.genre ? { genre: next.genre } : {}),
      ...(next.depth ? { depth: next.depth } : {}),
      ...(next.grundlage
        ? { grundlage: current.unterlagen.filter((doc) => next.grundlage?.includes(doc.name)) }
        : {}),
      ...(next.ausgeschlossen
        ? { ausgeschlossen: current.unterlagen.filter((doc) => next.ausgeschlossen?.includes(doc.name)) }
        : {}),
      ...(current.status === 'proposed' ? { status: 'held', startsAt: null } : {}),
    }))
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
      <div className="rounded-lg border border-border bg-card" data-testid="dev-run-plan">
        <RunPlan
          plan={plan}
          rahmen={{ labels: ['Wissensbasis'] }}
          onEdit={edit}
          onHold={() => setPlan((current) => ({ ...current, status: 'held', startsAt: null }))}
          onStart={() => setPlan((current) => ({ ...current, status: 'approved', startsAt: null }))}
        />
      </div>
    </section>
  )
}

export default function RunPlanPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 text-foreground md:p-8">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Rechercheplan am Laufblock</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Der Plan wartet am Auftrag, nicht als Frage im Verlauf. Nichts tun startet ihn.
          </p>
        </header>
        <Block label="1 · Vorgeschlagen, zählt herunter" initial={BASE} />
        <Block label="2 · Angehalten zum Anpassen" initial={{ ...BASE, status: 'held', startsAt: null }} />
        <Block
          label="3 · Eigener Plan, freigegeben"
          initial={{ ...BASE, author: 'user', status: 'approved', startsAt: null }}
        />
        <Block label="4 · Gestartet" initial={{ ...BASE, status: 'started', startsAt: null }} />
      </main>
    </I18nProvider>
  )
}
