'use client'

/**
 * Dev preview — the Aufgaben list, in the states a project's delegated work
 * actually arrives in.
 *
 *  1. **A mixed list.** What a project that uses Piloti looks like after a
 *     fortnight: something running, something waiting for a person, something
 *     that was sent back with words, something that failed. What the shot is
 *     for is the ROW — that the kind chip, the title, the status and the review
 *     stay on one line as the title grows, and that the two links at the foot
 *     read as places to go rather than as decoration.
 *  2. **Nothing yet.** The state most projects are in on day one, and the one
 *     that has to read as an invitation rather than as a list that failed to
 *     load — the distinction the error panel underneath it depends on.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { TaskList } from '@/features/tasks/components/task-list'
import type { TaskWireRow } from '@/features/tasks/lib/task-view'

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
  requesterUserId: 'user_anna',
  requesterName: 'Anna Berger',
  createdAt: '2026-09-08T09:12:00.000Z',
  finishedAt: '2026-09-08T09:18:00.000Z',
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
  }),
  row({
    id: 'task-4',
    kind: 'compliance_check',
    title: 'Normprüfung Bestandsplan',
    status: 'failed',
    error: 'Das Budget für diesen Lauf war aufgebraucht, bevor die Prüfung fertig war.',
    requesterName: null,
  }),
]

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
          note="Vier Zeilen, vier verschiedene Antworten auf „was ist daraus geworden“. Zu beurteilen: ob die Zeile bei einem langen Titel zusammenbleibt, ob „Zurückgeschickt“ und die Begründung darunter zusammengehören, und ob die beiden Links am Fuß als Orte lesen."
        >
          <TaskList projectId="preview" tasks={TASKS} jobs={[]} />
        </Panel>

        <Panel
          title="Noch nichts übergeben"
          note="Der Zustand am ersten Tag. Er muss als Einladung lesen, nicht als Liste, die nicht geladen hat — genau diesen Unterschied trägt der Fehlerzustand darunter."
        >
          <TaskList projectId="preview" tasks={[]} jobs={[]} />
        </Panel>

        <Panel
          title="Die Liste konnte nicht geladen werden"
          note="Der Unterschied zum Zustand darüber ist die eine Lüge, auf die jemand hin handeln würde."
        >
          <TaskList projectId="preview" tasks={[]} jobs={[]} failed />
        </Panel>
      </div>
    </I18nProvider>
  )
}
