'use client'

/**
 * Dev preview — the Laufblock, in every state a run is shown in.
 *
 * The block is the ONE element a run is, in the thread that commissioned it,
 * and the seven states are the same block with different words in the header
 * and a different sentence below the list. What the shot is for: whether the
 * header reads as a bar of the Herleitung's family (glyph, bold word, muted
 * summary, elapsed, chevron); whether the phase rail says where the run is
 * without being read; whether the live phase reads as an analyst at work and
 * not as a log; whether a failed run states its reason and what is already
 * there in ONE quiet red line; and whether the collapsed block is small enough
 * to sit above the report it produced.
 *
 * `?variant=transition` captures the handover alone: the person's message,
 * the task-created card that acknowledges it, and the block in `angelegt`
 * directly beneath — the three things a reader sees in the first seconds after
 * „@Piloti prüf das gegen OIB 2".
 *
 * Pure: the block renders from a ledger and holds no subscription; nothing
 * here fetches. Pinned to German (`fixedLocale`) because the copy under review
 * is the German copy. 404s outside development (the `/dev` layout).
 */

import { useEffect, useMemo, useState } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { UserMessage } from '@/features/chat/components/UserMessage'
import { TaskCreatedCard } from '@/features/grid-cards/components/TaskCreatedCard'
import { RunBlock } from '@/features/runs/components/RunBlock'
import { RunBlockLine } from '@/features/runs/components/RunBlockLine'
import {
  RUN_ABGEBROCHEN,
  RUN_ANGELEGT,
  RUN_FEHLGESCHLAGEN,
  RUN_FERTIG,
  RUN_LAEUFT,
  RUN_UNTERBROCHEN,
  RUN_WARTET,
  runSequence,
} from '../_fixtures/run-ledgers'

const PROJECT = 'proj-stadthaus'
const TITLE = 'Brandschutzkonzept — Fluchtwege Haus A'
const HOURS_AGO = (h: number): string => new Date(Date.now() - h * 60 * 60 * 1000).toISOString()

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="text-xs text-muted-foreground">{note}</p>
      {children}
    </section>
  )
}

/** The handover as the thread shows it: message, acknowledgement, block. */
function Transition() {
  return (
    <div className="flex w-[680px] max-w-full flex-col gap-4" data-testid="run-block-transition">
      <UserMessage
        content="@Piloti prüf die Fluchtwege in Haus A gegen OIB 2 und die Wiener Abweichungen, bis Freitag."
        timestamp="2026-09-16T09:41:00.000Z"
      />
      <TaskCreatedCard
        taskId="00000000-0000-4000-8000-0000000000a1"
        kind="compliance_check"
        title={TITLE}
        goal="Prüf die Fluchtwege in Haus A gegen OIB 2 und die Wiener Abweichungen"
        dueAt="2026-09-18T23:59:59.999Z"
        conversationId="s_00000000_0000_4000_8000_0000000000a2"
      />
      <RunBlock ledger={RUN_ANGELEGT} title={TITLE} projectId={PROJECT} live />
    </div>
  )
}

/** How long each frame of the scripted run holds before the next one lands. */
const FRAME_MS = 1400

/**
 * The run as it actually happens: a ledger walked frame by frame on a timer,
 * so the choreography can be WATCHED. Every frame comes from the same fold
 * helpers the product uses, so nothing here is a shape a real run could not
 * produce. The frame index is on the wrapper, which is how the screenshot
 * harness holds the sequence still at a known moment.
 */
function Motion(): JSX.Element {
  const frames = useMemo(() => runSequence('run-motion', new Date(Date.now() - 190 * 1000)), [])
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (frame >= frames.length - 1) return
    const timer = setTimeout(() => setFrame((n) => n + 1), FRAME_MS)
    return () => clearTimeout(timer)
  }, [frame, frames.length])

  const done = frame >= frames.length - 1
  return (
    <section className="flex w-[680px] max-w-full flex-col gap-3" data-motion-frame={frame}>
      <h2 className="text-lg font-semibold text-foreground">Ein Lauf, von vorne bis zum Bericht</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Jede Phase, jede Runde, die Landung. Zu beurteilen: ob der Haken zieht und die Verbindungslinie
        danach füllt; ob eine ankommende Runde steigt und ihre Chips nacheinander folgen; ob am Ende der
        Reihe nach der letzte Haken, das Zeichen, das Wort, das Zuklappen und der Satz kommen — und der
        Bericht zuletzt.
      </p>
      <RunBlock
        key="motion"
        ledger={frames[frame] ?? frames[0]}
        title={TITLE}
        projectId={PROJECT}
        live={!done}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setFrame(0)}
          className="w-fit rounded-md bg-secondary px-3 py-1.5 text-sm font-medium text-foreground"
          data-testid="run-motion-replay"
        >
          Nochmal abspielen
        </button>
        <span className="text-xs tabular-nums text-muted-foreground">
          Bild {frame + 1} von {frames.length}
        </span>
      </div>
    </section>
  )
}

export default function RunBlockPreview(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') notFound()

  // Read after mount, not during render: the harness's query string is not
  // available to the server pass, and reading it there mismatches hydration.
  const [variant, setVariant] = useState<string | null>(null)
  useEffect(() => {
    setVariant(new URLSearchParams(window.location.search).get('variant'))
  }, [])

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <div
        data-testid="run-block-preview"
        className="flex min-h-screen flex-col items-center gap-10 bg-background p-10"
      >
        {variant === 'motion' ? (
          <Motion />
        ) : variant === 'transition' ? (
          <Transition />
        ) : (
          <>
            <Panel
              title="Wird gestartet"
              note="Die ersten Sekunden nach der Übergabe: alle fünf Phasen ausstehend, der Satz darunter nennt, wohin das Ergebnis kommt. Der Spinner ist die einzige Bewegung im Block."
            >
              <RunBlock ledger={RUN_ANGELEGT} title={TITLE} projectId={PROJECT} live />
            </Panel>

            <Panel
              title="Läuft — Recherchieren, dritte Runde"
              note="Planen ist zu einer Zeile gefaltet; Recherchieren zeigt jede Runde mit dem Vorsatz des Läufers, den erreichten Dokumenten als „Belegt durch“-Chips (Familie nach Regal, OIB/RIS-Kennung nach Namen) und den offenen Punkten. Ein zweites Mal gelesenes Dokument sagt das im Chip, statt noch einmal gezählt zu werden. Kopfzeile: nur Phase, Runden, Dokumente und die Laufzeit, dazu „Abbrechen“ als leiser Ausweg — es fragt nach, bevor es beendet."
            >
              <RunBlock ledger={RUN_LAEUFT} title={TITLE} projectId={PROJECT} live onCancel={() => {}} />
            </Panel>

            <Panel
              title="Läuft — die Live-Ansicht hat die Verbindung verloren"
              note="Die Leitung ist abgerissen, der Auftrag nicht. Eine gedämpfte Zeile unter dem Block sagt beides — zuerst, dass weitergearbeitet wird. Schweigen an dieser Stelle läse sich als ein Lauf, der stehen geblieben ist."
            >
              <RunBlock
                ledger={RUN_LAEUFT}
                title={TITLE}
                projectId={PROJECT}
                live
                connection="lost"
                onCancel={() => {}}
              />
            </Panel>

            <Panel
              title="Wartet auf Sie"
              note="Piloti hat eine Rückfrage. Der Block öffnet sich von selbst, „Antworten“ ist die eine Aktion rechts in der Kopfzeile (auf dem Telefon unter dem Satz), „Abbrechen“ steht leise daneben. Die Uhr läuft weiter: gewartet wird auf die Person, nicht auf Piloti."
            >
              <RunBlock
                ledger={RUN_WARTET}
                title="Stellplatznachweis für die Einreichung"
                projectId={PROJECT}
                live
                onAnswer={() => {}}
                onCancel={() => {}}
              />
            </Panel>

            <Panel
              title="Fertig, aufgeklappt — mit Datei und Freigabe"
              note="Alle Phasen gefaltet, jede mit ihrer Dauer. Darunter: wo der Bericht liegt, der Weg dorthin, und wer ihn angenommen hat. „Bericht öffnen“ ist die Aktion, weil schon beurteilt wurde."
            >
              <RunBlock
                ledger={RUN_FERTIG}
                title={TITLE}
                projectId={PROJECT}
                defaultOpen
                review={{ decision: 'accepted', by: 'Anna Berger' }}
                reportHref="#bericht"
              />
            </Panel>

            <Panel
              title="Fertig, zusammengeklappt — zurückgeschickt"
              note="Die Form, in der ein fertiger Lauf über seinem Bericht sitzt: eine Kopfzeile, ein Satz, die Begründung der Prüferin in ihren eigenen Worten. Der Bericht selbst steht als Antwortkarte darunter (hier nicht gezeigt)."
            >
              <RunBlock
                ledger={RUN_FERTIG}
                title={TITLE}
                projectId={PROJECT}
                review={{
                  decision: 'rejected',
                  by: 'Maria Huber',
                  reason: 'Die Fluchtweglänge im Atrium fehlt; OIB 2.3 gilt hier, nicht 2.',
                }}
                reportHref="#bericht"
              />
            </Panel>

            <Panel
              title="Fehlgeschlagen"
              note="Eine gedämpft rote Zeile mit dem Grund, darunter was bis dahin fertig war — damit niemand die Recherche ein zweites Mal beauftragt. Der Ring auf „Prüfen“ ohne Puls: die Phase, in der es aufhörte. „Erneut starten“ nur, weil der Aufruf es anbietet."
            >
              <RunBlock ledger={RUN_FEHLGESCHLAGEN} title={TITLE} projectId={PROJECT} onRetry={() => {}} />
            </Panel>

            <Panel
              title="Abgebrochen"
              note="Auf Wunsch der Person beendet, nach der ersten Runde. Kein Rot: nichts ist kaputt."
            >
              <RunBlock
                ledger={RUN_ABGEBROCHEN}
                title="Normprüfung Bestandsplan Bauteil B"
                projectId={PROJECT}
              />
            </Panel>

            <Panel
              title="Unterbrochen"
              note="Die Recherche wurde abgebrochen, der Bericht aus dem Vorhandenen geschrieben und abgelegt. Warnfarbe, nicht Fehlerfarbe: es gibt ein Ergebnis, nur ein schmaleres."
            >
              <RunBlock
                ledger={RUN_UNTERBROCHEN}
                title={TITLE}
                projectId={PROJECT}
                defaultOpen
                reviewHref="#pruefen"
              />
            </Panel>

            <Panel
              title="Übergabe im Verlauf"
              note="Was die Person in den ersten Sekunden sieht: die eigene Nachricht, die Karte „Übernommen“, und direkt darunter den Block im Zustand „Wird gestartet“. Nichts öffnet sich woanders."
            >
              <Transition />
            </Panel>

            <Panel
              title="Die Kurzform — Aufträge-Liste und Vorschauen"
              note="Eine Zeile pro Lauf: dasselbe Zeichen, dasselbe Wort, dieselben Zahlen wie in der Kopfzeile des Blocks, dazu wie lange es her ist und der Weg in den Verlauf."
            >
              <div className="flex flex-col divide-y rounded-lg border bg-card px-4" data-testid="run-block-lines">
                <RunBlockLine
                  ledger={RUN_FERTIG}
                  title={TITLE}
                  href="/app/chat?session=s1&run=run-fertig#message-m1"
                  at={HOURS_AGO(3)}
                />
                <RunBlockLine
                  ledger={RUN_LAEUFT}
                  title="Aktenvermerk Stellplatzverpflichtung"
                  href="/app/chat?session=s2&run=run-laeuft#message-m2"
                  at={HOURS_AGO(0.03)}
                />
                <RunBlockLine
                  ledger={RUN_WARTET}
                  title="Einreichcheck vor Abgabe"
                  href="/app/chat?session=s3&run=run-wartet#message-m3"
                  at={HOURS_AGO(1)}
                />
                <RunBlockLine
                  ledger={RUN_FEHLGESCHLAGEN}
                  title="Normprüfung Bestandsplan Bauteil B"
                  href="/app/chat?session=s4&run=run-fehlgeschlagen#message-m4"
                  at={HOURS_AGO(26)}
                />
              </div>
            </Panel>
          </>
        )}
      </div>
    </I18nProvider>
  )
}
