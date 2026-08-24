'use client'

/**
 * Chat-turn dev preview: renders a COMPLETE turn the way ChatArea composes it —
 * the user question (UserMessage), the reasoning trace (ChatThinking / Herleitung)
 * and the cited answer (AgentResponse, default "Ergebnis" card) — with fixture
 * data and no backend.
 *
 * The default target renders the two transition endpoints (visual/registry.mjs →
 * `chat-turn`), in light + dark, desktop + mobile:
 *   • LIVE      — isThinking, the Herleitung auto-EXPANDED (the streaming
 *                 reasoning graph is the spectacle), the answer still absent.
 *   • COMPLETED — the Herleitung auto-COLLAPSED to the one-line bar, the cited
 *                 answer card dominant, with sources + confidence shown ONCE on
 *                 the answer (deduped out of the reasoning assessment node).
 *
 * `?variant=` selects an ANSWER-LAYER fixture instead. Every card, the lede and
 * the provenance footer had only ever been reviewed in the gallery — isolated,
 * on a bare page, at full width — and "does this look right on its own" is a
 * different question from "does this look right wedged between two paragraphs,
 * under a lede, above a provenance footer, at the thread's real 680px column".
 * These four variants ask the second one:
 *
 *   • `lede-card`    — a long answer (over the `LEDE_MIN_CHARS` threshold, so
 *                      the lede fires) with a `calculation` spliced in mid-answer
 *                      by a `[[card:1]]` marker: marker placement, and the gap a
 *                      card leaves in the reading rhythm on both sides.
 *   • `two-cards`    — two cards in one turn, the rule nobody had seen tested:
 *                      a `condition_tree` placed inline and a `process_map` left
 *                      unplaced, so it lands in the fallback block between the
 *                      prose and the provenance footer.
 *   • `follow-ups-rail` — the SAME answer twice: once as it lands, and once
 *                      with the post-answer follow-ups rail below it
 *                      (`docs/architecture/post-answer-stages.md` §8, §9). The
 *                      pair IS the evidence: the chips arrive two to six
 *                      seconds late and reserve no space, so everything above
 *                      them must be pixel-identical in the two turns. Read the
 *                      screenshot by covering the rail — if the answer card,
 *                      the provenance footer and the meta row do not line up,
 *                      the design's licence to arrive late is void.
 *   • `memory-chip`  — the same answer twice, as two turns of one thread: one
 *                      where the `memory_reflection` stage recorded nothing and
 *                      one where it recorded two things
 *                      (`docs/architecture/post-answer-stages.md` §1.7, §5.1).
 *                      The chip is a fact about the TURN now, not a poll of the
 *                      conversation's memory fired by every rendered answer —
 *                      which is why the first panel has no chip at all, and why
 *                      the second's number is 2 rather than the thread's total.
 *                      The footers must otherwise line up: the chip lands in a
 *                      meta row that is already on screen, which is what lets it
 *                      arrive seconds late without reserving anything.
 *   • `verdict-lede` — the `verdict_header` + lede pair, the conflict the
 *                      `piloti-cards` skill adjudicates ("the card carries the
 *                      value, the prose carries the sentence that qualifies it,
 *                      never the same words"). Two turns: the card at the TOP
 *                      (its marker opens the body, which suppresses the lede by
 *                      design — the card IS the lede), and the misuse beneath
 *                      it, the card placed after an opening paragraph so the
 *                      lede fires too and the ruling is stated twice.
 *
 * Every fixture answer deliberately ends in a written "## Quellen" section, the
 * way a verified backend answer does: it must NOT render as a second source
 * list — AgentResponse folds it into the one numbered "Belegt durch" block.
 *
 * Pinned to German with `fixedLocale`: without it the provider falls back to
 * `defaultLocale` ('en') and the answer's own chrome — „Belegt durch", the
 * confidence chip, the feedback line, the copy actions' labels — was captured
 * in English above German prose. See docs/ux/visual-screenshots.md.
 *
 * Nothing here drives an interactive state, so the `reactStrictMode`
 * double-mount gotcha in that doc does not apply: the only effect reads the
 * query string, which is idempotent.
 *
 * Not linked anywhere and 404s outside development.
 */

import { useEffect, useState, type FC, type ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { UserMessage } from '@/features/chat/components/UserMessage'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import { FollowUpsRail } from '@/features/chat/components/FollowUpsRail'
import type { ThinkingStep, CitationSource } from '@/features/chat/types'
import type { GridCard } from '@/shared/cards/schemas'
import type { MessageStages } from '@/lib/conversations/message-stages'

const step: ThinkingStep = {
  id: 'kb',
  userMessageId: 'msg-1',
  category: 'tools',
  functionName: 'knowledge_retrieval',
  displayName: 'Knowledge Retrieval',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-15T14:30:00'),
  traceLanes: [
    {
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: 3,
      signal: 'law',
      sources: [
        { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'Fluchtwege, Pkt. 3.2' },
        { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.18' },
      ],
    },
    {
      key: 'baurecht_ris',
      label: 'Bundesrecht',
      hitCount: 2,
      signal: 'law',
      sources: [{ name: 'Bauordnung für Wien', detail: '§ 108 Fluchtwege' }],
    },
    {
      key: 'projekt',
      label: 'Projektwissen',
      hitCount: 1,
      signal: 'project',
      sources: [{ name: 'Grundriss_EG.pdf', detail: 'Seite 2' }],
    },
  ],
}

const citations: CitationSource[] = [
  {
    id: 'c1',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    fileName: 'OIB-RL_2_Brandschutz.pdf',
    title: 'OIB-Richtlinie 2 · Brandschutz',
    page: 18,
    number: 1,
  },
  {
    id: 'c2',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    title: 'Bauordnung für Wien § 108',
    url: 'https://www.ris.bka.gv.at/',
    number: 2,
  },
]

const question =
  'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?'

const answer = `Für ein Bürogebäude der **Gebäudeklasse 4** sind in der Regel **zwei voneinander unabhängige Fluchtwege** erforderlich.

- **Erster Fluchtweg** — ein baulicher Rettungsweg über ein Sicherheitstreppenhaus.
- **Zweiter Fluchtweg** — ein zweiter baulicher Weg oder eine über die Feuerwehr anleiterbare Stelle.

Die maximale Fluchtweglänge bis zum sicheren Bereich beträgt **40 m** [1]; § 108 BO Wien verlangt zusätzlich den zweiten Weg [2].

## Quellen
- [1] [KB] OIB-RL_2_Brandschutz.pdf, p.18
- [2] [RIS] Bauordnung für Wien § 108 — https://www.ris.bka.gv.at/`

const commonThinking = {
  steps: [step],
  userQuestion: question,
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  messageFiles: [{ id: 'f1', fileName: 'Grundriss_EG.pdf' }],
  routingDecision: 'shallow' as const,
  routingReason:
    'konkrete Frage zu OIB-Richtlinie 2 (Brandschutz), kein Bedarf für Tiefenrecherche',
}

/**
 * The LIVE turn: the assistant is still working. The Herleitung is auto-EXPANDED
 * (the streaming reasoning graph is the focus) and no answer card exists yet.
 */
function LiveTurn() {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
      <div className="font-mono text-xs text-muted-foreground">↓ LIVE — thinking, Herleitung expanded, answer absent</div>
      <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
      <div className="w-[680px] max-w-full">
        <ChatThinking
          {...commonThinking}
          isThinking
          autoOpen
          answerConfidence="high"
          citations={citations}
        />
      </div>
    </div>
  )
}

/**
 * The COMPLETED turn: the answer has landed. The Herleitung has auto-COLLAPSED to
 * the one-line bar and the cited answer card is dominant — sources + confidence
 * shown ONCE, on the answer.
 */
function CompletedTurn() {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
      <div className="font-mono text-xs text-muted-foreground">↓ COMPLETED — Herleitung collapsed, answer dominant</div>
      <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
      <div className="w-[680px] max-w-full">
        <ChatThinking
          {...commonThinking}
          isThinking={false}
          autoOpen={false}
          answerConfidence="high"
          citations={citations}
        />
      </div>
      <AgentResponse
        content={answer}
        timestamp={new Date('2024-01-15T14:30:12')}
        citations={citations}
        answerConfidence="high"
        answerConfidenceReason="OIB-RL 2 direkt als Quelle belegt"
        routingDecision="shallow"
        messageId="msg-a1"
      />
    </div>
  )
}

/* ------------------------------------------------------------------------- */
/* Answer-layer fixtures                                                      */
/* ------------------------------------------------------------------------- */

const OIB2 = { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b', edition: 'Ausgabe Mai 2023' }
const OIB4 = { document: 'OIB-Richtlinie 4', section: 'Pkt. 2.2', edition: 'Ausgabe Mai 2023' }

/**
 * One completed answer in its turn — the question above it, the Herleitung
 * collapsed to its one-line bar between them, the answer card below. Exactly
 * what `CompletedTurn` renders, parameterised, because the point of these
 * fixtures is the answer seen at the width and in the company it actually has.
 */
const AnswerTurn: FC<{
  label: string
  question: string
  answer: string
  cards?: GridCard[]
  citations: CitationSource[]
  confidenceReason: string
  messageId: string
  /**
   * The post-answer follow-ups rail, when a stage delivered one. Rendered as
   * ChatArea renders it — a SIBLING of the answer in the same 680px column,
   * outside the answer surface, and last (§6.1).
   */
  rail?: { question: string; hint?: string }[]
  /**
   * Post-answer stage output that renders INSIDE the answer — today just
   * `memoryReflection`, which feeds the „Piloti hat sich gemerkt" chip in the
   * footer's meta row. Passed as a prop for the same reason the rail is: the
   * component reads it off the message, so a fixture is a message.
   */
  stages?: MessageStages
  children?: ReactNode
}> = ({ label, question, answer, cards, citations, confidenceReason, messageId, rail, stages, children }) => (
  <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
    <div className="font-mono text-xs text-muted-foreground">{label}</div>
    {children}
    <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
    <div className="w-[680px] max-w-full">
      <ChatThinking
        {...commonThinking}
        userQuestion={question}
        isThinking={false}
        autoOpen={false}
        answerConfidence="high"
        citations={citations}
      />
    </div>
    {/* `gap-4` — the message column's real gap in ChatArea, so the distance
        between the answer and the rail is the production one and not this
        preview panel's own rhythm. */}
    <div className="flex flex-col gap-4">
      <AgentResponse
        content={answer}
        timestamp={new Date('2024-01-15T14:30:12')}
        cards={cards}
        citations={citations}
        answerConfidence="high"
        answerConfidenceReason={confidenceReason}
        routingDecision="shallow"
        messageId={messageId}
        stages={stages}
      />
      {rail && (
        <div className="w-[680px] max-w-full">
          <FollowUpsRail items={rail} />
        </div>
      )}
    </div>
  </div>
)

/** Sources for the Nutzungssicherheit fixtures (Treppe / Geländer). */
const stairCitations: CitationSource[] = [
  {
    id: 's1',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    fileName: 'OIB-RL_4_Nutzungssicherheit.pdf',
    title: 'OIB-Richtlinie 4 · Nutzungssicherheit',
    page: 7,
    number: 1,
  },
  {
    id: 's2',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    title: 'Bauordnung für Wien § 109',
    url: 'https://www.ris.bka.gv.at/',
    number: 2,
  },
]

const STAIR_SOURCES = `## Quellen
- [1] [KB] OIB-RL_4_Nutzungssicherheit.pdf, Pkt. 2.2
- [2] [RIS] Bauordnung für Wien § 109 — https://www.ris.bka.gv.at/`

/** Sources for the Brandschutz fixtures (Feuerwiderstand / Verfahren). */
const fireCitations: CitationSource[] = [
  {
    id: 'f1',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    fileName: 'OIB-RL_2_Brandschutz.pdf',
    title: 'OIB-Richtlinie 2 · Brandschutz',
    page: 12,
    number: 1,
  },
  {
    id: 'f2',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    title: 'Bauordnung für Wien §§ 60 ff.',
    url: 'https://www.ris.bka.gv.at/',
    number: 2,
  },
]

const FIRE_SOURCES = `## Quellen
- [1] [KB] OIB-RL_2_Brandschutz.pdf, Tabelle 1b
- [2] [RIS] Bauordnung für Wien §§ 60 ff. — https://www.ris.bka.gv.at/`

/* --- variant: lede-card --------------------------------------------------- */

const ledeCardQuestion =
  'Erfüllt der Treppenlauf im Haus A die Schrittmaßregel bei 17 cm Steigung und 30 cm Auftritt?'

const ledeCardAnswer = `Ja — der Lauf hält die Schrittmaßregel ein: aus 17 cm Steigung und 30 cm Auftritt ergibt sich ein Schrittmaß innerhalb des zulässigen Bandes von 59 bis 65 cm [1].

Maßgeblich ist nicht die einzelne Stufe, sondern das Verhältnis von Steigung und Auftritt über den gesamten Lauf. Die Regel bildet die natürliche Schrittlänge ab — zweimal die Steigung plus einmal den Auftritt — und hält den Lauf begehbar, ohne dass die Schrittfolge auf halber Höhe wechselt.

[[card:1]]

Die aus dem Einreichplan abgegriffene Steigung trägt eine Toleranz von ± 0,5 cm. Das Ergebnis bleibt damit in jeder Lage innerhalb der Regel; erst ab 65,5 cm wäre der Lauf gesondert nachzuweisen.

Für Wohngebäude der Gebäudeklasse 4 ist zusätzlich eine nutzbare Laufbreite von mindestens 1,20 m einzuhalten [2]. Sie wird von der Schrittmaßregel nicht berührt und ist getrennt zu prüfen.

${STAIR_SOURCES}`

const ledeCards: GridCard[] = [
  {
    type: 'calculation',
    title: 'Schrittmaßregel – Treppenlauf Haus A',
    steps: [
      {
        label: 'Schrittmaß',
        operation: 'sum',
        unit: 'cm',
        operands: [
          {
            label: 'Steigung',
            value: 17,
            unit: 'cm',
            factor: 2,
            provenance: 'computed',
            tolerance: 0.5,
            source: 'Einreichplan, Schnitt A-A',
          },
          { label: 'Auftritt', value: 30, unit: 'cm', provenance: 'declared' },
        ],
      },
    ],
    limit: { comparator: 'between', value: 59, upper: 65, label: 'Schrittmaßregel', reference: OIB4 },
  } as GridCard,
]

/* --- variant: two-cards --------------------------------------------------- */

const twoCardsQuestion =
  'Welche Feuerwiderstandsklasse brauchen die tragenden Bauteile in GK 4 — und wie läuft die Bewilligung in Wien ab?'

const twoCardsAnswer = `Tragende Bauteile der Gebäudeklasse 4 sind in **REI 60** auszuführen; in Kellergeschossen gilt unabhängig von der Gebäudeklasse REI 90 [1].

Die Anforderung hängt allein an der Gebäudeklasse, nicht an der Nutzung des Geschoßes:

[[card:1]]

Ihr Projekt liegt mit einem obersten Fluchtniveau von 9,80 m unter der Grenze von 11 m und damit in GK 4. Verschiebt sich das Fluchtniveau im Zuge der Planung über diese Grenze, gilt die Zeile darunter [1].

Der Nachweis gehört in den Einreichplan: das Verfahren selbst verschiebt die Feuerwiderstandsklasse nicht, es prüft sie nur an einer bestimmten Stelle [2].

${FIRE_SOURCES}`

const twoCards: GridCard[] = [
  {
    type: 'condition_tree',
    title: 'Erforderliche Feuerwiderstandsklasse tragender Bauteile',
    question: 'Gebäudeklasse',
    branches: [
      { condition: 'GK 1–3', outcome: 'REI 30 (bzw. R 30)' },
      {
        condition: 'GK 4',
        outcome: 'REI 60',
        active: true,
        reference: {
          document: 'OIB-Richtlinie 2',
          section: 'Tabelle 1b',
          excerpt:
            'Tragende Bauteile in Gebäuden der Gebäudeklasse 4 sind in REI 60 auszuführen; in Kellergeschossen gilt REI 90.',
        },
      },
      { condition: 'GK 5', outcome: 'REI 90', reference: { document: 'OIB-Richtlinie 2', section: 'Tabelle 1b' } },
    ],
    reference: OIB2,
  } as GridCard,
  {
    type: 'process_map',
    title: 'Baubewilligungsverfahren – Wien',
    current_step: 2,
    steps: [
      {
        label: 'Einreichung',
        summary: 'Einreichunterlagen werden bei der Baubehörde eingebracht.',
        actor: 'Bauwerber',
        requires: ['Einreichplan', 'Baubeschreibung', 'Energieausweis'],
        produces: ['Aktenzeichen'],
        reference: { document: 'Wiener Bauordnung', section: '§ 63' },
      },
      {
        label: 'Bauverhandlung',
        summary: 'Mündliche Verhandlung mit Nachbarn und Amtssachverständigen.',
        actor: 'Baubehörde',
        duration: 'binnen sechs Wochen',
        produces: ['Verhandlungsschrift'],
        reference: { document: 'Wiener Bauordnung', section: '§ 70' },
      },
      {
        label: 'Baubewilligung',
        summary: 'Bescheid mit den Auflagen aus der Verhandlung.',
        actor: 'Baubehörde',
        produces: ['Baubewilligungsbescheid'],
      },
      {
        label: 'Baubeginnsanzeige',
        summary: 'Der Baubeginn ist der Behörde anzuzeigen.',
        actor: 'Bauwerber',
        requires: ['rechtskräftige Baubewilligung'],
      },
      {
        label: 'Fertigstellungsanzeige',
        summary: 'Nach Fertigstellung, mit den Ausführungsbestätigungen.',
        actor: 'Bauwerber',
        requires: ['Ausführungsbestätigungen der Fachplaner'],
      },
    ],
    reference: { document: 'Wiener Bauordnung', section: '§§ 60 ff.' },
  } as GridCard,
]

/* --- variant: follow-ups -------------------------------------------------- */

const followUpsQuestion = 'Was ist das Fluchtniveau und wie wird es gemessen?'

const followUpsAnswer = `Das Fluchtniveau ist der **Fußboden des obersten Geschoßes mit Aufenthaltsräumen**, gemessen über dem tiefsten Punkt des angrenzenden Geländes. Es entscheidet über die Gebäudeklasse und damit über fast jede Brandschutzanforderung [1].

Gemessen wird lotrecht: vom tiefsten Punkt des Geländes an der Gebäudeaußenseite bis zur Oberkante des Fußbodens im obersten Geschoß mit Aufenthaltsräumen. Dachgeschoße zählen mit, sobald sie Aufenthaltsräume enthalten; ein reiner Technik- oder Abstellraum darüber bleibt außer Betracht.

[[card:1]]

Bei Hanglagen ist der tiefste Geländepunkt maßgeblich, nicht der Eingang. Das ist der häufigste Grund, warum ein Projekt in der Einreichung eine Klasse höher landet als in der Vorbemessung angenommen [2].

[[card:2]]

${STAIR_SOURCES}`

const followUpsCards: GridCard[] = [
  {
    type: 'callout',
    kind: 'achtung',
    title: 'Hanglage',
    text: 'Bei geneigtem Gelände ist der tiefste Punkt an der Gebäudeaußenseite maßgeblich — nicht das Eingangsniveau.',
    detail:
      'Ein Grundstück mit 2,50 m Gefälle über die Gebäudelänge hebt das Fluchtniveau um denselben Betrag und kann ein Projekt allein dadurch von GK 4 in GK 5 verschieben.',
  } as GridCard,
]

/**
 * What the `follow_ups` STAGE delivered for this turn — the payload shape of
 * §4.2, which is deliberately the same shape the card always had. Four
 * questions, because four is the ceiling and the ceiling is where the row
 * wrapping on a phone is worth looking at.
 */
const followUpsStageItems = [
  { question: 'Welche Gebäudeklasse ergibt sich für mein Projekt?', hint: 'aus dem Grundriss und dem Schnitt' },
  { question: 'Was ändert sich beim Sprung von GK 4 auf GK 5?', hint: 'Vergleich der Anforderungen' },
  { question: 'Zählt mein Dachgeschoß als Aufenthaltsraum?' },
  { question: 'Wie weise ich das Fluchtniveau im Einreichplan nach?' },
]

/* --- variant: memory-chip ------------------------------------------------- */

const memoryQuestion = 'Zählt das Dachgeschoß als Aufenthaltsraum, wenn dort nur ein Büro liegt?'

const memoryAnswer = `Ja. Ein Büro ist ein **Aufenthaltsraum** im Sinne der OIB-Richtlinien, weil es zum nicht nur vorübergehenden Aufenthalt von Menschen bestimmt ist. Damit zählt das Dachgeschoß für das Fluchtniveau mit [1].

Für Ihr Projekt heißt das: das oberste Geschoß mit Aufenthaltsräumen ist das Dachgeschoß, und das Fluchtniveau ist von dessen Fußboden zu messen — nicht vom darunterliegenden Regelgeschoß.

Ein reiner Technik-, Abstell- oder Trockenraum bliebe außer Betracht; sobald dort ein Arbeitsplatz eingerichtet ist, ändert sich die Beurteilung [2].

${STAIR_SOURCES}`

/**
 * What the `memory_reflection` STAGE recorded for the second turn — the payload
 * of §5.1, as it arrives on `message.stages.memoryReflection`.
 *
 * Two items, because the count is half of what the chip says.
 */
const memoryStage: MessageStages = {
  memoryReflection: {
    items: [
      {
        id: 'row-1',
        kind: 'derived_fact',
        content: 'Das Dachgeschoß enthält ein Büro und zählt damit als Geschoß mit Aufenthaltsräumen.',
      },
      {
        id: 'row-2',
        kind: 'constraint',
        content: 'Das Fluchtniveau ist ab Oberkante Fußboden des Dachgeschoßes zu messen.',
      },
    ],
  },
}

/* --- variant: verdict-lede ------------------------------------------------ */

const verdictQuestion = 'Wie hoch muss das Geländer an der Loggia im 4. Obergeschoß sein?'

/**
 * The card at the TOP. Its marker opens the body, and `NON_PROSE_OPENER` in
 * AgentResponse therefore suppresses the lede — the verdict card IS the lede,
 * and the first paragraph is free to qualify it instead of repeating it.
 */
const verdictTopAnswer = `[[card:1]]

Maßgeblich ist die Absturzhöhe, nicht das Geschoß: gemessen wird von der Oberkante des begehbaren Belags bis zur tiefer liegenden Fläche. Ihre Loggia liegt bei rund 11,4 m und damit knapp unter der Grenze von 12 m, weshalb die Höhe vor der Einreichung am Schnitt zu prüfen ist [1].

Die Füllung ist getrennt zu beurteilen: Öffnungen dürfen 12 cm nicht überschreiten, und im Bereich zwischen 20 und 60 cm über dem Belag sind waagrechte Elemente unzulässig, weil sie als Leiter wirken [1].

Für Wien ergänzt § 109 BO die Anforderung um die Ausführung der Verankerung, die im Einreichplan darzustellen ist [2].

${STAIR_SOURCES}`

/**
 * The same card placed AFTER an opening paragraph. The body now opens with
 * prose and clears the length threshold, so the lede fires as well — and the
 * ruling is stated twice, once as a sentence and once as a 2xl figure. This is
 * the misuse the `piloti-cards` skill rules out; it is here so the reviewer can
 * see what it costs rather than take the rule on trust.
 */
const verdictAfterLedeAnswer = `Das Geländer an der Loggia muss mindestens **1,10 m** hoch sein, weil die Absturzhöhe unter 12 m liegt [1].

[[card:1]]

Maßgeblich ist die Absturzhöhe, nicht das Geschoß: gemessen wird von der Oberkante des begehbaren Belags bis zur tiefer liegenden Fläche. Ihre Loggia liegt bei rund 11,4 m, also knapp unter der Grenze, ab der 1,20 m verlangt werden [1].

Die Füllung ist getrennt zu beurteilen: Öffnungen dürfen 12 cm nicht überschreiten, und im Bereich zwischen 20 und 60 cm über dem Belag sind waagrechte Elemente unzulässig, weil sie als Leiter wirken [1].

Für Wien ergänzt § 109 BO die Ausführung der Verankerung, die im Einreichplan darzustellen ist [2].

${STAIR_SOURCES}`

const verdictCard: GridCard = {
  type: 'verdict_header',
  subject: 'Erforderliche Geländerhöhe',
  verdict: '1,10 m',
  confidence: 'medium',
  confidence_reason:
    'Die Absturzhöhe liegt mit rund 11,4 m knapp unter der 12-m-Grenze; sie ist am Schnitt zu bestätigen.',
  reference: { document: 'OIB-Richtlinie 4', section: 'Pkt. 4.1', edition: 'Ausgabe Mai 2023' },
} as GridCard

/**
 * Deliberately carries NONE of the verdict's words: the header holds the value,
 * so the takeaways hold the things it cannot — where the height is measured
 * from, and the two rules about the Füllung that the number says nothing about.
 * A first takeaway reading „Absturzhöhe 11,4 m → 1,10 m" would state the ruling
 * a second time in the same answer, which is the failure the turn below shows.
 */
const takeawaysCard: GridCard = {
  type: 'key_takeaways',
  title: 'Geländer Loggia – das Wichtigste',
  items: [
    {
      text: 'Gemessen wird ab Oberkante des begehbaren Belags',
      detail: 'Bezugsfläche ist die tiefer liegende Fläche, nicht das Geschoßniveau.',
    },
    { text: 'Öffnungen der Füllung höchstens 12 cm' },
    {
      text: 'Keine waagrechten Elemente zwischen 20 und 60 cm über dem Belag',
      detail: 'In diesem Band wirken sie als Aufstiegshilfe für Kinder.',
    },
  ],
} as GridCard

const ANSWER_VARIANTS = ['lede-card', 'two-cards', 'follow-ups-rail', 'memory-chip', 'verdict-lede'] as const
type AnswerVariant = (typeof ANSWER_VARIANTS)[number]

const isAnswerVariant = (value: string | null): value is AnswerVariant =>
  ANSWER_VARIANTS.includes(value as AnswerVariant)

function AnswerLayer({ variant }: { variant: AnswerVariant }) {
  if (variant === 'lede-card') {
    return (
      <AnswerTurn
        label="↓ LEDE + INLINE CARD — first paragraph typeset as the lede, calculation spliced in by [[card:1]]"
        question={ledeCardQuestion}
        answer={ledeCardAnswer}
        cards={ledeCards}
        citations={stairCitations}
        confidenceReason="Schrittmaßregel direkt aus OIB-RL 4 belegt"
        messageId="msg-lede-card"
      />
    )
  }

  if (variant === 'two-cards') {
    return (
      <AnswerTurn
        label="↓ TWO CARDS — condition_tree placed inline, process_map unplaced → fallback block above the footer"
        question={twoCardsQuestion}
        answer={twoCardsAnswer}
        cards={twoCards}
        citations={fireCitations}
        confidenceReason="Tabelle 1b der OIB-RL 2 direkt als Quelle belegt"
        messageId="msg-two-cards"
      />
    )
  }

  if (variant === 'follow-ups-rail') {
    // The same turn twice. Everything above the rail must be identical in the
    // two panels — that comparison is what "reserves no space" LOOKS like, and
    // it is the reason §9 asked for a screenshot here instead of an assertion.
    return (
      <>
        <AnswerTurn
          label="↓ AS THE ANSWER LANDS — the stage has not answered yet, and nothing is held open for it"
          question={followUpsQuestion}
          answer={followUpsAnswer}
          cards={followUpsCards}
          citations={stairCitations}
          confidenceReason="Definition und Messregel direkt aus OIB-RL 4 belegt"
          messageId="msg-follow-ups-before"
        />
        <AnswerTurn
          label="↓ TWO SECONDS LATER — the rail appended BELOW the answer card, outside it, in the same column"
          question={followUpsQuestion}
          answer={followUpsAnswer}
          cards={followUpsCards}
          citations={stairCitations}
          confidenceReason="Definition und Messregel direkt aus OIB-RL 4 belegt"
          messageId="msg-follow-ups-after"
          rail={followUpsStageItems}
        />
      </>
    )
  }

  if (variant === 'memory-chip') {
    // Two answers of ONE thread. The chip used to be fed by a poll of the whole
    // conversation's memory, mounted by every rendered answer, so BOTH panels
    // would have carried it and both would have read the same number. It is now
    // a fact about the turn: the first recorded nothing, the second recorded
    // two things, and only the second says so.
    //
    // The second thing to read here is the meta row. The chip arrives seconds
    // after the answer, and it may do that without any „reserve the space"
    // treatment only because it lands in a row that is already on screen —
    // confidence, copy, thumbs and timestamp are in it from the start. Cover
    // the chip: the two footers must line up.
    return (
      <>
        <AnswerTurn
          label="↓ NOTHING WAS RECORDED — the stage ran and declined, which is its most common correct outcome"
          question={memoryQuestion}
          answer={memoryAnswer}
          citations={stairCitations}
          confidenceReason="Definition des Aufenthaltsraums direkt aus OIB-RL 4 belegt"
          messageId="msg-memory-empty"
        />
        <AnswerTurn
          label="↓ TWO WERE — the same footer, one chip wider; the popover names each item and where it came from"
          question={memoryQuestion}
          answer={memoryAnswer}
          citations={stairCitations}
          confidenceReason="Definition des Aufenthaltsraums direkt aus OIB-RL 4 belegt"
          messageId="msg-memory-noted"
          stages={memoryStage}
        />
      </>
    )
  }

  return (
    <>
      <AnswerTurn
        label="↓ VERDICT AT TOP — the marker opens the body, so the lede is suppressed: the card IS the lede"
        question={verdictQuestion}
        answer={verdictTopAnswer}
        cards={[verdictCard, takeawaysCard]}
        citations={stairCitations}
        confidenceReason="Absturzhöhe liegt knapp unter der 12-m-Grenze"
        messageId="msg-verdict-top"
      />
      <AnswerTurn
        label="↓ VERDICT AFTER THE LEDE — prose opens the body, so the lede fires too and the ruling is stated twice"
        question={verdictQuestion}
        answer={verdictAfterLedeAnswer}
        cards={[verdictCard]}
        citations={stairCitations}
        confidenceReason="Absturzhöhe liegt knapp unter der 12-m-Grenze"
        messageId="msg-verdict-lede"
      />
    </>
  )
}

export default function ChatTurnPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <ChatTurnPreview />
    </I18nProvider>
  )
}

function ChatTurnPreview() {
  // Read the requested variant after mount (not during render) so the fixture is
  // chosen on the client without opting the whole route into a Suspense
  // boundary. `undefined` is "not yet read" and renders nothing, so the harness
  // never captures the default turn under a variant's name.
  const [variant, setVariant] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    setVariant(new URLSearchParams(window.location.search).get('variant'))
  }, [])

  if (variant === undefined) return null

  const heading = isAnswerVariant(variant)
    ? `/dev/chat-turn?variant=${variant} — the answer layer inside a real turn`
    : '/dev/chat-turn — live (reasoning expanded) → completed (answer-dominant)'

  return (
    <main className="min-h-dvh bg-muted/30 px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        <h1
          className="font-mono text-xs text-muted-foreground"
          data-testid={isAnswerVariant(variant) ? 'answer-layer-preview' : 'chat-turn-preview'}
        >
          {heading}
        </h1>
        {isAnswerVariant(variant) ? (
          <AnswerLayer variant={variant} />
        ) : (
          <>
            <LiveTurn />
            <CompletedTurn />
          </>
        )}
      </div>
    </main>
  )
}
