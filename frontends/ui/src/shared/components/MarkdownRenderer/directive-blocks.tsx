'use client'

/**
 * The answer's designed blocks: what each element the dialect produces is
 * drawn as. Composed from `answer-atoms.tsx`; what each element IS was settled
 * by `directive-shape.ts` and is only read here.
 *
 * Module-level components with one identity, like every other override of the
 * renderer (`stable-overrides.spec.tsx`): per-render state (an open step, an
 * open `details`) lives inside them.
 */

import { Children, createContext, useContext, useState, type FC, type ReactNode } from 'react'
import type { Element } from 'hast'
import type { ExtraProps } from 'react-markdown'
import { Chip } from '@/components/ui/chip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import {
  CompareStackFrame,
  CompareVariantCard,
  CompareVariantLabel,
  CompareVariantRow,
  CompareVariantTitle,
  CompareVariantValue,
  DetailsFrame,
  DetailsSummary,
  DisclosurePanel,
  EnergyClassChip,
  ExcerptFigure,
  FigureGrid,
  FigureTile,
  InlineDetailsLabel,
  PRINT_OPEN_CONTENT,
  cellChipClass,
  MarkChip,
  NotFoundFrame,
  NotFoundPane,
  PrefillButton,
  QuoteStampLine,
  SearchedList,
  StepLine,
  SubsumptionFrame,
  SubsumptionStep,
  StepStation,
  disclosureRowClass,
  useOutcomeLabel,
  type FigureTone,
  type StepPhase,
} from './answer-atoms'
import { useAnswerData, useExcerptSourceRenderer } from './answer-block-context'
import { useCasesDecision } from './project-binding'
import { isStatusTone } from './status-marks'
import { stampForQuote } from '@/lib/conversations/message-quote-stamps'
import { textOf } from './table-shape'

type NodeProps = { node?: Element; children?: ReactNode }

const prop = (node: Element | undefined, name: string): string | undefined => {
  const value = node?.properties?.[name]
  return value === undefined || value === null ? undefined : String(value)
}

/** The element children of `node`, by tag, aligned with the React children they became. */
function slots(node: Element | undefined, children: ReactNode): Map<string, ReactNode> {
  const nodes = (node?.children ?? []).filter((child) => child.type === 'element') as Element[]
  const rendered = Children.toArray(children)
  const out = new Map<string, ReactNode>()
  nodes.forEach((child, index) => out.set(child.tagName, rendered[index]))
  return out
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Whether the `details` being drawn is printed open inside a step, or opens on its own. */
const DetailsModeContext = createContext<'collapsible' | 'inline'>('collapsible')

function DetailsBlock({ node, children }: NodeProps) {
  const [open, setOpen] = useState(false)
  const inline = prop(node, 'dataInline') === 'true'
  const parts = slots(node, children)
  const label = parts.get('answer-block-label')
  const body = parts.get('answer-block-body')
  if (inline) {
    return (
      <DetailsModeContext.Provider value="inline">
        <div data-block="details">
          {label}
          {body}
        </div>
      </DetailsModeContext.Provider>
    )
  }
  return (
    <DetailsModeContext.Provider value="collapsible">
      <DetailsFrame>
        <Collapsible open={open} onOpenChange={setOpen} data-block="details">
          <CollapsibleTrigger className={disclosureRowClass({ current: false, open })}>
            <DetailsSummary open={open}>{label ?? <DefaultSummary />}</DetailsSummary>
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className={PRINT_OPEN_CONTENT}>
            <DisclosurePanel>{body}</DisclosurePanel>
          </CollapsibleContent>
        </Collapsible>
      </DetailsFrame>
    </DetailsModeContext.Provider>
  )
}

const DefaultSummary: FC = () => {
  const t = useTranslations('common')
  return <>{t('markdown.details')}</>
}

/** A `details` label: the summary of its trigger, or a caption over its content inside a step. */
export function AnswerBlockLabel({ children }: NodeProps) {
  const mode = useContext(DetailsModeContext)
  if (mode === 'inline') return <InlineDetailsLabel>{children}</InlineDetailsLabel>
  return <>{children}</>
}

export function AnswerBlockBody({ children }: NodeProps) {
  return <>{children}</>
}

/** Every block of the dialect: `details` opens and closes; the rest are drawn by what they hold. */
export function AnswerBlock({ node, children }: NodeProps) {
  const name = prop(node, 'dataBlock') ?? ''
  if (name === 'details') return <DetailsBlock node={node}>{children}</DetailsBlock>
  return (
    <div data-block={name} className={name === 'compare' ? '@container/compare' : undefined}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const PHASES = new Set<StepPhase>(['none', 'done', 'current', 'upcoming'])

/** One step of a `:::procedure`: its line, and what opens beneath it. */
export function StepItem({ node, children }: NodeProps) {
  const t = useTranslations('common')
  const [open, setOpen] = useState(false)
  const phaseValue = prop(node, 'dataPhase') as StepPhase | undefined
  const phase: StepPhase = phaseValue && PHASES.has(phaseValue) ? phaseValue : 'none'
  const number = prop(node, 'dataStep') ?? ''
  const parts = slots(node, children)
  const head = parts.get('answer-step-head')
  const due = parts.get('answer-step-due')
  const detail = parts.get('answer-step-detail')
  const headNode = node?.children.find((child) => child.type === 'element' && child.tagName === 'answer-step-head')
  const label = headNode ? textOf(headNode).trim() : ''
  const current = phase === 'current'
  const line = <StepLine phase={phase} title={head} due={due} open={open} expandable={Boolean(detail)} />
  return (
    <StepStation phase={phase} number={number} last={prop(node, 'dataLast') === 'true'}>
      {detail ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger
            aria-current={current ? 'step' : undefined}
            aria-label={t('markdown.stepAria', { step: number, label })}
            className={disclosureRowClass({ current, open })}
          >
            {line}
          </CollapsibleTrigger>
          <CollapsibleContent forceMount className={PRINT_OPEN_CONTENT}>
            <DisclosurePanel current={current}>{detail}</DisclosurePanel>
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <div aria-current={current ? 'step' : undefined} className={disclosureRowClass({ current, open: false })}>
          {line}
        </div>
      )}
    </StepStation>
  )
}

/** The inline parts of a step, drawn by the step itself. */
export function StepPart({ children }: NodeProps) {
  return <>{children}</>
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

const TONES = new Set<FigureTone>(['success', 'destructive', 'warning', 'info', 'muted', 'none'])

export function Figures({ node, children }: NodeProps) {
  return <FigureGrid count={Number(prop(node, 'dataCount') ?? 0)}>{children}</FigureGrid>
}

export function Figure({ node, children }: NodeProps) {
  const toneValue = prop(node, 'dataTone') as FigureTone | undefined
  const tone: FigureTone = toneValue && TONES.has(toneValue) ? toneValue : 'none'
  const parts = slots(node, children)
  const outcomeLabel = useOutcomeLabel()
  const verdict = prop(node, 'dataVerdict')
  return (
    <FigureTile
      tone={tone}
      verdict={verdict ? outcomeLabel(verdict, 'cell') : undefined}
      value={parts.get('answer-figure-value')}
      label={parts.get('answer-figure-label')}
      limit={parts.get('answer-figure-limit')}
    />
  )
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** A marker no list item, row or header took: its word, so nothing is lost. */
export function AnswerMarker({ node }: NodeProps) {
  const t = useTranslations('common')
  const cases = useCasesDecision()
  const marker = prop(node, 'dataMarker')
  // In a `by=` cases block the renderer marks the case; the model's own mark is overruled.
  if (marker === 'applies' && cases) return null
  if (marker === 'current') return <MarkChip>{t('markdown.stepCurrent')}</MarkChip>
  if (marker === 'applies') return <MarkChip>{t('markdown.caseApplies')}</MarkChip>
  if (marker === 'recommended') return <MarkChip>{t('markdown.recommended')}</MarkChip>
  return null
}

export function AnswerEnergy({ node, children }: NodeProps) {
  const rating = prop(node, 'dataClass')
  return rating ? <EnergyClassChip rating={rating} /> : <>{children}</>
}

/** A blockquote; one ending in a citation is a Fundstelle excerpt with its source in the margin. */
export function AnswerBlockquote({ node, children }: React.ComponentPropsWithoutRef<'blockquote'> & ExtraProps) {
  const renderSource = useExcerptSourceRenderer()
  const { quoteStamps } = useAnswerData()
  const element = node as Element | undefined
  const number = prop(element, 'dataExcerpt')
  if (!number) {
    return (
      <blockquote className="border-base text-subtle my-3 border-l-2 pl-4 italic leading-relaxed">{children}</blockquote>
    )
  }
  const href = prop(element, 'dataExcerptHref') ?? null
  // The server's check of this line, matched by its wording; `unchecked` draws nothing.
  const stamp = element ? stampForQuote(quoteStamps, textOf(element), Number(number)) : null
  const checked = stamp && stamp.status !== 'unchecked' ? stamp : null
  const locus = checked?.status === 'verbatim' ? stampLocus(checked) : undefined
  return (
    <ExcerptFigure
      number={number}
      paraphrase={checked?.status === 'not_found'}
      stamp={
        checked ? (
          <QuoteStampLine verbatim={checked.status === 'verbatim'} number={checked.number ?? Number(number)} locus={locus} />
        ) : undefined
      }
      source={renderSource?.({ number: Number(number), href, stamp: checked })}
    >
      {children}
    </ExcerptFigure>
  )
}

/** Where a verified quote stands: „S. 12 · Pkt. 3.5.2". */
function stampLocus(stamp: { page?: number; punkt?: string }): string | undefined {
  const parts = [stamp.punkt ? `Pkt. ${stamp.punkt}` : null, stamp.page ? `S. ${stamp.page}` : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The trailing cell of an actions row: „Als Aufgabe", which only fills the composer. */
export function TaskCellContent({ node }: NodeProps) {
  const t = useTranslations('common')
  const { prefill } = useAnswerData()
  const what = prop(node, 'dataTaskWhat') ?? ''
  if (!prefill || what.trim().length < 3) return null
  const who = prop(node, 'dataTaskWho') ?? ''
  const by = prop(node, 'dataTaskBy') ?? ''
  const source = prop(node, 'dataTaskSource') ?? ''
  const request = [
    t('markdown.actions.request', { what: what.replace(/[.\s]+$/, '') }),
    who ? t('markdown.actions.requestWho', { who }) : '',
    by ? t('markdown.actions.requestBy', { by }) : '',
    source ? t('markdown.actions.requestSource', { source }) : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <PrefillButton
      label={t('markdown.actions.asTask')}
      title={request}
      ariaLabel={t('markdown.actions.asTaskAria', { what })}
      onClick={() => prefill(request)}
    />
  )
}

// ---------------------------------------------------------------------------
// A documented negative
// ---------------------------------------------------------------------------

/** How many searched documents „Gesucht in" names before „+N weitere". */
const SEARCHED_SHOWN = 6

export function NotFound({ children }: NodeProps) {
  const { notRegulated } = useAnswerData()
  // An answer whose masthead does not say „Nicht geregelt" has no documented
  // negative to draw: its closest rule and who decides read as plain content.
  if (notRegulated === false) return <div data-block-plain="not-found">{children}</div>
  return <NotFoundFrame>{children}</NotFoundFrame>
}

export function Pane({ node, children }: NodeProps) {
  const t = useTranslations('common')
  const { notRegulated, searched } = useAnswerData()
  const pane = prop(node, 'dataPane') ?? ''
  if (notRegulated === false) return pane === 'searched' ? null : <>{children}</>
  if (pane === 'searched') {
    const items = searched ?? []
    return (
      <NotFoundPane pane="searched" label={t('markdown.notFound.searched')}>
        <SearchedList items={items.slice(0, SEARCHED_SHOWN)} more={Math.max(0, items.length - SEARCHED_SHOWN)} />
      </NotFoundPane>
    )
  }
  const label = pane === 'rule' ? t('markdown.notFound.closest') : t('markdown.notFound.decides')
  return (
    <NotFoundPane pane={pane} label={label}>
      {children}
    </NotFoundPane>
  )
}

// ---------------------------------------------------------------------------
// Subsumption
// ---------------------------------------------------------------------------

export function Subsumption({ node, children }: NodeProps) {
  const t = useTranslations('common')
  const parts = (node?.children ?? []).filter((child): child is Element => child.type === 'element')
  const rendered = Children.toArray(children)
  const present = parts
    .map((part, index) => ({ part, content: rendered[index] }))
    .filter(({ part }) => part.children.length > 0)
  return (
    <SubsumptionFrame>
      {present.map(({ part, content }, index) => {
        const name = prop(part, 'dataPart') ?? ''
        const tone = prop(part, 'dataTone')
        return (
          <SubsumptionStep
            key={name}
            part={name}
            label={t(`markdown.subsumption.${name === 'norm' ? 'norm' : name === 'facts' ? 'facts' : 'result'}`)}
            tone={isStatusTone(tone) ? tone : undefined}
            statusWord={prop(part, 'dataStatusWord')}
            last={index === present.length - 1}
          >
            {content}
          </SubsumptionStep>
        )
      })}
    </SubsumptionFrame>
  )
}

// ---------------------------------------------------------------------------
// Comparison, per variant
// ---------------------------------------------------------------------------

export function CompareStack({ children }: NodeProps) {
  return <CompareStackFrame>{children}</CompareStackFrame>
}

export function CompareVariant({ node, children }: NodeProps) {
  const recommended = prop(node, 'dataRecommended') === 'true'
  const parts = Children.toArray(children)
  return (
    <CompareVariantCard recommended={recommended}>
      <CompareVariantTitle recommended={recommended}>{parts[0]}</CompareVariantTitle>
      {parts.slice(1)}
    </CompareVariantCard>
  )
}

export function CompareRow({ children }: NodeProps) {
  return <CompareVariantRow>{children}</CompareVariantRow>
}

export function CompareLabel({ children }: NodeProps) {
  return <CompareVariantLabel>{children}</CompareVariantLabel>
}

export function CompareValue({ node, children }: NodeProps) {
  const tone = prop(node, 'dataStatus')
  return (
    <CompareVariantValue>
      {isStatusTone(tone) ? (
        <Chip size="sm" variant={tone} data-testid="status-mark" data-tone={tone} className={cellChipClass}>
          {children}
        </Chip>
      ) : (
        children
      )}
    </CompareVariantValue>
  )
}
