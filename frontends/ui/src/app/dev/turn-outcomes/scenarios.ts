/**
 * The turns `/dev/turn-outcomes` plays: every way a turn can end other than a
 * plain answer, as the v2 events a backend sends for it
 * (`docs/design/chat-wire-v2.md` §a). Each is a script the page's fake socket
 * sends after the question, plus what it sends back when the reader answers a
 * prompt or presses Stop, plus what the page's stubbed API answers.
 *
 * Bodies only: the socket stamps the envelope (`seq`, `ts`, the ids), so a
 * script reads as the turn it describes.
 */

/** One event body, `at` ms after the question reached the server. */
export interface TimedBody {
  at: number
  body: Record<string, unknown>
}

export type ScenarioId =
  | 'handed_off'
  | 'answer_retracted'
  | 'run_error'
  | 'error_preack'
  | 'error_steps'
  | 'error_finish'
  | 'cancelled'
  | 'stop_before_steps'
  | 'stop_during_steps'
  | 'job_admission_rejected'
  | 'hitl_choice'
  | 'hitl_plan'
  | 'proposal_accept'

export interface Scenario {
  id: ScenarioId
  label: string
  /** What to watch for. */
  note: string
  question: string
  /** The thread is in a project: the proposal card's routes and the run block's read door need one. */
  project?: boolean
  script: TimedBody[]
  /** Sent after the reader's `interaction_response`, timed from it. */
  afterAnswer?: TimedBody[]
  /** Sent after `cancel_turn`, with the text the server had sent by then. */
  afterCancel?: (sentText: string) => TimedBody[]
  /** The page presses Stop this many ms after the question. */
  stopAt?: number
  /** `GET …/messages` answers with the run's stored message after this many ms. */
  runMessageAfterMs?: number
}

export const ANSWER_ID = 'turn-outcomes-answer'
export const RUN = {
  run_id: 'turn-outcomes-run',
  run_message_id: 'turn-outcomes-run-message',
} as const
export const PROJECT_ID = 'turn-outcomes-project'

/** The Herleitung's first rows: the documents, one retrieval round, its sources. */
const steps = (from = 40): TimedBody[] => [
  {
    at: from,
    body: {
      type: 'STEP_FINISHED',
      step: {
        id: 'status:documents',
        kind: 'status',
        slot: 'documents',
        key: 'status.documents.project',
      },
    },
  },
  {
    at: from + 300,
    body: {
      type: 'STEP_FINISHED',
      step: {
        id: 'status:retrieval:0',
        kind: 'retrieval',
        round: 0,
        key: 'status.retrieval.withQuery',
        values: { corpus: 'knowledge', query: 'OIB-RL 2 Fluchtwege' },
        tools: ['knowledge_search'],
      },
    },
  },
  {
    at: from + 1200,
    body: {
      type: 'STEP_FINISHED',
      step: {
        id: 'sources:0:knowledge_search:1',
        kind: 'sources',
        round: 0,
        tool: 'knowledge_search',
        lanes: [
          {
            key: 'baurecht_oib',
            label: 'OIB-Richtlinie',
            kind: 'baurecht',
            hit_count: 2,
            sources: [
              {
                name: 'oib-rl_2_ausgabe_mai_2023.pdf',
                title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
                detail: 'p.12',
                shelf: 'base',
                round: 0,
              },
              { name: 'oib-rl_2_erlaeuterungen.pdf', detail: 'p.4', shelf: 'base', round: 0 },
            ],
          },
        ],
      },
    },
  },
]

/** `text` streamed word by word from `start`, one chunk every `every` ms, between START and END. */
const prose = (text: string, start: number, every = 70, messageId = ANSWER_ID): TimedBody[] => {
  const words = text.split(/(?<= )/)
  return [
    { at: start, body: { type: 'TEXT_MESSAGE_START', message_id: messageId } },
    ...words.map((delta, index) => ({
      at: start + 10 + index * every,
      body: { type: 'TEXT_MESSAGE_CONTENT', message_id: messageId, delta },
    })),
    {
      at: start + 20 + words.length * every,
      body: { type: 'TEXT_MESSAGE_END', message_id: messageId },
    },
  ]
}

/** When the last body of `bodies` is sent. */
const end = (bodies: TimedBody[]): number => bodies.at(-1)?.at ?? 0

const finished = (at: number, outcome: string, result: Record<string, unknown>): TimedBody => ({
  at,
  body: { type: 'RUN_FINISHED', outcome, result: { message_id: ANSWER_ID, ...result } },
})

const ANSWER =
  'Fluchtwege müssen nach OIB-Richtlinie 2 bis zu einem sicheren Ort des angrenzenden Geländes führen. ' +
  'In Gebäuden der Gebäudeklasse 4 darf die Gehweglänge zu einem Treppenhaus höchstens 40 m betragen, ' +
  'gemessen von jeder Stelle eines Geschoßes. Für Aufenthaltsräume gilt zusätzlich, dass ein zweiter ' +
  'Fluchtweg erforderlich wird, sobald diese Länge überschritten ist.'

const handOffPreamble =
  'Das ist mehr als eine Frage: Ich gebe sie an eine Recherche ab, die alle Pläne liest.'
const handedOff = (() => {
  const text = prose(handOffPreamble, 1800)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(),
    ...text,
    finished(end(text) + 300, 'handed_off', { text: '', run: RUN }),
  ]
})()

const retracted = (() => {
  const first = prose('Ich sehe mir dazu die Richtlinie an.', 1800)
  const second = prose(ANSWER, end(first) + 1400)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(),
    ...first,
    { at: end(first) + 400, body: { type: 'CUSTOM', name: 'answer_retracted', value: {} } },
    ...second,
    finished(end(second) + 200, 'answered', { text: ANSWER }),
  ]
})()

const failed = (() => {
  const text = prose(ANSWER, 1800).slice(0, 18)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(),
    ...text,
    {
      at: end(text) + 200,
      body: {
        type: 'RUN_ERROR',
        code: 'workflow_error',
        message: 'The model provider closed the connection.',
        details: null,
      },
    },
  ]
})()

const runError = (at: number): TimedBody => ({
  at,
  body: {
    type: 'RUN_ERROR',
    code: 'workflow_error',
    message: 'The model provider closed the connection.',
    details: null,
  },
})

/** The retrieval round fails after its sources: the Herleitung has rows, the answer has no word. */
const failedInSteps = [
  { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
  ...steps(),
  runError(1700),
]

/** The whole answer streamed, then the turn fails where its terminal would have been. */
const failedAtFinish = (() => {
  const text = prose(ANSWER, 1800)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(),
    ...text,
    runError(end(text) + 300),
  ]
})()

/** Steps that start late, so Stop can land between the ack and the first row. */
const slowStart = (() => {
  const text = prose(ANSWER, 2400)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(900),
    ...text,
    finished(end(text) + 200, 'answered', { text: ANSWER }),
  ]
})()

/** The cancelled terminal with what the server sent before Stop. */
const cancelledWith = (sentText: string): TimedBody[] => [finished(150, 'cancelled', { text: sentText })]

/** Fast enough that the reveal is still catching up when Stop is pressed. */
const cancelText = prose(ANSWER, 1800, 25)
const cancelled = [
  { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
  ...steps(),
  ...cancelText.slice(0, -1),
]

const queueFull = [
  { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
  ...steps(),
  finished(1700, 'refused', {
    text: 'Gerade laufen zu viele Recherchen. Bitte versuchen Sie es in einer Minute erneut.',
    job_admission_rejected: true,
    retry_after_seconds: 60,
  }),
]

const choice = [
  { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
  ...steps(),
  {
    at: 1700,
    body: {
      type: 'STEP_FINISHED',
      step: { id: 'clarification', kind: 'clarification', max_turns: 3 },
    },
  },
  {
    at: 1750,
    body: {
      type: 'CUSTOM',
      name: 'interaction_request',
      value: {
        interaction_id: 'ask-choice',
        input: 'choice',
        text: 'Für welche Gebäudeklasse soll ich die Fluchtwege prüfen?',
        options: [
          { id: 'gk3', label: 'Gebäudeklasse 3' },
          { id: 'gk4', label: 'Gebäudeklasse 4' },
          { id: 'gk5', label: 'Gebäudeklasse 5 (über 22 m Fluchtniveau)' },
        ],
        placeholder: null,
        expires_at: 4_102_444_800_000,
      },
    },
  },
]
const choiceAnswer = (() => {
  const text = prose(ANSWER, 600)
  return [
    {
      at: 0,
      body: {
        type: 'CUSTOM',
        name: 'interaction_resolved',
        value: { interaction_id: 'ask-choice', outcome: 'answered' },
      },
    },
    ...text,
    finished(end(text) + 200, 'answered', { text: ANSWER }),
  ]
})()

const PLAN = {
  title: 'Fluchtwege im Bestand und im Zubau',
  sections: [
    'Gebäudeklasse und Fluchtniveau',
    'Gehweglängen je Geschoß',
    'Zweiter Fluchtweg',
    'Abweichungen nach Wiener Bauordnung',
    'Empfehlungen',
  ],
  genre: 'pruefbericht',
  depth: 'gutachten',
}
/** The byte-stable plan envelope (`researcher/clarify.py` `format_plan_for_user`). */
const PLAN_TEXT =
  `**Research Plan Preview**\n\n**Title:** ${PLAN.title}\n\n**Sections:**\n` +
  PLAN.sections.map((section, index) => `  ${index + 1}. ${section}`).join('\n') +
  '\n\n```plan_json\n' +
  JSON.stringify(PLAN) +
  '\n```\n\n---\n' +
  'Reply **approve** to proceed, **shallow** for a quick answer instead, **cancel** to dismiss, or provide feedback to revise the plan.'

const plan = [
  { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
  ...steps(),
  {
    at: 1750,
    body: {
      type: 'CUSTOM',
      name: 'interaction_request',
      value: {
        interaction_id: 'ask-plan',
        input: 'text',
        text: PLAN_TEXT,
        placeholder: null,
        expires_at: 4_102_444_800_000,
      },
    },
  },
]
const planAnswer = [
  {
    at: 0,
    body: {
      type: 'CUSTOM',
      name: 'interaction_resolved',
      value: { interaction_id: 'ask-plan', outcome: 'answered' },
    },
  },
  finished(500, 'handed_off', { text: '', run: RUN }),
]

const PROPOSAL_CARD = {
  type: 'file_operation_proposal',
  title: 'Zwei Ordner unter „Einreichung“ anlegen',
  operation: 'create_folder',
  operations: [
    { folder_name: 'Brandschutz', parent_folder: 'Einreichung' },
    { folder_name: 'Fluchtwegpläne', parent_folder: 'Einreichung' },
  ],
  note: null,
}
const proposal = (() => {
  const text = prose('Ich schlage vor, die Unterlagen so abzulegen:', 1800)
  return [
    { at: 0, body: { type: 'RUN_STARTED', message_id: ANSWER_ID } },
    ...steps(),
    ...text,
    {
      at: end(text) + 200,
      body: {
        type: 'CUSTOM',
        name: 'card',
        value: { index: 0, key: 'proposal-0', card: PROPOSAL_CARD },
      },
    },
    finished(end(text) + 600, 'answered', {
      text: 'Ich schlage vor, die Unterlagen so abzulegen:',
      cards: [{ key: 'proposal-0', card: PROPOSAL_CARD }],
    }),
  ]
})()

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  handed_off: {
    id: 'handed_off',
    label: 'Hand-off to a run',
    note: 'The preamble is replaced by the run block in the same row, at the terminal; the stored run message is adopted into that row 900 ms later (title and ledger may change, the row does not). The Herleitung must never say „Unterbrochen“.',
    question: 'Prüfe alle Fluchtwege im Bestand und im Zubau gegen die OIB-RL 2.',
    project: true,
    script: handedOff,
    runMessageAfterMs: 900,
  },
  answer_retracted: {
    id: 'answer_retracted',
    label: 'Answer retracted mid-stream',
    note: 'A tool round’s preamble streams, is retracted, and the real answer follows. Watch the bubble: it should not vanish and re-enter with a second entrance.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: retracted,
  },
  run_error: {
    id: 'run_error',
    label: 'RUN_ERROR mid-stream',
    note: 'The stream fails after a few words. Watch what happens to the partial text and what the Herleitung says (a failure, not a lost connection).',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: failed,
  },
  cancelled: {
    id: 'cancelled',
    label: 'Stop, mid-reveal',
    note: 'The text arrives faster than it is revealed; Stop is pressed 2.6 s in. What was on screen is what stays; no green „Fertig“.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: cancelled,
    stopAt: 2600,
    afterCancel: cancelledWith,
  },
  error_preack: {
    id: 'error_preack',
    label: 'No ack (error before RUN_STARTED)',
    note: 'The server never acknowledges the question: no RUN_STARTED, no frame. The client reopens the socket after 15 s and sends it again; the second miss, at 30 s, ends the turn with the failure card and its Retry. Watch the waiting state for 30 s: one calm loop, no „Unterbrochen“ before the end.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: [],
  },
  error_steps: {
    id: 'error_steps',
    label: 'RUN_ERROR during the steps',
    note: 'The turn fails after the first retrieval round, before any word of the answer. The Herleitung keeps its rows and says the turn failed (not that the connection was lost); no empty answer bubble.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: failedInSteps,
  },
  error_finish: {
    id: 'error_finish',
    label: 'RUN_ERROR at the finish',
    note: 'The whole answer streams, then the turn fails where RUN_FINISHED would have been. The text on screen stays; the Herleitung says the turn failed, never a green „Fertig“.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: failedAtFinish,
  },
  stop_before_steps: {
    id: 'stop_before_steps',
    label: 'Stop before the first step',
    note: 'Stop is pressed 400 ms in, after the ack and before the Herleitung has a row. Nothing appears after the stop; the header reads „Gestoppt“; no empty answer bubble.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: slowStart,
    stopAt: 400,
    afterCancel: cancelledWith,
  },
  stop_during_steps: {
    id: 'stop_during_steps',
    label: 'Stop during the steps',
    note: 'Stop is pressed 1.6 s in, while the retrieval round is open. The open row closes, nothing else moves, the header reads „Gestoppt“; no answer bubble appears.',
    question: 'Wie lang darf der Fluchtweg in GK 4 sein?',
    script: slowStart,
    stopAt: 1600,
    afterCancel: cancelledWith,
  },
  job_admission_rejected: {
    id: 'job_admission_rejected',
    label: 'Job queue full',
    note: 'The queue refuses the turn: no answer row, the banner speaks. The Herleitung must not claim the answer was lost.',
    question: 'Erstelle einen Prüfbericht zu den Fluchtwegen.',
    script: queueFull,
  },
  hitl_choice: {
    id: 'hitl_choice',
    label: 'Choice prompt, answered',
    note: 'One home for the options (the prompt in the thread). Pick one: the cards lock without losing focus or re-wrapping, and the answer streams below.',
    question: 'Prüfe die Fluchtwege.',
    script: choice,
    afterAnswer: choiceAnswer,
  },
  hitl_plan: {
    id: 'hitl_plan',
    label: 'Plan approval, then hand-off',
    note: 'Approve the plan: the controls fade, the card takes its one-line record („Plan freigegeben · 5 Abschnitte“) in the same slot, and the run block takes the answer’s place.',
    question: 'Erstelle einen Prüfbericht zu den Fluchtwegen.',
    project: true,
    script: plan,
    afterAnswer: planAnswer,
    runMessageAfterMs: 900,
  },
  proposal_accept: {
    id: 'proposal_accept',
    label: 'File proposal, accepted',
    note: 'Press „Übernehmen“: the button keeps its width and focus, each row shows its ✓, and only then the card takes its decided state.',
    question: 'Leg mir Ordner für den Brandschutz an.',
    project: true,
    script: proposal,
  },
}

export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[]

/** The run's message as the BFF stored it (`lib/runs/service.ts` `createRunMessage`), as `GET …/messages` returns it. */
export const storedRunMessage = (title: string, at: Date) => ({
  id: RUN.run_message_id,
  role: 'assistant',
  content: '',
  createdAt: at.toISOString(),
  metadata: {
    messageType: 'agent_response',
    run_ledger: {
      runId: RUN.run_id,
      status: 'angelegt',
      phases: [],
      steps: [],
      startedAt: at.toISOString(),
      updatedAt: at.toISOString(),
    },
    run_title: title,
  },
})
