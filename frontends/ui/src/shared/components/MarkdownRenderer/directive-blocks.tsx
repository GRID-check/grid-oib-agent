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
  MarkChip,
  StepLine,
  StepStation,
  disclosureRowClass,
  useOutcomeLabel,
  type FigureTone,
  type StepPhase,
} from './answer-atoms'
import { useExcerptSourceRenderer } from './answer-block-context'
import { isStatusTone } from './status-marks'
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
          <CollapsibleContent>
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
    <div data-block={name} className={name === 'vergleich' ? '@container/compare' : undefined}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const PHASES = new Set<StepPhase>(['none', 'done', 'current', 'upcoming'])

/** One step of a `:::verfahren`: its line, and what opens beneath it. */
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
          <CollapsibleContent>
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
  const marker = prop(node, 'dataMarker')
  if (marker === 'aktuell') return <MarkChip>{t('markdown.stepCurrent')}</MarkChip>
  if (marker === 'trifft') return <MarkChip>{t('markdown.caseApplies')}</MarkChip>
  if (marker === 'empfohlen') return <MarkChip>{t('markdown.recommended')}</MarkChip>
  return null
}

export function AnswerEnergy({ node, children }: NodeProps) {
  const klasse = prop(node, 'dataClass')
  return klasse ? <EnergyClassChip klasse={klasse} /> : <>{children}</>
}

/** A blockquote; one ending in a citation is a Fundstelle excerpt with its source in the margin. */
export function AnswerBlockquote({ node, children }: React.ComponentPropsWithoutRef<'blockquote'> & ExtraProps) {
  const renderSource = useExcerptSourceRenderer()
  const number = prop(node as Element | undefined, 'dataExcerpt')
  if (!number) {
    return (
      <blockquote className="border-base text-subtle my-3 border-l-2 pl-4 italic leading-relaxed">{children}</blockquote>
    )
  }
  const href = prop(node as Element | undefined, 'dataExcerptHref') ?? null
  return (
    <ExcerptFigure number={number} source={renderSource?.({ number: Number(number), href })}>
      {children}
    </ExcerptFigure>
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
        <Chip size="sm" variant={tone} data-testid="status-mark" data-tone={tone}>
          {children}
        </Chip>
      ) : (
        children
      )}
    </CompareVariantValue>
  )
}
