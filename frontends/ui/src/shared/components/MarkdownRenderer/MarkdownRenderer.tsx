'use client'

import { Circle, CircleCheck } from 'lucide-react'
import { HorizontalScroll } from '@/components/ui/horizontal-scroll'
import { type FC, type ReactNode, createContext, memo, useContext, useMemo } from 'react'
import { useTranslations } from '@/i18n'
import dynamic from 'next/dynamic'
import ReactMarkdown, { type Components, type ExtraProps, type Options } from 'react-markdown'
import type { PluggableList } from 'unified'
import rehypeKatex from 'rehype-katex'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { Chip } from '@/components/ui/chip'
import type { MarkdownRendererProps } from './types'
import { scrollToAnchor, useInPageAnchorRenderer } from './anchor-context'
import { MARKDOWN_SLOT_TAG, useMarkdownSlotRenderer } from './slot-context'
import { isInternalHref, useInternalLinkRenderer } from './internal-link-context'
import { markdownHeadings } from './headings'
import {
  type MarkdownBlock,
  rehypeBlockSeparator,
  remarkBlockContinues,
  splitMarkdownBlocks,
} from './markdown-blocks'
import { getLanguageFromClassName, headingAnchorId, isMermaidFence } from './utils'
import { isStatusTone, statusTone } from './status-marks'
import { parseTally, rehypeTableShape } from './table-shape'
import { isDelimiterRow } from '@/lib/text/markdown-table'
import { normalizeDirectiveFences } from '@/lib/text/answer-directives'
import {
  ANSWER_BLOCK_LABEL_TAG,
  ANSWER_BLOCK_TAG,
  ANSWER_ENERGY_TAG,
  ANSWER_MARKER_TAG,
  ANSWER_PROJECT_TAG,
  remarkAnswerDirectives,
} from './directives'
import {
  BLOCK_BODY_TAG,
  COMPARE_LABEL_TAG,
  COMPARE_ROW_TAG,
  COMPARE_STACK_TAG,
  COMPARE_TITLE_TAG,
  COMPARE_VALUE_TAG,
  COMPARE_VARIANT_TAG,
  FIGURE_LABEL_TAG,
  FIGURE_LIMIT_TAG,
  FIGURE_TAG,
  FIGURE_VALUE_TAG,
  FIGURES_TAG,
  NOT_FOUND_TAG,
  PANE_TAG,
  STEP_DETAIL_TAG,
  STEP_DUE_TAG,
  STEP_HEAD_TAG,
  SUBSUMPTION_PART_TAG,
  SUBSUMPTION_TAG,
  TASK_CELL,
  rehypeDirectiveShape,
} from './directive-shape'
import {
  AnswerBlock,
  AnswerBlockBody,
  AnswerBlockLabel,
  AnswerBlockquote,
  AnswerEnergy,
  AnswerMarker,
  CompareLabel,
  CompareRow,
  CompareStack,
  CompareValue,
  CompareVariant,
  Figure,
  Figures,
  NotFound,
  Pane,
  StepItem,
  StepPart,
  Subsumption,
  TaskCellContent,
} from './directive-blocks'
import { AnswerProject, CasesScope, hasCases, useCasesDecision } from './project-binding'
import {
  ListCase,
  MarkChip,
  PassedCheck,
  RoleChip,
  cellChipClass,
  useOutcomeLabel,
  StepList,
  ValueBar,
  dataCellClass,
  headerCellClass,
  tableClass,
  tableFrameClass,
  tableRowClass,
  tableVariant,
} from './answer-atoms'
import { useRowActionRenderer } from './answer-block-context'

/** Module-level so the list keeps one identity: a new array re-parses the document. */
const REHYPE_PLUGINS: PluggableList = [[rehypeKatex, { throwOnError: false }], rehypeTableShape, rehypeDirectiveShape]

/**
 * A ```mermaid fence, drawn instead of printed.
 *
 * `dynamic` with `ssr: false` for the same reason the BIM preview uses it: the
 * component reaches for a DOM (mermaid lays out a graph by measuring text), and
 * everything behind this boundary — the renderer, the SVG validator and, one
 * `import()` further in, mermaid itself — stays out of the bundle of an answer
 * that has no diagram in it. Measured: mermaid's first flowchart render pulls
 * 214 KB gzipped, and a reader who never meets a fence pays none of it.
 *
 * The fallback while the chunk loads is deliberately nothing rather than a
 * spinner: the block below it is about to be replaced, and a spinner that
 * resolves in one frame reads as a fault.
 */
const MermaidDiagram = dynamic(
  () =>
    import('@/features/diagrams/components/mermaid-diagram').then(
      (module) => module.MermaidDiagram
    ),
  { ssr: false }
)

/**
 * The text alignment a GFM table wrote into its delimiter row (`|---:|`).
 *
 * react-markdown hands it to the custom `th`/`td` either as the legacy `align`
 * prop or as `style.textAlign` (which of the two depends on the mdast→hast
 * version in play), and the previous components read neither — so every column
 * of every table rendered left-aligned, and the right-aligned number columns
 * the agent deliberately writes (Werte, Breiten, Fristen) lost their alignment.
 */
function cellAlignClass(
  align: string | undefined,
  style: React.CSSProperties | undefined
): string | undefined {
  const alignment = style?.textAlign ?? align
  if (alignment === 'center') return 'text-center'
  if (alignment === 'right') return 'text-right'
  return undefined
}

function getTextFromChildren(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextFromChildren).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextFromChildren((node as React.ReactElement<{ children?: ReactNode }>).props.children)
  }
  return ''
}

/**
 * Whether a fenced code block is the one a streaming text is still writing.
 *
 * Read off the parsed node, not counted in the text: CommonMark already runs
 * an unclosed fence to the end of its container, so the block the parser hands
 * over IS the half-written one. It is still open when it ends on the last line
 * of the text and that line is not a fence closing it. Counting ``` in the raw
 * text missed a `~~~` fence and one indented inside a list item, and drew those
 * from half-written source on every token. Only the last block can be open:
 * every fence before it is complete and may be drawn while the answer is still
 * arriving (ADR-0066).
 */
export function isOpenFence(lines: readonly string[], start: number, end: number): boolean {
  const last = lines.length
  if (end < last) return false
  const opener = lines[start - 1]?.match(/(`{3,}|~{3,})/)?.[1]
  if (!opener || end <= start) return true
  // Container prefixes (`>`, list indentation) sit before a closing fence.
  const closer = lines[end - 1]?.match(/^[\s>]*(`{3,}|~{3,})\s*$/)?.[1]
  return !(closer && closer[0] === opener[0] && closer.length >= opener.length)
}

// Exported for its own spec. It is the one part of this module with a cost that
// depends on the shape of the input rather than its size, so it is measured
// directly: timing it through a React render measures the render.
/**
 * Stabilize half-arrived markdown DURING streaming so partial syntax doesn't
 * flip the layout token-by-token.
 *
 * A GFM table whose delimiter row (`|---|`) hasn't streamed in yet — the
 * header row alone would be mis-parsed. We hold the trailing header-only table
 * lines back until the delimiter row exists, rendering them as plain text for
 * the moment (they re-parse as a table once the delimiter arrives).
 *
 * A half-arrived fence needs nothing here: CommonMark runs an unclosed fence
 * to the end of its container, so it already renders as the (small) code block
 * it will become. See {@link isOpenFence} for how the renderer knows it is open.
 *
 * This only runs while `isStreaming` is true; finalized content is passed
 * through untouched so the fully-formed markdown always wins.
 */
export function stabilizeStreamingMarkdown(raw: string): string {
  let content = raw

  // Defer a header-only GFM table (last block is table rows with no
  // delimiter row yet). Only touch the trailing run of pipe lines.
  const lines = content.split('\n')
  let end = lines.length
  // Skip a trailing blank line so we look at the actual last content lines.
  while (end > 0 && lines[end - 1].trim() === '') end--
  let start = end
  while (start > 0 && lines[start - 1].trim().startsWith('|')) start--
  if (end - start >= 1) {
    const tableLines = lines.slice(start, end)
    const hasDelimiterRow = tableLines.some(isDelimiterRow)
    if (!hasDelimiterRow) {
      // Escape the leading pipes so react-markdown renders them as text, not a
      // broken table, until the delimiter row streams in. Backslashes first:
      // a pipe that is already escaped (`\|`) must not have its escape
      // re-escaped, which would leave the pipe unescaped (js/incomplete-sanitization).
      for (let i = start; i < end; i++) {
        lines[i] = lines[i].replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
      }
      content = lines.join('\n')
    }
  }

  return closeOpenBold(holdHalfDirective(content))
}

/**
 * Hold back a directive the stream is still writing, so no `:::` or `:klas`
 * flashes as text for a frame. An opened block needs nothing: an unclosed
 * `:::check` runs to the end of the text, so its content is drawn as it
 * arrives. What cannot yet parse is the fence line itself while it is being
 * typed (colons alone, or a `[label` not yet closed), and an inline
 * `:energy-class[` whose label has not closed.
 */
export function holdHalfDirective(content: string): string {
  const cut = content.lastIndexOf('\n') + 1
  const line = content.slice(cut)
  const fences = content.match(/^\s*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return content
  // A fence line in progress: `::`, `:::`, `:::detai`, `:::details[Was es br`.
  // Colons alone are a closer only when a block is open, and a closer is
  // complete as typed.
  if (/^\s*:{2,}$/.test(line)) return openContainers(content.slice(0, cut)) > 0 && /:{3}/.test(line) ? content : content.slice(0, cut)
  if (/^\s*:{3,}[A-Za-z][\w-]*\[[^\]]*$/.test(line)) return content.slice(0, cut)
  // An inline directive whose label is still open.
  const inline = /(^|[^\w:]):[A-Za-z][\w-]*\[[^\]]*$/.exec(line)
  return inline ? content.slice(0, cut + inline.index + inline[1].length) : content
}

/** How many directive blocks are open at the end of `content`. */
function openContainers(content: string): number {
  let open = 0
  for (const line of content.split('\n')) {
    if (/^\s*:{3,}[A-Za-z]/.test(line)) open += 1
    else if (/^\s*:{3,}\s*$/.test(line) && open > 0) open -= 1
  }
  return open
}

/**
 * Close a bold phrase the last line has opened and not yet closed, so it is
 * drawn bold from its first word instead of as a raw `**` until its partner
 * arrives. An answer that opens with its verdict in bold showed nothing for
 * 0.7 s (the paced reveal waited for the closer) or a raw `**` (stream audit,
 * 2026-09). Not inside an open fence or a code span, and not in a table row,
 * which the renderer draws cell by cell.
 */
function closeOpenBold(content: string): string {
  const fences = content.match(/^\s*(```|~~~)/gm)?.length ?? 0
  if (fences % 2 === 1) return content
  const line = content.slice(content.lastIndexOf('\n') + 1)
  if (line.trimStart().startsWith('|')) return content
  if ((line.match(/`/g)?.length ?? 0) % 2 === 1) return content
  if ((line.match(/\*\*/g)?.length ?? 0) % 2 === 0) return content
  const trimmed = content.trimEnd()
  // Nothing inside the phrase yet: `**` alone would render as a literal `****`.
  if (trimmed.endsWith('**')) return content
  return `${trimmed}**`
}

/**
 * What one render of the document knows that the element overrides need.
 *
 * ## Why a context, and not a closure
 *
 * The overrides below are handed to react-markdown as COMPONENTS, and React
 * decides whether to keep or replace a subtree by the component's identity. The
 * overrides used to be built inside the renderer, closing over the heading ids,
 * the open fence and the slot renderer, all three of which change with every
 * streamed token. So every token minted a new `h2`, a new `code`, a new slot
 * component, and React unmounted and remounted the whole answer: a drawn diagram
 * went back to its skeleton and re-queued its parse behind the mermaid lock, and
 * a card that had grown into its place grew again (ADR-0066 draws both while
 * the answer is still arriving, so both were visible every token).
 *
 * The overrides are therefore module-level and never change. What varies per
 * render travels through this context and is read INSIDE them, which re-renders
 * a consumer without replacing it.
 */
interface MarkdownRenderState {
  /** Smaller body text, for chat bubbles. */
  compact: boolean
  /** The id of every heading, keyed by the source line it was written on. */
  headingIds: ReadonlyMap<number, string>
  /** The lines of the text being rendered while it streams, else `null`. See {@link isOpenFence}. */
  streamingLines: readonly string[] | null
  /** The whole text is still arriving (any block, not only the last). */
  streaming: boolean
}

const NO_HEADINGS: ReadonlyMap<number, string> = new Map()

const MarkdownRenderStateContext = createContext<MarkdownRenderState>({
  compact: false,
  headingIds: NO_HEADINGS,
  streamingLines: null,
  streaming: false,
})

const useMarkdownRenderState = (): MarkdownRenderState => useContext(MarkdownRenderStateContext)

/**
 * The id for one heading element. The line the heading was written on is a
 * property of the text, not of the render, so it survives a render React
 * restarts or interleaves with another instance's.
 *
 * The fallback is the id this heading carried before ids were made unique:
 * a setext heading (which the scan deliberately does not read) and a
 * heading a remark plugin invented (which has no source line) still get an
 * anchor, just not a disambiguated one.
 */
function useHeadingId(node: ExtraProps['node'], children: ReactNode): string {
  const { headingIds } = useMarkdownRenderState()
  const line = node?.position?.start.line
  const assigned = line === undefined ? undefined : headingIds.get(line)
  return assigned ?? headingAnchorId(getTextFromChildren(children))
}

// A position a remark plugin marked for the surface to fill (see
// `slot-context`). The renderer is read here, not captured: a surface's slot
// renderer changes whenever its cards do, and capturing it made this a new
// component on every such change.
function MarkdownSlot({ index }: { index?: string }) {
  const renderSlot = useMarkdownSlotRenderer()
  const position = Number(index)
  if (!renderSlot || !Number.isInteger(position)) return null
  return <>{renderSlot(position)}</>
}

function MarkdownCode({
  children,
  className: codeClassName,
  node,
  ...props
}: React.ComponentPropsWithoutRef<'code'> & ExtraProps) {
  const { streamingLines } = useMarkdownRenderState()
  // Block code vs inline. The class alone cannot decide it: a BARE
  // fence (``` with no language — the fence the model actually writes
  // when it forgets the tag) reaches here with no className at all, and
  // keying on the class rendered whole diagrams and listings as inline
  // code, so `isMermaidFence`'s content sniff never even ran. The
  // trailing newline is the discriminator remark itself provides: a
  // fenced block's text is always `value + '\n'`, an inline span can
  // never contain a newline.
  const rawContent = String(children)
  const isBlock = codeClassName?.startsWith('language-') || rawContent.includes('\n')
  const codeContent = rawContent.replace(/\n$/, '')

  if (!isBlock) {
    return (
      <code
        className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-mono text-[0.875em]"
        {...props}
      >
        {children}
      </code>
    )
  }

  // A diagram, not a listing. The fence still being written holds its
  // place (`isStreaming`). A source mermaid will not draw falls back to
  // the `CodeBlock` below.
  if (isMermaidFence(codeClassName, codeContent)) {
    const at = node?.position
    const stillWriting = streamingLines !== null && at !== undefined && isOpenFence(streamingLines, at.start.line, at.end.line)
    return <MermaidDiagram source={codeContent} isStreaming={stillWriting} />
  }

  const lineCount = codeContent.split('\n').length
  return (
    <CodeBlock
      value={codeContent}
      language={getLanguageFromClassName(codeClassName)}
      collapsible={lineCount > 15}
      maxLines={15}
    />
  )
}

type HeadingProps = React.ComponentPropsWithoutRef<'h1'> & ExtraProps

function MarkdownH1({ children, node }: HeadingProps) {
  const id = useHeadingId(node, children)
  return (
    <h1
      id={id}
      className="text-foreground mb-3 mt-8 block scroll-mt-4 text-xl font-semibold tracking-tight"
    >
      {children}
    </h1>
  )
}

function MarkdownH2({ children, node, id: givenId, className: givenClass }: HeadingProps) {
  // The GFM footnote section's own heading arrives with an id and an
  // `sr-only` class; both are kept, so its label stays out of the
  // page and the back-references resolve.
  const derived = useHeadingId(node, children)
  return (
    <h2
      id={givenId ?? derived}
      className={`mb-3 mt-8 block scroll-mt-4 text-lg font-semibold tracking-tight text-foreground${givenClass ? ` ${givenClass}` : ''}`}
    >
      {children}
    </h2>
  )
}

function MarkdownH3({ children, node }: HeadingProps) {
  const id = useHeadingId(node, children)
  return (
    <h3
      id={id}
      className="text-foreground mb-2 mt-6 block scroll-mt-4 text-base font-semibold tracking-tight"
    >
      {children}
    </h3>
  )
}

function MarkdownH4({ children, node }: HeadingProps) {
  const id = useHeadingId(node, children)
  return (
    <h4 id={id} className="text-foreground mb-1 mt-3 block scroll-mt-4 text-sm font-semibold">
      {children}
    </h4>
  )
}

// h5/h6 need a mapping too: Tailwind's preflight strips heading sizes
// and weights, so an unmapped level rendered as plain body text — a
// deeply structured answer (OIB guideline → section → clause) silently
// lost its two lowest levels of hierarchy.
function MarkdownH5({ children, node }: HeadingProps) {
  const id = useHeadingId(node, children)
  return (
    <h5 id={id} className="text-foreground mb-1 mt-3 block scroll-mt-4 text-sm font-semibold">
      {children}
    </h5>
  )
}

function MarkdownH6({ children, node }: HeadingProps) {
  const id = useHeadingId(node, children)
  return (
    <h6 id={id} className="text-subtle mb-1 mt-3 block scroll-mt-4 text-sm font-semibold">
      {children}
    </h6>
  )
}

function MarkdownParagraph({ children }: React.ComponentPropsWithoutRef<'p'>) {
  const { compact } = useMarkdownRenderState()
  return (
    <p className={`text-foreground mb-4 block max-w-[72ch] leading-relaxed ${compact ? 'text-sm' : 'text-base'}`}>
      {children}
    </p>
  )
}

// `id` forwarded for the footnote list items, which the `[^n]` links
// point at; without it every footnote link scrolled nowhere.
function MarkdownListItem({ children, id, node }: React.ComponentPropsWithoutRef<'li'> & ExtraProps) {
  const { compact } = useMarkdownRenderState()
  const { active, muted } = useCaseMarks(node?.properties)
  const t = useTranslations('common')
  const decided = useCasesDecision() !== null && node?.properties?.dataCaseIndex !== undefined
  // A step of a `:::procedure` (`directive-shape.ts`).
  if (node?.properties?.dataPhase) return <StepItem node={node}>{children}</StepItem>
  if (active || muted) {
    return (
      <ListCase id={id} active={active} muted={muted} compact={compact}>
        {children}
        {active && decided && <MarkChip>{t('markdown.caseApplies')}</MarkChip>}
      </ListCase>
    )
  }
  return (
    <li id={id} className={`text-foreground ${compact ? 'text-sm' : 'text-base'}`}>
      {children}
    </li>
  )
}

/**
 * Whether a row or item is the case that holds, and whether it is muted: the
 * renderer's decision in a `by=` cases block ({@link useCasesDecision}), the
 * marks the answer wrote everywhere else.
 */
function useCaseMarks(properties: Record<string, unknown> | undefined): { active: boolean; muted: boolean } {
  const cases = useCasesDecision()
  const index = properties?.dataCaseIndex
  if (cases && index !== undefined) {
    const active = Number(index) === cases.match
    return { active, muted: cases.match >= 0 && !active }
  }
  return { active: Boolean(properties?.dataActive), muted: Boolean(properties?.dataMuted) }
}

// The task-list checkbox, drawn as a status mark rather than a form
// control: a disabled checkbox reads as a broken form, and the list
// is a statement („done", „still owed"), not an input. The same two
// states the Status column marks carry, with the word for readers
// who do not see the icon.
function MarkdownTaskMark({ type, checked }: React.ComponentPropsWithoutRef<'input'> & ExtraProps) {
  const t = useTranslations('common')
  if (type !== 'checkbox') return null
  const Mark = checked ? CircleCheck : Circle
  return (
    <span
      className="mr-2 inline-flex translate-y-[3px] align-top"
      data-testid="task-mark"
      data-done={checked ? 'true' : 'false'}
    >
      <Mark aria-hidden="true" className={checked ? 'text-success size-4' : 'text-muted-foreground size-4'} />
      <span className="sr-only">{checked ? t('markdown.taskDone') : t('markdown.taskOpen')}</span>
    </span>
  )
}

// Links — anchor hrefs scroll in-page; external hrefs open new tabs
function MarkdownLink({ href, children, node: _node, ...rest }: React.ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const renderInPageAnchor = useInPageAnchorRenderer()
  const renderInternalLink = useInternalLinkRenderer()
  // A GFM footnote link (the `[^1]` reference and its back-reference)
  // arrives with a data attribute and an aria-label. It is a plain
  // in-page jump, never a citation, so it keeps both and skips the
  // surface's own anchor renderer.
  const extra = rest as Record<string, unknown>
  const footnoteRef = extra['data-footnote-ref'] as boolean | undefined
  const footnoteBackref = extra['data-footnote-backref'] as boolean | undefined
  const isFootnote = footnoteRef !== undefined || footnoteBackref !== undefined
  if (href?.startsWith('#')) {
    // A surface that knows what this anchor MEANS can render it itself
    // — the chat answer turns its `[3]` into a citation with a preview.
    // Without a provider this falls through to the plain scroll link,
    // which is what every other markdown surface wants.
    if (renderInPageAnchor && !isFootnote) {
      return <>{renderInPageAnchor({ href, children })}</>
    }
    return (
      <a
        href={href}
        aria-label={extra['aria-label'] as string | undefined}
        data-footnote-ref={footnoteRef}
        data-footnote-backref={footnoteBackref}
        className="text-brand underline underline-offset-2 hover:opacity-80"
        onClick={(e: React.MouseEvent) => {
          e.preventDefault()
          scrollToAnchor(href.slice(1))
        }}
      >
        {children}
      </a>
    )
  }
  // In-app links stay in the app. A surface that knows the destination
  // may render something better than a link — the chat answer turns a
  // model deep link into an element chip.
  if (isInternalHref(href)) {
    if (renderInternalLink) {
      return <>{renderInternalLink({ href, children })}</>
    }
    return (
      <a href={href} className="text-brand underline underline-offset-2 hover:opacity-80">
        {children}
      </a>
    )
  }
  return (
    <a
      href={href ?? '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  )
}

// Tables (GFM)
// Zebra rows and tabular figures: the answer writes its checks,
// comparisons and values-by-class as tables, and a column of numbers
// or classes reads down only when the digits line up.
// What only all of a table's rows can say (its tally, a Fundstelle
// shared by every row, each cell's column for the stacked phone
// layout) is settled by `rehypeTableShape` and read off the node.
function MarkdownTable({ children, node }: React.ComponentPropsWithoutRef<'table'> & ExtraProps) {
  const t = useTranslations('common')
  const tally = parseTally(node?.properties?.dataTally)
  const stackValue = node?.properties?.dataStack
  const stack = stackValue === 'true' || stackValue === 'always' ? stackValue : undefined
  const variant = tableVariant(node?.properties?.dataVariant)
  const outcomeLabel = useOutcomeLabel()
  // Collapsed only once the block has arrived: a check that folds away while
  // it streams would make the answer jump up under the reader.
  const { streaming } = useMarkdownRenderState()
  const passed = node?.properties?.dataCollapsed === 'true' && !streaming ? Number(node.properties.dataPassCount) : 0
  const frame = (
    <div className={tableFrameClass(variant)} data-variant={variant === 'plain' ? undefined : variant}>
      {tally.length > 0 && !passed && (
        <p className="flex flex-wrap items-center gap-1.5" data-testid="status-tally">
          <span className="sr-only">{t('markdown.statusTally')}: </span>
          {tally.map(([word, count]) => (
            <Chip key={word} size="sm" variant={outcomeTone(word) ?? 'muted'}>
              <span className="font-semibold tabular-nums">{count}</span> {outcomeLabel(word, 'tally')}
            </Chip>
          ))}
        </p>
      )}
      <HorizontalScroll className="border-base rounded-xl border" aria-label={t('markdown.scrollTable')}>
        <table
          data-stack={stack}
          data-labels={node?.properties?.dataLabels === 'above' ? 'above' : undefined}
          className={tableClass(variant)}
        >
          {children}
        </table>
      </HorizontalScroll>
    </div>
  )
  if (passed > 0) return <PassedCheck passed={passed}>{frame}</PassedCheck>
  return hasCases(node) ? <CasesScope node={node}>{frame}</CasesScope> : frame
}

/** A tally word's tone: the renderer's own outcomes, else the status word's. */
const outcomeTone = (word: string) =>
  word === '@pass' ? 'success' : word === '@fail' ? 'destructive' : word === '@conflict' ? 'warning' : statusTone(word)

function MarkdownCaption({ children, node }: React.ComponentPropsWithoutRef<'caption'> & ExtraProps) {
  const t = useTranslations('common')
  return (
    <caption className="border-base text-muted-foreground border-t px-3 py-2 text-left text-xs">
      {t('markdown.sharedSource', { label: String(node?.properties?.dataLabel ?? '') })}: {children}
    </caption>
  )
}

// A row that holds (`trifft zu`, `aktuell`, a `:applies` marker) is tinted;
// in a `:::cases` the others are muted once one holds (`directive-shape.ts`).
function MarkdownRow({ children, node }: React.ComponentPropsWithoutRef<'tr'> & ExtraProps) {
  const { active, muted } = useCaseMarks(node?.properties)
  const conflict = Boolean(node?.properties?.dataConflict)
  return (
    <tr
      data-active={active ? 'true' : undefined}
      data-conflict={conflict ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      className={tableRowClass({ active, muted, conflict })}
    >
      {children}
    </tr>
  )
}

function MarkdownHeaderCell({ children, align, style, node }: React.ComponentPropsWithoutRef<'th'> & ExtraProps) {
  const t = useTranslations('common')
  const recommended = Boolean(node?.properties?.dataRecommended)
  if (node?.properties?.dataTaskHead) {
    return (
      <th className="w-0 px-2 py-2 print:hidden">
        <span className="sr-only">{t('markdown.actions.column')}</span>
      </th>
    )
  }
  return (
    <th
      data-recommended={recommended ? 'true' : undefined}
      className={headerCellClass({
        align: cellAlignClass(align, style) ?? (node?.properties?.dataNumeric ? 'text-right' : 'text-left'),
        recommended,
      })}
    >
      {children}
      {recommended && <MarkChip>{t('markdown.recommended')}</MarkChip>}
    </th>
  )
}

function MarkdownCell({ children, align, style, node }: React.ComponentPropsWithoutRef<'td'> & ExtraProps) {
  // Marked by `rehypeTableShape`, which knows the cell's column: only a Status
  // column's word is a mark. Read off the cell's text alone, „open" in a
  // Bemerkung column became a chip.
  const properties = node?.properties ?? {}
  const t = useTranslations('common')
  const cases = useCasesDecision()
  const status = properties.dataStatus
  const tone = isStatusTone(status) ? status : null
  const label = properties.dataLabel
  const renderRowAction = useRowActionRenderer()
  const bar = valueBarOf(properties)
  const ask = typeof properties.dataAsk === 'string' ? properties.dataAsk : null
  const outcome = typeof properties.dataOutcome === 'string' ? properties.dataOutcome : null
  const outcomeLabel = useOutcomeLabel()
  if (properties.dataCell === TASK_CELL) {
    return (
      <td className="w-0 whitespace-nowrap px-2 py-1.5 align-top print:hidden" data-cell={TASK_CELL}>
        <TaskCellContent node={node as never} />
      </td>
    )
  }
  const caseIndex = properties.dataCaseIndex
  const decided = cases !== null && caseIndex !== undefined
  const holds = decided && Number(caseIndex) === cases.match
  let content: ReactNode = children
  if (decided && properties.dataCaseStatus) {
    // The renderer's case, not the model's word: the matched row says „trifft
    // zu", a row the model claimed and the profile refutes is overruled.
    const claimed = Boolean(properties.dataCaseClaim)
    content = holds ? (
      <Chip size="sm" variant="success" data-testid="status-mark" data-tone="success" data-case="holds" className={cellChipClass}>
        {t('markdown.caseApplies')}
      </Chip>
    ) : claimed ? (
      <Chip
        size="sm"
        variant="muted"
        data-testid="status-mark"
        data-tone="muted"
        data-case="overruled"
        title={t('markdown.caseOverruled', { word: getTextFromChildren(children) })}
        className={cellChipClass}
      >
        {t('markdown.caseNotApplies')}
      </Chip>
    ) : tone ? (
      <Chip size="sm" variant="muted" data-testid="status-mark" data-tone="muted" className={cellChipClass}>
        {children}
      </Chip>
    ) : (
      children
    )
  } else if (tone) {
    content = (
      <Chip
        size="sm"
        variant={tone}
        data-testid="status-mark"
        data-tone={tone}
        data-outcome={outcome ?? undefined}
        title={outcome ? getTextFromChildren(children) : undefined}
        className={cellChipClass}
      >
        {outcome ? outcomeLabel(outcome, 'cell') : children}
      </Chip>
    )
  } else if (properties.dataRole) {
    content = <RoleChip>{children}</RoleChip>
  }
  return (
    <td
      data-label={typeof label === 'string' ? label : undefined}
      data-numeric={properties.dataNumeric ? 'true' : undefined}
      className={dataCellClass({
        align: cellAlignClass(align, style) ?? (properties.dataNumeric ? 'text-right' : undefined),
        recommended: Boolean(properties.dataRecommended),
      })}
    >
      {content}
      {holds && properties.dataCaseLead && <MarkChip>{t('markdown.caseApplies')}</MarkChip>}
      {bar && <ValueBar {...bar} valueText={getTextFromChildren(children)} />}
      {ask !== null && renderRowAction && (
        <span className="ml-1.5 inline-flex align-middle print:hidden">
          {renderRowAction({ subject: ask, detail: String(properties.dataAskDetail ?? '') })}
        </span>
      )}
    </td>
  )
}

/** The bar a check row's value cell carries (`directive-shape.ts`), or null. */
function valueBarOf(properties: Record<string, unknown>) {
  const value = Number(properties.dataBarValue)
  const limit = Number(properties.dataBarLimit)
  if (properties.dataBarValue === undefined || !Number.isFinite(value) || !Number.isFinite(limit)) return null
  const bound: 'min' | 'max' = properties.dataBarBound === 'min' ? 'min' : 'max'
  const limitText = typeof properties.dataBarLimitText === 'string' ? properties.dataBarLimitText : String(limit)
  return { value, limit, bound, pass: properties.dataBarPass === 'true', limitText }
}

function MarkdownUnorderedList({ children, className: listClassName, node }: React.ComponentPropsWithoutRef<'ul'> & ExtraProps) {
  if (node?.properties?.dataVariant === 'steps') return <StepList ordered={false}>{children}</StepList>
  const list = (
    <ul
      className={
        listClassName?.includes('contains-task-list')
          ? 'text-foreground mb-3 list-none space-y-1 pl-1'
          : 'text-foreground mb-3 list-outside list-disc space-y-1 pl-5'
      }
    >
      {children}
    </ul>
  )
  return hasCases(node) ? <CasesScope node={node}>{list}</CasesScope> : list
}

function MarkdownOrderedList({ children, node }: React.ComponentPropsWithoutRef<'ol'> & ExtraProps) {
  if (node?.properties?.dataVariant === 'steps') return <StepList ordered>{children}</StepList>
  const list = <ol className="text-foreground mb-3 list-outside list-decimal space-y-1 pl-5">{children}</ol>
  return hasCases(node) ? <CasesScope node={node}>{list}</CasesScope> : list
}

/**
 * Every element override, with one identity for the life of the module. See
 * {@link MarkdownRenderStateContext} for why nothing here may be rebuilt per
 * render. Cast because `Components` is keyed by intrinsic elements and the slot
 * tag is deliberately not one of them — that is what guarantees the markdown
 * itself can never produce it.
 */
const MARKDOWN_COMPONENTS = {
  [MARKDOWN_SLOT_TAG]: MarkdownSlot,
  code: MarkdownCode,
  // Skip default pre rendering since CodeBlock handles it
  pre: ({ children }: React.ComponentPropsWithoutRef<'pre'>) => <>{children}</>,
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  h4: MarkdownH4,
  h5: MarkdownH5,
  h6: MarkdownH6,
  p: MarkdownParagraph,
  // Lists. GFM task lists arrive with `contains-task-list` /
  // `task-list-item` classes; forcing `list-disc` on them drew a bullet
  // NEXT TO each checkbox, so a checklist read as two markers per row.
  ul: MarkdownUnorderedList,
  ol: MarkdownOrderedList,
  li: MarkdownListItem,
  input: MarkdownTaskMark,
  a: MarkdownLink,
  strong: ({ children }: React.ComponentPropsWithoutRef<'strong'>) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }: React.ComponentPropsWithoutRef<'em'>) => (
    <em className="text-foreground italic">{children}</em>
  ),
  blockquote: AnswerBlockquote,
  hr: () => <hr className="border-base my-4" />,
  table: MarkdownTable,
  caption: MarkdownCaption,
  thead: ({ children }: React.ComponentPropsWithoutRef<'thead'>) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  tbody: ({ children }: React.ComponentPropsWithoutRef<'tbody'>) => <tbody>{children}</tbody>,
  tr: MarkdownRow,
  th: MarkdownHeaderCell,
  td: MarkdownCell,
  [ANSWER_BLOCK_TAG]: AnswerBlock,
  [ANSWER_BLOCK_LABEL_TAG]: AnswerBlockLabel,
  [BLOCK_BODY_TAG]: AnswerBlockBody,
  [ANSWER_MARKER_TAG]: AnswerMarker,
  [ANSWER_ENERGY_TAG]: AnswerEnergy,
  [ANSWER_PROJECT_TAG]: AnswerProject,
  [NOT_FOUND_TAG]: NotFound,
  [PANE_TAG]: Pane,
  [SUBSUMPTION_TAG]: Subsumption,
  [SUBSUMPTION_PART_TAG]: StepPart,
  [STEP_HEAD_TAG]: StepPart,
  [STEP_DUE_TAG]: StepPart,
  [STEP_DETAIL_TAG]: StepPart,
  [FIGURES_TAG]: Figures,
  [FIGURE_TAG]: Figure,
  [FIGURE_VALUE_TAG]: StepPart,
  [FIGURE_LABEL_TAG]: StepPart,
  [FIGURE_LIMIT_TAG]: StepPart,
  [COMPARE_STACK_TAG]: CompareStack,
  [COMPARE_VARIANT_TAG]: CompareVariant,
  [COMPARE_TITLE_TAG]: StepPart,
  [COMPARE_ROW_TAG]: CompareRow,
  [COMPARE_LABEL_TAG]: CompareLabel,
  [COMPARE_VALUE_TAG]: CompareValue,
  // Images: bounded, softened, and lazy. Without the mapping an image
  // rendered at natural size with square corners and loaded eagerly —
  // and a broken source showed the browser's raw glyph full-bleed.
  img: ({ src, alt }: React.ComponentPropsWithoutRef<'img'> & ExtraProps) => (
    // Markdown images come from arbitrary hosts the Next image loader is
    // not configured for; `next/image` would 400 on every one of them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      className="border-base my-3 h-auto max-w-full rounded-xl border"
    />
  ),
} as Components

/** The rehype list of every block after the first: the document's own, then the separator the whole document puts before a block. */
const REHYPE_PLUGINS_AFTER_FIRST: PluggableList = [...REHYPE_PLUGINS, rehypeBlockSeparator]

type FootnoteOptions = NonNullable<Options['remarkRehypeOptions']>

interface MarkdownBlockViewProps {
  source: string
  /**
   * This block's heading ids as JSON `[line within the block, id]` pairs, or
   * `''`. A string, so a block whose headings did not change compares equal.
   */
  headingIds: string
  compact: boolean
  /** The text is streaming and this is its last block: the one fence that may still be open is in it. */
  open: boolean
  /** The text is streaming at all. */
  streaming: boolean
  remarkPlugins: PluggableList
  rehypePlugins: PluggableList
  footnoteOptions: FootnoteOptions
}

/**
 * One top-level block of the document, parsed on its own.
 *
 * Memoised on its props, each of them a string, a boolean or a list the
 * renderer keeps the identity of, so a block whose source did not change is
 * neither parsed nor reconciled again when the text after it grows. Where the
 * text is cut, and why that is safe: `markdown-blocks.ts`.
 */
const MarkdownBlockView = memo(function MarkdownBlockView({
  source,
  headingIds,
  compact,
  open,
  streaming,
  remarkPlugins,
  rehypePlugins,
  footnoteOptions,
}: MarkdownBlockViewProps) {
  const ids = useMemo(
    (): ReadonlyMap<number, string> =>
      headingIds ? new Map(JSON.parse(headingIds) as [number, string][]) : NO_HEADINGS,
    [headingIds]
  )
  // The lines a code block's position points into, while there can be a
  // fence still being written; trailing blank lines do not end a block.
  const streamingLines = useMemo(() => (open ? source.trimEnd().split('\n') : null), [open, source])
  const renderState = useMemo(
    (): MarkdownRenderState => ({ compact, headingIds: ids, streamingLines, streaming }),
    [compact, ids, streamingLines, streaming]
  )
  return (
    <MarkdownRenderStateContext.Provider value={renderState}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        // The footnote chrome the mdast→hast step writes on its own: named in
        // the reader's language instead of the converter's English defaults.
        remarkRehypeOptions={footnoteOptions}
        components={MARKDOWN_COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </MarkdownRenderStateContext.Provider>
  )
})

/**
 * The id of every heading in the document, per block, keyed by the line
 * within the block it was written on (as {@link MarkdownBlockViewProps.headingIds}).
 *
 * Ids are unique per document — two „Bewertung" sections are `bewertung`
 * and `bewertung-2` — and that uniqueness cannot be established from inside
 * a per-heading callback, which knows nothing about the headings before it
 * and runs whenever React decides to run it, nor from inside one block. So it
 * is settled here, by a pure pass over the whole string, and the overrides
 * only look their answer up. See {@link markdownHeadings} for why every
 * counting variant of this fails.
 */
function headingIdsByBlock(content: string, blocks: readonly MarkdownBlock[]): string[] {
  const perBlock: [number, string][][] = blocks.map(() => [])
  let at = 0
  for (const heading of markdownHeadings(content)) {
    // `heading.line` is 1-based; a block's `line` is the 0-based index of its first line.
    while (at + 1 < blocks.length && blocks[at + 1].line < heading.line) at += 1
    perBlock[at].push([heading.line - blocks[at].line, heading.id])
  }
  return perBlock.map((entries) => (entries.length > 0 ? JSON.stringify(entries) : ''))
}

/**
 * MarkdownRenderer - Renders markdown content with shadcn-idiomatic styling
 *
 * The text is rendered block by block (`markdown-blocks.ts`), so a streamed
 * answer re-parses only the block that grew, not everything above it.
 *
 * @param content - Markdown string to render
 * @param isStreaming - Whether content is still streaming: stabilise half-arrived Markdown and hold the open fence's place
 * @param className - Additional CSS classes
 * @param compact - Use smaller text sizes for chat bubbles
 * @param remarkPlugins - Extra remark plugins, run after GFM and math
 */
export const MarkdownRenderer: FC<MarkdownRendererProps> = memo(
  ({ content, className = '', compact = false, isStreaming = false, remarkPlugins }) => {
    const t = useTranslations('common')
    const footnoteOptions = useMemo(
      (): FootnoteOptions => ({
        footnoteLabel: t('markdown.footnotes'),
        footnoteLabelProperties: { className: ['sr-only'] },
        footnoteBackLabel: (referenceIndex: number) =>
          t('markdown.backToReference', { n: referenceIndex + 1 }),
      }),
      [t]
    )
    // Every block but the last runs `remarkBlockContinues` first, so a plugin
    // that acts on the document's end knows the tree it sees is not the end.
    const plugins = useMemo(() => {
      // The dialect before the surface's own plugins, so a `[N]` inside a
      // block, or in text a directive put back, is still a citation.
      const last: PluggableList = [remarkGfm, remarkMath, remarkDirective, remarkAnswerDirectives, ...(remarkPlugins ?? [])]
      return { last, notLast: [remarkBlockContinues, ...last] }
    }, [remarkPlugins])
    // While streaming, run partial content through the stabilizer so a
    // half-formed table doesn't thrash the layout token-by-token. Finalized
    // content is rendered verbatim.
    const renderedContent = useMemo(
      () => normalizeDirectiveFences(isStreaming ? stabilizeStreamingMarkdown(content) : content),
      [isStreaming, content]
    )
    // A text that cannot be split safely is one block: the whole document,
    // rendered at once.
    const blocks = useMemo(
      () => splitMarkdownBlocks(renderedContent) ?? [{ source: renderedContent, line: 0 }],
      [renderedContent]
    )
    const headingIds = useMemo(() => headingIdsByBlock(renderedContent, blocks), [renderedContent, blocks])

    return (
      <div
        className={`markdown-content break-words [overflow-wrap:anywhere] [&>*:last-child]:mb-0 ${className}`}
      >
        {blocks.map((block, index) => {
          const last = index === blocks.length - 1
          return (
            <MarkdownBlockView
              // By position: the block the reveal is writing keeps its place,
              // and everything drawn in it, while it grows.
              key={index}
              source={block.source}
              headingIds={headingIds[index] ?? ''}
              compact={compact}
              open={isStreaming && last}
              streaming={isStreaming}
              remarkPlugins={last ? plugins.last : plugins.notLast}
              rehypePlugins={index === 0 ? REHYPE_PLUGINS : REHYPE_PLUGINS_AFTER_FIRST}
              footnoteOptions={footnoteOptions}
            />
          )
        })}
      </div>
    )
  }
)

MarkdownRenderer.displayName = 'MarkdownRenderer'
