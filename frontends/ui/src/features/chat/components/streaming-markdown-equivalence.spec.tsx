/**
 * The streamed answer is rendered block by block (`markdown-blocks.ts`), so a
 * reveal step parses only the block that grew. The rule that makes that safe,
 * set in `docs/design/streaming-chat-answer.md` before the blocks existed: for
 * every prefix of the recorded answers, including the settled snapshot and
 * the terminal text, the blocks must render the same HTML as the whole text
 * rendered at once.
 *
 * The candidate is one mounted renderer fed the prefixes in the order the
 * reveal shows them, so its memoised blocks are exercised the way a stream
 * exercises them. The reference is the same renderer with splitting switched
 * off, which renders the text as one document. The prefixes are rendered
 * with the chat's own remark plugins, in streaming mode until the terminal.
 */
import { describe, expect, it, vi } from 'vitest'
import type { PluggableList } from 'unified'
import { render } from '@/test-utils'
import { STREAM_FRAMES } from '@/app/dev/_fixtures/stream-frames'
import { MIN_BLOCK_CHARS, type MarkdownBlock } from '@/shared/components/MarkdownRenderer/markdown-blocks'

type Split = (markdown: string, minChars?: number) => MarkdownBlock[] | null
/** The split the renderer uses: `current` when set, else the real one, kept in `real`. */
const splitter = vi.hoisted(() => ({ current: null as Split | null, real: null as Split | null }))

vi.mock('@/shared/components/MarkdownRenderer/markdown-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/components/MarkdownRenderer/markdown-blocks')>()
  splitter.real = actual.splitMarkdownBlocks
  return {
    ...actual,
    splitMarkdownBlocks: (markdown: string, minChars?: number) =>
      (splitter.current ?? actual.splitMarkdownBlocks)(markdown, minChars),
  }
})

import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { remarkCitationMarkers } from '@/features/layout/lib/citation-markers'
import { remarkCardMarkers } from '@/features/grid-cards/card-markers'
import { remarkFileReferences } from '@/features/layout/lib/file-reference-markers'
import { splitAnswerBody } from '../lib/citations/views'

/** One text the answer's renderer is handed, with what `AgentResponse` parses it with. */
interface Step {
  body: string
  numbers: ReadonlySet<number>
  cards: number
  callout: boolean
  streaming: boolean
}

const stepKey = (step: Step): string =>
  JSON.stringify([step.body, [...step.numbers], step.cards, step.callout, step.streaming])

/**
 * Every prefix of every text a recorded turn went through (the deltas as they
 * add up, the settled snapshot, anything after it), in the order the reveal
 * shows them, then the terminal text whole: the terminal is never paced.
 */
function recordedSteps(name: keyof typeof STREAM_FRAMES): Step[] {
  const steps = new Map<string, Step>()
  const add = (step: Step) => steps.set(stepKey(step), step)
  let text = ''
  let cards = 0
  let callout = false
  for (const frame of STREAM_FRAMES[name].frames) {
    const done = frame.status === 'complete'
    text = done || frame.stream_replace ? frame.content : text + frame.content
    if (Array.isArray(frame.cards)) cards = frame.cards.length
    if (frame.answer_meta !== undefined) callout = Boolean((frame.answer_meta as { callout?: unknown } | null)?.callout)
    const lengths = done ? [text.length] : Array.from({ length: text.length + 1 }, (_, i) => i)
    for (const length of lengths) {
      const { body, numbers } = splitAnswerBody(text.slice(0, length))
      add({ body, numbers, cards, callout, streaming: !done })
    }
  }
  return [...steps.values()]
}

/**
 * Texts the recorded answers do not reach, each one a construct that ties
 * blocks together or sits on a cut: a loose list, fences and math with blank
 * lines inside, setext headings and breaks, two tables, footnotes and
 * definitions (rendered whole), repeated headings, quotes, card and callout
 * markers (placed, stripped, half-written mid-text and at the end), an HTML
 * comment, indented code, and a fence inside a list item.
 */
const CORPUS = [
  'Intro\n\n- a\n\n- b\n  more\n\n  indented para\n\nAfter.\n',
  'Text\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nAfter\n\n~~~\nx\n\n~~~\n\nEnd',
  'Titel\n---\n\nAbsatz\n\n---\n\nZweiter\n===\n\nDrei',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n| 3 |\n\nText',
  'Satz[^1].\n\n[^1]: Fußnote.\n\nMehr.',
  'Mehr [x] und [1].\n\n[x]: https://example.com\n\nEnde',
  '## Bewertung\n\nText\n\n## Bewertung\n\n### Bewertung 2\n\n## Bewertung 2\n\nSchluss',
  'Formel:\n\n$$\na = b\n\nc\n$$\n\nInline $x$.',
  '> Zitat\n\n> zweites\n\nText',
  '[[callout]]\n\nText [1] mit [[card:1]]\n\n[[card:1]]\n\n[[card:9]]\n\nAbsatz [[ca\n\nEnde [[ca',
  '[[card:5]]\n\nText **fett\n\nMehr',
  '<!--\n\nx\n\n-->\n\nText',
  'Text\n\n    code\n\n    more\n\nEnd',
  '1. a\n\n2. b\n\nText\n\n3. c',
  '- item\n\n  ```\n  a\n\n  b\n  ```\n\nText',
]

function corpusSteps(): Step[] {
  const steps: Step[] = []
  for (const text of CORPUS) {
    for (const callout of [false, true]) {
      for (let length = 0; length <= text.length; length++) {
        steps.push({ body: text.slice(0, length), numbers: new Set([1]), cards: 1, callout, streaming: true })
      }
      steps.push({ body: text, numbers: new Set([1]), cards: 1, callout, streaming: false })
      steps.push({ body: text, numbers: new Set(), cards: 0, callout, streaming: false })
    }
  }
  return steps
}

/** `AgentResponse`'s `markerPlugins`, with no file index. */
const pluginsFor = (step: Step): PluggableList => [
  [remarkCitationMarkers, { numbers: step.numbers, anchorPrefix: 'answer-src-', pending: step.streaming }],
  [remarkCardMarkers, { count: step.cards, callout: step.callout, pending: step.streaming }],
  [remarkFileReferences, { fileNames: [] }],
]

/**
 * The first step whose HTML differs between the block renderer (splitting with
 * `split`) and the whole text rendered at once, or `null`.
 */
function firstMismatch(steps: readonly Step[], split: Split): { body: string; blocks: string; whole: string } | null {
  const view = (step: Step, plugins: PluggableList) => (
    <MarkdownRenderer content={step.body} isStreaming={step.streaming} remarkPlugins={plugins} compact />
  )
  const blocks = render(<div />)
  const whole = render(<div />)
  try {
    // The plugin list keeps its identity while its inputs do, as the chat's does.
    let plugins: PluggableList = []
    let pluginsKey = ''
    for (const step of steps) {
      const key = stepKey({ ...step, body: '' })
      if (key !== pluginsKey) [plugins, pluginsKey] = [pluginsFor(step), key]
      splitter.current = split
      blocks.rerender(view(step, plugins))
      splitter.current = () => null
      whole.rerender(view(step, plugins))
      if (blocks.container.innerHTML !== whole.container.innerHTML) {
        return { body: step.body, blocks: blocks.container.innerHTML, whole: whole.container.innerHTML }
      }
    }
    return null
  } finally {
    splitter.current = null
    blocks.unmount()
    whole.unmount()
  }
}

/** Split at every blank line, as if Markdown were block-local: the split this spec exists to refuse. */
const naiveSplit: Split = (markdown) => {
  const blocks: MarkdownBlock[] = []
  let line = 0
  for (const source of markdown.split('\n\n')) {
    blocks.push({ source, line })
    line += source.split('\n').length + 1
  }
  return blocks
}

/** Split after every line. */
const lineSplit: Split = (markdown) => markdown.split('\n').map((source, line) => ({ source, line }))

/** The renderer's split. */
const splitMarkdownBlocks: Split = (markdown) => splitter.real!(markdown)
/** The same split with no minimum block size: a cut at every place the renderer may cut. */
const everyCut: Split = (markdown) => splitter.real!(markdown, 0)

const RECORDED = Object.keys(STREAM_FRAMES) as (keyof typeof STREAM_FRAMES)[]

describe('the streamed answer rendered block by block', () => {
  it.each(RECORDED)('renders every prefix of the recorded %s answer as the whole text does', (name) => {
    const steps = recordedSteps(name)
    expect(firstMismatch(steps, everyCut)).toBeNull()
    expect(firstMismatch(steps, splitMarkdownBlocks)).toBeNull()
  }, 300_000)

  it('renders every prefix of the constructs that reach across blocks as the whole text does', () => {
    expect(firstMismatch(corpusSteps(), everyCut)).toBeNull()
  }, 60_000)

  it.each(RECORDED)('cuts the recorded %s answer, so the checks above are not vacuous', (name) => {
    const terminal = STREAM_FRAMES[name].frames.at(-1)!.content
    expect(everyCut(splitAnswerBody(terminal).body)?.length).toBeGreaterThan(1)
  })

  it('splits a recorded answer longer than a block at the default size', () => {
    const terminal = STREAM_FRAMES.varianten.frames.at(-1)!.content
    expect(splitMarkdownBlocks(splitAnswerBody(terminal).body)?.length).toBeGreaterThan(1)
  })

  it.each(RECORDED)('keeps every cut in the recorded %s answer where it is while the text grows', (name) => {
    const terminal = splitAnswerBody(STREAM_FRAMES[name].frames.at(-1)!.content).body
    for (const split of [everyCut, splitMarkdownBlocks]) {
      let finished: MarkdownBlock[] = []
      for (let length = 0; length <= terminal.length; length++) {
        const blocks = split(terminal.slice(0, length)) ?? []
        // Every block but the last is finished, and must stay as it was.
        expect(blocks.slice(0, finished.length)).toEqual(finished)
        finished = blocks.slice(0, -1)
      }
    }
  })

  it('catches a split that treats Markdown as block-local', () => {
    expect(firstMismatch(corpusSteps(), naiveSplit)).not.toBeNull()
  }, 60_000)

  it('catches a split that cuts inside a block of a recorded answer', () => {
    expect(firstMismatch(recordedSteps('varianten'), lineSplit)).not.toBeNull()
  }, 60_000)
})

describe('a reveal step', () => {
  it('parses only the block that grew', () => {
    let parses = 0
    const counting: PluggableList = [() => () => void (parses += 1)]
    // Each block but the last past the size after which the text is cut.
    const long = ' Satz'.repeat(MIN_BLOCK_CHARS / 5)
    const blocks = [
      `## Erstens\n\n${long}`,
      `Ein Absatz.${long}`,
      `| a | b |\n|---|---|${'\n| 1 | 2 |'.repeat(MIN_BLOCK_CHARS / 10)}`,
      'Der letzte',
    ]
    const { rerender } = render(<MarkdownRenderer content={blocks.join('\n\n')} isStreaming remarkPlugins={counting} />)
    expect(parses).toBe(blocks.length)
    parses = 0
    rerender(<MarkdownRenderer content={`${blocks.join('\n\n')} Absatz wächst`} isStreaming remarkPlugins={counting} />)
    expect(parses).toBe(1)
  })
})
