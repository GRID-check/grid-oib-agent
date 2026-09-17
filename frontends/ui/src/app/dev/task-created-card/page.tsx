'use client'

/**
 * Dev preview — the `task_created` card, in the shapes a delegation arrives in.
 *
 *  1. **The usual one.** A deadline the person named and a thread the run is
 *     writing into: the two facts the card can offer beyond „angelegt". Its one
 *     control is a link, and where that link GOES is the thing this page exists
 *     to make visible — hover it and the status bar reads
 *     `/app/chat?session=…`, the URL the app actually resolves. It read
 *     `/chat/<id>` for as long as the card existed, which routed nowhere.
 *  2. **Nothing but the task.** No deadline was named and the run's conversation
 *     could not be created, so the meta line is two words and there is no link
 *     at all. The card must still read as a card rather than as one that failed
 *     to finish loading — that is the whole judgement here.
 *  3. **The long one.** A title and a goal that outrun the card. The title
 *     truncates on its own line — it is a name, and half a name is still a
 *     name — while the goal wraps, because it is the reader's own sentence and
 *     cutting it would lose the request. Neither pushes the meta line out of
 *     shape.
 *  4. **The other three kinds**, because the kind is the only word on the card
 *     that changes what the reader thinks was delegated: Normprüfung, Dokument
 *     and — the one that arrives from a Freigabe rather than from a sentence —
 *     Überarbeitung.
 *
 * Pure: the card fetches nothing and holds no store state, so there is no shim.
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`) because the
 * copy under review is the German copy. 404s outside development.
 */

import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { TaskCreatedCard } from '@/features/grid-cards/components/TaskCreatedCard'

function Panel({
  title,
  note,
  children,
}: {
  title: string
  note: string
  children: React.ReactNode
}) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

export default function TaskCreatedCardPreview(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="task-created-card-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        <Panel
          title="Auftrag mit Frist und laufendem Gespräch"
          note="Die Form, in der ein Auftrag meistens ankommt. „läuft“ ist der wichtigste Text auf der Karte — die Antwort daneben darf nicht so klingen, als sei die Arbeit getan. „Unterhaltung öffnen“ ist ein echter Link auf den Gesprächsverlauf, den der Auftrag schreibt."
        >
          <TaskCreatedCard
            taskId="00000000-0000-4000-8000-0000000000f1"
            kind="einreichcheck"
            title="Einreichcheck: Bauansuchen Haus A"
            goal="Mach den Einreichcheck für das Bauansuchen bis Freitag"
            dueAt="2026-09-18T23:59:59.999Z"
            conversationId="s_00000000_0000_4000_8000_0000000000f2"
          />
        </Panel>

        <Panel
          title="Ohne Frist, ohne Gespräch"
          note="Niemand hat eine Frist genannt, und das Gespräch für den Lauf konnte nicht angelegt werden. Die Karte behauptet dann nichts davon: zwei Wörter in der Meta-Zeile, kein Link. Sie muss trotzdem wie eine fertige Karte aussehen und nicht wie eine, die nicht zu Ende geladen hat."
        >
          <TaskCreatedCard
            taskId="00000000-0000-4000-8000-0000000000f3"
            kind="compliance_check"
            title="Normprüfung: Fluchtwege Bauteil B"
            goal="Prüf die Fluchtwege in Bauteil B gegen OIB 2"
            dueAt={null}
            conversationId={null}
          />
        </Panel>

        <Panel
          title="Titel und Auftrag, die über die Karte hinausgehen"
          note="Der Titel ist der Name, den der Auftrag in der Liste trägt; darunter steht der Satz der Person. Der Titel kürzt auf einer Zeile, der Satz bricht um — und die Meta-Zeile darunter bleibt in Form."
        >
          <TaskCreatedCard
            taskId="00000000-0000-4000-8000-0000000000f4"
            kind="document"
            title="Aktenvermerk zur Abweichung der Fluchtweglänge im 2. Obergeschoss, Bauteil B, Haus A"
            goal="Schreib mir einen Aktenvermerk zur Abweichung der Fluchtweglänge im 2. Obergeschoss von Bauteil B und nimm die Tabelle aus dem Brandschutzkonzept mit"
            dueAt="2026-09-30T23:59:59.999Z"
            conversationId="s_00000000_0000_4000_8000_0000000000f5"
          />
        </Panel>

        <Panel
          title="Überarbeitung"
          note="Die eine Art, die nicht aus einem Satz im Chat entsteht, sondern aus einer Freigabe: „Piloti überarbeiten lassen“ in der Dateiablage legt sie an. Der Auftrag benennt die Fassung, um die es geht."
        >
          <TaskCreatedCard
            taskId="00000000-0000-4000-8000-0000000000f6"
            kind="revision"
            title="Überarbeitung: Brandschutzkonzept Haus A, Fassung 2"
            goal="Die Fluchtweglänge im 2. Obergeschoss fehlt, und Tabelle 3 nennt noch die alte Gebäudeklasse."
            dueAt="2026-09-15T23:59:59.999Z"
            conversationId="s_00000000_0000_4000_8000_0000000000f7"
          />
        </Panel>
      </div>
    </I18nProvider>
  )
}
