'use client'

/**
 * Herleitung dev preview: renders the REAL ChatThinking (reasoning trace)
 * expanded, with fixture steps/sources/citations, so the redesigned graph can be
 * reviewed and screenshotted. Not linked
 * anywhere and 404s outside development.
 *
 * The desktop instance is wrapped in the SAME `w-[680px] max-w-full` box the
 * real thread uses (ChatArea's assistant-side spine). Without that the preview
 * rendered ~90px wider than production and made the fan-out look like it fitted
 * when in the real chat it did not.
 *
 * `?variant=` selects the captured scenario:
 *   - (none)   → framing → parallel sources → assessment (findings converge).
 *   - dense    → a research-heavy turn (9 documents across 5 lanes): more
 *     sources than fit in one row, so the fan packs into stacked COLUMNS
 *     instead of degrading to a single vertical chain.
 *   - branches → a live choice prompt WITHOUT findings, so the sources fan IN to
 *     the branches node directly (per-source handles, no single-point collapse);
 *     a long question + many branch options exercise the measured, content-driven
 *     layout (tall nodes must not overlap).
 *   - live     → a turn mid-stream: completed steps + an in-progress web search,
 *     so the live activity phrase, the frontier's flowing dot, executed-step
 *     chips (with the running pulse) and the elapsed pill all render.
 *   - spine    → TWO retrieval rounds: the fan becomes a spine of checkpoints,
 *     each owning the files that fetch returned. Both layers open, because
 *     folding half of a comparison hides the comparison.
 *   - spine-folded → THREE rounds, which is where the graph stops being a shape
 *     and becomes a scroll: the older two layers arrive folded to their counts
 *     and the newest is open. Neither folded caption names a query (PF-12).
 *   - stream   → the spine ARRIVING: a live turn replayed frame by frame (the
 *     checkpoint, then the files it returned, three rounds), so the streaming
 *     motion can be watched and measured. One instance, at the column width.
 *     `&every=<ms>` sets the pace (default 1400); `&every=0` waits for
 *     `window.__herleitung.next()`, which a headless capture calls per round.
 *     `&settle=1` lands the turn after the last frame; without it the turn
 *     stays live, which is the at-rest state worth measuring.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import type { ThinkingStep, CitationSource } from '@/features/chat/types'

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
    {
      key: 'buero',
      label: 'Büroarchiv',
      hitCount: 1,
      signal: 'office',
      sources: [{ name: 'Brandschutzkonzept_2023.pdf', detail: 'Referenzprojekt' }],
    },
  ],
}

/**
 * What the ANSWER cited, as opposed to what retrieval merely returned.
 *
 * These name the same documents the lanes above hold, so the fan-out can mark
 * which cards became `[1]` and `[2]` and leave the rest reading "gelesen, nicht
 * verwendet" — the distinction the trace could not draw while it was built from
 * the retrieval half alone.
 */
const citations: CitationSource[] = [
  {
    id: 'c1',
    content: '[KB] OIB-RL_2_Brandschutz.pdf, p.18',
    citationKey: 'OIB-RL_2_Brandschutz.pdf, p.18',
    fileName: 'OIB-RL_2_Brandschutz.pdf',
    collection: 'oib_knowledge',
    title: 'OIB-Richtlinie 2 – Brandschutz',
    origin: 'kb',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    page: 18,
    number: 1,
    isCited: true,
  },
  {
    id: 'c2',
    content: '[RIS] Bauordnung für Wien § 108',
    url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    title: 'Bauordnung für Wien',
    origin: 'ris',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    number: 2,
    isCited: true,
  },
]

const defaultCommon = {
  steps: [step],
  isThinking: false as const,
  defaultOpen: true,
  userQuestion:
    'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?',
  answerConfidence: 'high' as const,
  citations,
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  messageFiles: [{ id: 'f1', fileName: 'Grundriss_EG.pdf' }],
}

// Dense scenario: what a real Tiefenrecherche turn looks like — nine documents
// across five lanes. This is the case the old layout got wrong: the single-row
// fan needed ~1.4k px, did not fit the 680px thread column, and collapsed the
// whole graph into one vertical list. It must now pack into stacked columns.
const denseStep: ThinkingStep = {
  ...step,
  id: 'kb-dense',
  traceLanes: [
    {
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: 5,
      signal: 'law',
      sources: [
        { name: 'oib-rl_2_ausgabe_mai_2023.pdf', detail: 'p.12' },
        { name: 'oib-rl_2.3_ausgabe_mai_2023.pdf', detail: 'p.4' },
        { name: 'oib-rl_4_ausgabe_mai_2023.pdf', detail: 'p.9' },
      ],
    },
    {
      key: 'baurecht_oib_erlaeuterung',
      label: 'OIB-Erläuterung',
      hitCount: 2,
      signal: 'law',
      sources: [{ name: 'erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf', detail: 'p.7' }],
    },
    {
      key: 'baurecht_ris',
      label: 'Bundesrecht',
      hitCount: 3,
      signal: 'law',
      sources: [
        { name: 'Bauordnung für Wien', detail: '§ 108 Fluchtwege' },
        { name: 'Wiener Garagengesetz', detail: '§ 4' },
      ],
    },
    {
      key: 'projekt',
      label: 'Projektwissen',
      hitCount: 2,
      signal: 'project',
      sources: [
        { name: 'Grundriss_EG.pdf', detail: 'Seite 2' },
        { name: 'Schnitt_A-A.pdf', detail: 'Seite 1' },
      ],
    },
    {
      key: 'buero',
      label: 'Büroarchiv',
      hitCount: 1,
      signal: 'office',
      sources: [{ name: 'Brandschutzkonzept_2023.pdf', detail: 'Referenzprojekt' }],
    },
  ],
}

const denseCommon = {
  ...defaultCommon,
  steps: [denseStep],
}

// ── the spine, and its folds ────────────────────────────────────────────────
// Two or more retrieval rounds turn the fan into a SPINE: a checkpoint, the
// files THAT fetch returned, then the next checkpoint. Each layer folds to its
// count, and a spine of three or more arrives with everything but the newest
// layer folded (`SPINE_FOLD_THRESHOLD`).
//
// The step shapes here are the wire's, taken from
// `tests/fixtures/herleitung/two_search_rounds_steps.json`: the round stamp on
// each hit is what splits one merged `knowledge_search` completion across the
// fetches, and the `reason` is the model's own conclusion — never the query
// (PF-12), which is why every `query` below is a string the graph must not show.

/** One `status:retrieval:N` line: the checkpoint that caused fetch N. */
const retrievalStep = (index: number, query: string, reason: string): ThinkingStep => ({
  id: `retrieval-${index}`,
  userMessageId: 'msg-1',
  category: 'agents',
  functionName: `status:retrieval:${index}`,
  displayName: `status:retrieval:${index}`,
  content: JSON.stringify({
    kind: 'status',
    channel: 'live',
    slot: `retrieval:${index}`,
    key: 'status.retrieval.withQuery',
    values: { corpus: 'knowledge', query },
    tools: ['knowledge_search'],
    reason,
  }),
  isComplete: true,
  timestamp: new Date('2024-01-15T14:30:00'),
})

/**
 * ONE `knowledge_search` completion carrying every round's hits, which is what
 * production actually delivers: the store merges completions by function name,
 * so stream order cannot tell two fetches apart and the `round` stamp is the
 * only join.
 */
const mergedHits = (
  rounds: ReadonlyArray<
    ReadonlyArray<{ name: string; detail: string; lane: 'law' | 'project' | 'office' }>
  >
): ThinkingStep => ({
  id: 'kb-spine',
  userMessageId: 'msg-1',
  category: 'tools',
  functionName: 'knowledge_search',
  displayName: 'Knowledge Search',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-15T14:30:02'),
  traceLanes: rounds.flatMap((hits, round) =>
    (['law', 'project', 'office'] as const).flatMap((signal) => {
      const laneHits = hits.filter((hit) => hit.lane === signal)
      if (laneHits.length === 0) return []
      return [
        {
          key: signal === 'law' ? 'baurecht_oib' : signal === 'project' ? 'projekt' : 'buero',
          label:
            signal === 'law'
              ? 'OIB-Richtlinie'
              : signal === 'project'
                ? 'Projektwissen'
                : 'Büroarchiv',
          hitCount: laneHits.length,
          signal,
          sources: laneHits.map((hit) => ({ name: hit.name, detail: hit.detail, round })),
        },
      ]
    })
  ),
})

const SPINE_ROUNDS = [
  {
    query: 'Fluchtweglänge GK4',
    reason: 'Ich brauche zuerst die Grundregel für Fluchtweglängen in der Gebäudeklasse 4.',
    hits: [
      { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'Pkt. 3.2', lane: 'law' as const },
      { name: 'Bauordnung für Wien', detail: '§ 108', lane: 'law' as const },
    ],
  },
  {
    query: 'Treppenraum Entrauchung',
    reason:
      'Die Grundregel steht — offen ist, ob der nördliche Treppenraum als Sicherheitstreppenhaus ausgeführt ist.',
    hits: [
      { name: 'Brandschutzkonzept.pdf', detail: 'Seite 4', lane: 'project' as const },
      { name: 'Grundriss_EG.pdf', detail: 'Seite 2', lane: 'project' as const },
      { name: 'Schnitt_A-A.pdf', detail: 'Seite 1', lane: 'project' as const },
    ],
  },
  {
    query: 'Referenzprojekt Sicherheitstreppenhaus RWA',
    reason:
      'Der Plan zeigt eine RWA im Treppenraum; wie das Büro das zuletzt nachgewiesen hat, steht im Archiv.',
    hits: [
      { name: 'Brandschutzkonzept_2023.pdf', detail: 'Referenzprojekt', lane: 'office' as const },
    ],
  },
]

const spineCommon = (roundCount: number) => ({
  ...defaultCommon,
  steps: [
    ...SPINE_ROUNDS.slice(0, roundCount).map((round, i) =>
      retrievalStep(i, round.query, round.reason)
    ),
    mergedHits(SPINE_ROUNDS.slice(0, roundCount).map((round) => round.hits)),
  ],
  citations: undefined,
  userQuestion:
    'Reichen die beiden Rettungswege im Regelgeschoss, wenn der nördliche Treppenraum kein Sicherheitstreppenhaus ist?',
})

// Branches scenario: a live choice prompt and NO findings, so the parallel
// sources converge directly onto the branches node. A long question and four
// branch options make the framing + branches nodes tall — the measured layout
// must place them without overlap.
const branchesCommon = {
  steps: [step],
  isThinking: false as const,
  defaultOpen: true,
  userQuestion:
    'Für ein sechsgeschossiges Bürogebäude der Gebäudeklasse 5 in Wien mit einer Bruttogeschossfläche von 1.200 m² pro Ebene: Wie viele bauliche Rettungswege sind nach OIB-Richtlinie 2 erforderlich, und welche Anforderungen gelten für die maximale Fluchtweglänge sowie die Ausbildung der Treppenhäuser?',
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  escalationReason: 'shallow→deep',
  choicePrompt: {
    promptId: 'p-dev',
    text: 'Wie möchtest du die Rettungsweg-Prüfung fortsetzen?',
    options: [
      'Fluchtweglängen für jede Ebene einzeln prüfen',
      'Treppenhaus-Anforderungen (Sicherheitstreppenhaus) vertiefen',
      'Vergleich mit dem Referenzprojekt aus dem Büroarchiv',
      'Zusammenfassung aller OIB-Anforderungen als Checkliste',
    ],
    isResponded: false,
  },
}

// Live scenario: a turn mid-stream — the agent's own step still open, the KB
// hit, and an in-progress web search. Exercises the live activity phrase (shown only
// while the step actually runs), the frontier's flowing dot, the executed-step chips
// with the running pulse, and the elapsed-time pill.
const liveCommon = {
  steps: [
    {
      id: 'agent',
      userMessageId: 'msg-1',
      category: 'agents' as const,
      functionName: 'shallow_research_agent',
      displayName: 'Shallow Research Agent',
      content: '',
      isComplete: false,
      timestamp: new Date('2024-01-15T14:30:00'),
    },
    { ...step, id: 'kb' },
    {
      id: 'web',
      userMessageId: 'msg-1',
      category: 'tools' as const,
      functionName: 'web_search_tool',
      displayName: 'Web Search Tool',
      content: '',
      isComplete: false,
      timestamp: new Date('2024-01-15T14:30:05'),
    },
  ],
  isThinking: true as const,
  defaultOpen: true,
  userQuestion: defaultCommon.userQuestion,
  enabledDataSources: defaultCommon.enabledDataSources,
}

// Stream scenario: the frames a live spine turn delivers, in wire order — the
// runner's own step, then per round its `status:retrieval:N` checkpoint and,
// when the tool returns, the merged `knowledge_search` completion growing by
// that round's hits (the store merges completions by name, so it is ONE step
// that grows, not one per round).
const streamFrames = (): ThinkingStep[][] => {
  const agent: ThinkingStep = { ...liveCommon.steps[0]! }
  const frames: ThinkingStep[][] = [[agent]]
  let steps: ThinkingStep[] = [agent]
  SPINE_ROUNDS.forEach((round, i) => {
    steps = [...steps, retrievalStep(i, round.query, round.reason)]
    frames.push(steps)
    const hits = mergedHits(SPINE_ROUNDS.slice(0, i + 1).map((r) => r.hits))
    steps = [...steps.filter((s) => s.id !== 'kb-spine'), hits]
    frames.push(steps)
  })
  return frames
}

declare global {
  interface Window {
    __herleitung?: { next: () => number; frames: number }
  }
}

function StreamPreview({ every, settle }: { every: number; settle: boolean }) {
  const [frames] = useState(streamFrames)
  const [frame, setFrame] = useState(0)
  const done = frame >= frames.length - 1
  useEffect(() => {
    window.__herleitung = {
      frames: frames.length,
      next: () => {
        setFrame((f) => Math.min(f + 1, frames.length - 1))
        return frames.length
      },
    }
    return () => {
      delete window.__herleitung
    }
  }, [frames])
  useEffect(() => {
    if (every <= 0 || done) return
    const timer = setTimeout(() => setFrame((f) => f + 1), every)
    return () => clearTimeout(timer)
  }, [every, done, frame])
  const [landed, setLanded] = useState(false)
  useEffect(() => {
    if (!settle || !done) return
    const timer = setTimeout(() => setLanded(true), Math.max(every, 1400))
    return () => clearTimeout(timer)
  }, [settle, done, every])
  return (
    <ChatThinking
      steps={frames[frame]!}
      isThinking={!landed}
      defaultOpen
      userQuestion={spineCommon(3).userQuestion}
      enabledDataSources={defaultCommon.enabledDataSources}
    />
  )
}

export default function HerleitungPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the requested variant after mount (not during render) so the fixture is
  // stable and screenshot-deterministic.
  const [variant, setVariant] = useState<string | null>(null)
  const [stream, setStream] = useState({ every: 1400, settle: false })
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    setVariant(params.get('variant'))
    const every = Number(params.get('every') ?? 1400)
    setStream({ every: Number.isFinite(every) ? every : 1400, settle: params.get('settle') === '1' })
  }, [])

  if (variant === 'stream') {
    return (
      <main className="bg-background min-h-dvh px-4 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <h1 className="text-muted-foreground font-mono text-xs" data-testid="herleitung-preview">
            /dev/herleitung?variant=stream — a live spine turn, replayed frame by frame
          </h1>
          <div className="w-[680px] max-w-full">
            <StreamPreview every={stream.every} settle={stream.settle} />
          </div>
        </div>
      </main>
    )
  }

  const common =
    variant === 'branches'
      ? branchesCommon
      : variant === 'live'
        ? liveCommon
        : variant === 'dense'
          ? denseCommon
          : variant === 'spine'
            ? spineCommon(2)
            : variant === 'spine-folded'
              ? spineCommon(3)
              : defaultCommon
  const label =
    variant === 'branches'
      ? '/dev/herleitung?variant=branches — sources → branches (no findings)'
      : variant === 'live'
        ? '/dev/herleitung?variant=live — mid-stream turn (live status + chips)'
        : variant === 'dense'
          ? '/dev/herleitung?variant=dense — 9 sources, packed into stacked columns'
          : variant === 'spine'
            ? '/dev/herleitung?variant=spine — two retrieval rounds, both layers open'
            : variant === 'spine-folded'
              ? '/dev/herleitung?variant=spine-folded — three rounds, older layers folded'
              : '/dev/herleitung — reasoning graph (desktop + mobile)'

  return (
    <main className="bg-background min-h-dvh px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <h1 className="text-muted-foreground font-mono text-xs" data-testid="herleitung-preview">
          {label}
        </h1>
        {/* Same box the real thread gives the Herleitung (ChatArea's
            assistant-side spine) — the preview must not be wider than
            production, or the fan-out looks like it fits when it doesn't. */}
        <div className="w-[680px] max-w-full">
          <ChatThinking {...common} />
        </div>
        <div>
          <div className="text-muted-foreground mb-2 font-mono text-xs">↓ mobile width (380px)</div>
          <div className="w-[380px] max-w-full">
            <ChatThinking {...common} />
          </div>
        </div>
      </div>
    </main>
  )
}
