'use client'

/**
 * Dev preview — the Aufgaben list, in the states a project's delegated work
 * actually arrives in.
 *
 *  1. **A mixed list.** What a project that uses Piloti looks like after a
 *     fortnight: something running, something waiting for a person, something
 *     that was sent back with words, something that failed. What the shot is
 *     for is the CARD — the status swatch on the title line (the same rounded
 *     square the timetable's legend uses), the unreviewed dot, the recency
 *     headings that group the column, the filter row with its counts, and the
 *     one result link on the tray that is the only thing inside the card that
 *     is not the card's own click target.
 *  2. **Nothing yet.** The state most projects are in on day one, and the one
 *     that has to read as an invitation rather than as a list that failed to
 *     load — the distinction the error panel underneath it depends on.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { TaskList } from '@/features/tasks/components/task-list'
import type { TaskFilter, TaskWireRow } from '@/features/tasks/lib/task-view'

const row = (overrides: Partial<TaskWireRow>): TaskWireRow => ({
  id: 'task-0',
  kind: 'document',
  title: 'Aktenvermerk',
  goal: null,
  status: 'succeeded',
  review: null,
  reviewReason: null,
  filedDocumentId: null,
  conversationId: null,
  runMessageId: null,
  backendJobId: null,
  trigger: 'delegated',
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  finishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  error: null,
  ...overrides,
})

const TASKS: TaskWireRow[] = [
  row({
    id: 'task-1',
    kind: 'revision',
    title: 'Brandschutzkonzept — Fluchtwege, zweite Fassung',
    goal: 'Die Fluchtweglänge im Atrium stimmt nicht; OIB 2.3 gilt hier, nicht 2.',
    status: 'running',
    requesterName: 'Maria Huber',
  }),
  row({
    id: 'task-1b',
    kind: 'deep-research',
    title: 'Wöchentlicher OIB-Brandschutz-Scan',
    goal: null,
    trigger: 'schedule',
    backendJobId: 'bj-77',
    requesterName: null,
  }),
  row({
    id: 'task-2',
    kind: 'document',
    title: 'Aktenvermerk Stellplatzverpflichtung',
    goal: 'Fasse zusammen, was für die Einreichung an Stellplätzen nachzuweisen ist',
    filedDocumentId: 'doc-9',
    review: 'accepted',
  }),
  row({
    id: 'task-3',
    kind: 'einreichcheck',
    title: 'Einreichcheck vor Abgabe',
    goal: 'Was fehlt noch für die Einreichung am 30.9.?',
    review: 'rejected',
    reviewReason:
      'Der Nachweis für die Barrierefreiheit ist übersehen worden — bitte mit OIB 4 gegenprüfen.',
    conversationId: 'conv-3',
    createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  }),
  row({
    id: 'task-4',
    kind: 'compliance_check',
    title: 'Normprüfung Bestandsplan',
    status: 'failed',
    error: 'Das Budget war aufgebraucht, bevor die Prüfung fertig war.',
    requesterName: null,
    createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
  }),
]

/**
 * The filter row is stateful, and a preview that pinned it to `all` would be
 * evidence of a control nobody can press. One holder per panel, so each panel
 * filters independently.
 */
function FilterableList({
  tasks,
  loading,
  failed,
}: {
  tasks: TaskWireRow[]
  loading?: boolean
  failed?: boolean
}) {
  const [filter, setFilter] = useState<TaskFilter>('all')
  return (
    <TaskList
      projectId="preview"
      tasks={tasks}
      loading={loading}
      failed={failed}
      filter={filter}
      onFilterChange={setFilter}
      onSelectTask={() => {}}
    />
  )
}

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[720px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      <div className="rounded-lg border bg-card">{children}</div>
    </section>
  )
}

export default function TaskListPreview() {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="task-list-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Was gerade läuft, und was schon beurteilt ist"
          note="Fünf Karten, fünf verschiedene Antworten auf „was ist daraus geworden“. Zu beurteilen: ob das Farbquadrat vor dem Titel beim Überfliegen einer Spalte trägt, ohne lauter zu sein als der Titel selbst; ob der Punkt rechts als „noch ungeprüft“ liest; ob „Zurückgeschickt“ und die Begründung darunter zusammengehören; und ob der eine Link in der Fußzeile als Ort liest — er ist das Einzige in der Karte, das nicht die Karte selbst anklickt."
        >
          <FilterableList tasks={TASKS} />
        </Panel>

        <Panel
          title="Noch nichts übergeben"
          note="Der Zustand am ersten Tag. Er muss als Einladung lesen, nicht als Liste, die nicht geladen hat — genau diesen Unterschied trägt der Fehlerzustand darunter."
        >
          <FilterableList tasks={[]} />
        </Panel>

        <Panel
          title="Die Liste konnte nicht geladen werden"
          note="Der Unterschied zum Zustand darüber ist die eine Lüge, auf die jemand hin handeln würde."
        >
          <FilterableList tasks={[]} failed />
        </Panel>
      </div>
    </I18nProvider>
  )
}
