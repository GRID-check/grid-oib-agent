/**
 * The frames a NAT backend sends for one `oib2` turn, as `/dev/stream-socket`
 * plays them through a stubbed `WebSocket`.
 *
 * `heavy` is what a production trace of one turn showed on the wire: NAT's
 * stock `StepAdaptor` (`nat/front_ends/fastapi/step_adaptor.py`) sends one
 * `system_intermediate_message` per LLM token chunk, and every one of them
 * carries the whole prompt `repr` (earlier tool results and their
 * `## Trace-Lanes` block included) plus the output so far, 17 to 31 KB a
 * frame; each knowledge search sends its full output twice more, as the
 * `Tool:` frame and as `Function Complete:`. `light` is the same turn as a
 * compacted step adaptor would send it: no token frames, an LLM call as a
 * start and an end without the prompt and with its output capped at 4 KB, and
 * a search's output reduced to its Trace-Lanes block and a short excerpt.
 *
 * The answer that follows is the recorded `oib2` turn (`_fixtures/
 * stream-frames.ts`): masthead, deltas, `stream_replace`, cards and terminal,
 * each frame carrying the extras it was recorded with.
 *
 * Frames are JSON strings built once, before the turn, with two placeholders
 * the fake server fills at send time: the conversation id, and the id of the
 * user message the answer frames answer (`parent_id`, which the client's
 * stale-frame guard compares against its active turn).
 */

import { STREAM_FRAMES, type RecordedFrame } from '../_fixtures/stream-frames'

export type ScriptMode = 'heavy' | 'light'

export const PARENT_PLACEHOLDER = '__STREAM_SOCKET_PARENT__'
export const CONVERSATION_PLACEHOLDER = '__STREAM_SOCKET_CONVERSATION__'

export type FrameKind = 'step' | 'delta' | 'response' | 'terminal'

export interface ScriptFrame {
  /** Milliseconds after the user message reached the server. */
  at: number
  kind: FrameKind
  data: string
}

export interface NatScript {
  question: string
  frames: ScriptFrame[]
  /** Bytes of step frames, for the probe: what the client had to parse. */
  stepBytes: number
}

const MODEL = 'openai/gpt-5.1'
const TOOL = 'knowledge_search'
/** The trace's cadence: ~25 intermediate frames a second. */
const STEP_INTERVAL_MS = 40
const ROUNDS = 3
const TOKEN_FRAMES_PER_ROUND = 88
const SYNTHESIS_TOKEN_FRAMES = 30
/** What a compacted adaptor keeps of an LLM call's output. */
const LIGHT_OUTPUT_CAP = 4096

const QUERIES = ['OIB-Richtlinie 2 Geltungsbereich', 'OIB-RL 2 Ausgabe 2023 Abweichungen Landesrecht', 'Brandschutz Fluchtwege Gebäudeklassen']

/** NAT runs `html.escape(…, quote=False)` over every payload. */
const htmlEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const FILLER =
  'Die Anforderungen an den Brandschutz richten sich nach der Gebäudeklasse, der Nutzung und der Anzahl der oberirdischen Geschoße. ' +
  'Tragende Bauteile sind so auszuführen, dass die Standsicherheit im Brandfall für den erforderlichen Zeitraum gewährleistet bleibt. ' +
  'Fluchtwege müssen jederzeit sicher benutzbar sein; Abweichungen sind nur zulässig, wenn das gleiche Schutzniveau nachgewiesen wird. '

const filler = (chars: number): string => FILLER.repeat(Math.ceil(chars / FILLER.length)).slice(0, chars)

/** The `## Trace-Lanes` block a knowledge search appends, every hit stamped with its round. */
const traceLanesBlock = (round: number): string => {
  const hits = (prefix: string, count: number, page: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `${prefix}_${i + 1}.pdf`, detail: `p.${page + i}`, round }))
  const lanes = [
    { key: 'baurecht_oib', label: 'OIB-Richtlinie', sources: [{ name: 'oib-rl_2_ausgabe_mai_2023.pdf', detail: `p.${4 + round}`, round }, ...hits('oib-rl_2_erlaeuterungen', 5, 10)] },
    { key: 'projekt', label: 'Projektwissen', sources: hits('Brandschutzkonzept_Stiege', 3, 3) },
    { key: 'buero', label: 'Büroarchiv', sources: hits('Mustervorlage_Brandschutz', 2, 1) },
  ].map((lane) => ({ ...lane, hitCount: lane.sources.length }))
  return `## Trace-Lanes\n${JSON.stringify({ lanes })}`
}

/** A knowledge search's output: `--- Result N ---` blocks, ~20 KB, then its Trace-Lanes. */
const kbOutput = (round: number): string => {
  const results = Array.from({ length: 10 }, (_, i) =>
    [
      `--- Result ${i + 1} ---`,
      `Source: ${i === 0 ? 'oib-rl_2_ausgabe_mai_2023.pdf' : `oib-rl_2_erlaeuterungen_${i}.pdf`}`,
      'Collection: oib_knowledge',
      `Page: ${4 + round + i}`,
      `Citation: oib-rl_2_ausgabe_mai_2023.pdf, p.${4 + round + i}`,
      'Content Type: text',
      `Relevance Score: ${(0.92 - i * 0.03).toFixed(2)}`,
      '',
      filler(1850),
      '',
    ].join('\n')
  )
  return `Found ${results.length} relevant document(s):\n\n${results.join('\n')}\n${traceLanesBlock(round)}\n`
}

/** A search's output as the compacted adaptor sends it: an excerpt and the lanes. */
const kbOutputLight = (round: number): string =>
  `${kbOutput(round).slice(0, 600)}\n…\n${traceLanesBlock(round)}\n`

/** LangChain's message list, `str()`-ed: the system prompt, the question and every tool result so far. */
const promptRepr = (question: string, round: number): string => {
  const messages = [
    `SystemMessage(content='${filler(16000)}', additional_kwargs={}, response_metadata={})`,
    `HumanMessage(content='${question}', additional_kwargs={}, response_metadata={})`,
  ]
  for (let r = 0; r < round; r++) {
    messages.push(
      `AIMessage(content='', additional_kwargs={'tool_calls': [{'id': 'call_${r}', 'function': {'arguments': '{"query": "${QUERIES[r]}"}', 'name': '${TOOL}'}, 'type': 'function'}]}, response_metadata={'finish_reason': 'tool_calls'})`,
      // The model is handed the tail of each result, Trace-Lanes block included.
      `ToolMessage(content='${kbOutput(r).slice(-5000).replace(/\n/g, '\\n')}', name='${TOOL}', tool_call_id='call_${r}')`
    )
  }
  return `[${messages.join(', ')}]`
}

const REASONING =
  'Ich prüfe zuerst den Geltungsbereich der Richtlinie und dann die Ausgabe, die im Bundesland verbindlich ist. '

/** The model's output after `chunk` of `total` token frames. */
const outputAfter = (chunk: number, total: number, text: string): string =>
  text.slice(0, Math.ceil((text.length * chunk) / total))

let stepCounter = 0

const intermediate = (name: string, payload: string): string =>
  JSON.stringify({
    type: 'system_intermediate_message',
    id: `step-${++stepCounter}`,
    thread_id: 'default',
    parent_id: 'fn-chat_deepresearcher_agent',
    conversation_id: CONVERSATION_PLACEHOLDER,
    content: { name, payload },
    status: 'in_progress',
    timestamp: new Date(2026, 8, 24, 9, 0).toISOString(),
  })

const jsonBlock = (label: 'Function Input' | 'Function Output', body: string): string =>
  `**${label}:**\n\`\`\`json\n${htmlEscape(body)}\n\`\`\``

/** `status:retrieval:N` as `turn_status.push_custom_step` sends it: a balanced start and end. */
const statusFrames = (round: number): string[] => {
  const body = JSON.stringify({
    kind: 'status',
    channel: 'live',
    slot: `retrieval:${round}`,
    key: 'status.retrieval.withQuery',
    values: { corpus: 'knowledge', query: QUERIES[round] },
    tools: [TOOL],
  })
  return [
    intermediate(`Function Start: status:retrieval:${round}`, jsonBlock('Function Input', body)),
    intermediate(`Function Complete: status:retrieval:${round}`, `${jsonBlock('Function Input', body)}${jsonBlock('Function Output', body)}`),
  ]
}

/** One LLM call: NAT's `_handle_llm`, a frame for the start and one per token chunk. */
const llmFrames = (mode: ScriptMode, prompt: string, output: string, tokenFrames: number): string[] => {
  const input = `**Input:**\n\`\`\`python\n${htmlEscape(prompt)}\n\`\`\``
  if (mode === 'light') {
    return [
      intermediate(MODEL, ''),
      intermediate(MODEL, `**Output:**\n${htmlEscape(output.slice(0, LIGHT_OUTPUT_CAP))}`),
    ]
  }
  return [
    intermediate(MODEL, input),
    ...Array.from({ length: tokenFrames }, (_, i) =>
      intermediate(MODEL, `${input}\n\n**Output:**\n${htmlEscape(outputAfter(i + 1, tokenFrames, output))}`)
    ),
  ]
}

/** One knowledge search: function start, the tool's start and end, function complete. */
const searchFrames = (mode: ScriptMode, round: number): string[] => {
  const input = JSON.stringify({ query: QUERIES[round], shelves: ['base', 'project'] })
  const output = mode === 'heavy' ? kbOutput(round) : kbOutputLight(round)
  const toolInput = `**Input:**\n\`\`\`json\n${htmlEscape(input)}\n\`\`\``
  return [
    intermediate(`Function Start: ${TOOL}`, jsonBlock('Function Input', input)),
    intermediate(`Tool: ${TOOL}`, toolInput),
    intermediate(`Tool: ${TOOL}`, `${toolInput}\n\n**Output:**\n\`\`\`python\n${htmlEscape(output)}\n\`\`\``),
    intermediate(
      `Function Complete: ${TOOL}`,
      `${jsonBlock('Function Input', input)}**Function Output:**\n\`\`\`python\n${htmlEscape(output)}\n\`\`\``
    ),
  ]
}

/**
 * The step frames, in order. Light keeps the heavy turn's clock: each LLM
 * call's end lands where its last token frame would have, so the two modes
 * differ in what the frames carry and how many there are, not in when the
 * answer starts.
 */
const stepFrames = (mode: ScriptMode, question: string): { at: number; data: string }[] => {
  const out: { at: number; data: string }[] = []
  let clock = 0
  const push = (frames: string[], spanFrames = frames.length) => {
    const span = spanFrames * STEP_INTERVAL_MS
    frames.forEach((data, i) =>
      out.push({ at: clock + (frames.length > 1 ? Math.round((span * i) / (frames.length - 1 || 1)) : 0), data })
    )
    clock += span + STEP_INTERVAL_MS
  }
  for (let round = 0; round < ROUNDS; round++) {
    push(statusFrames(round))
    push(llmFrames(mode, promptRepr(question, round), REASONING.repeat(6), TOKEN_FRAMES_PER_ROUND), TOKEN_FRAMES_PER_ROUND + 1)
    push(searchFrames(mode, round))
  }
  const answer = STREAM_FRAMES.oib2.frames.at(-1)?.content ?? ''
  push(llmFrames(mode, promptRepr(question, ROUNDS), answer, SYNTHESIS_TOKEN_FRAMES), SYNTHESIS_TOKEN_FRAMES + 1)
  return out
}

/** The extras a recorded frame carries besides its clock, status and text. */
const extrasOf = (frame: RecordedFrame): Record<string, unknown> => {
  const { t: _t, status: _status, content: _content, ...extras } = frame
  return extras
}

const responseKind = (frame: RecordedFrame): FrameKind => {
  if (frame.status === 'complete') return 'terminal'
  if (frame.content && !frame.stream_replace) return 'delta'
  return 'response'
}

/** The recorded answer as `system_response_message` frames, `speed` times its recorded pace, from `start` ms. */
const answerFrames = (start: number, speed: number): ScriptFrame[] => {
  const frames = STREAM_FRAMES.oib2.frames
  const t0 = frames[0]?.t ?? 0
  return frames.map((frame, i) => ({
    at: start + Math.round(((frame.t - t0) * 1000) / speed),
    kind: responseKind(frame),
    data: JSON.stringify({
      type: 'system_response_message',
      id: `resp-${i}`,
      thread_id: 'default',
      parent_id: PARENT_PLACEHOLDER,
      conversation_id: CONVERSATION_PLACEHOLDER,
      content: { text: frame.content },
      status: frame.status,
      timestamp: new Date(2026, 8, 24, 9, 1).toISOString(),
      ...extrasOf(frame),
    }),
  }))
}

export const buildNatScript = (mode: ScriptMode, speed: number): NatScript => {
  const question = STREAM_FRAMES.oib2.question
  const steps = stepFrames(mode, question)
  const answerStart = (steps.at(-1)?.at ?? 0) + 300
  return {
    question,
    frames: [...steps.map(({ at, data }) => ({ at, kind: 'step' as const, data })), ...answerFrames(answerStart, speed)],
    stepBytes: steps.reduce((sum, { data }) => sum + data.length, 0),
  }
}
