/**
 * Reasoning-chain nodes (click-dummy "Herleitung" overhaul).
 *
 * Each node binds to REAL streamed data or is hidden by the orchestrator — the
 * mock's fabricated OIB content is never reproduced. Node 1 (framing) restates
 * the user's own question + real context chips; Node 2 (fan-out) reuses the
 * existing per-document source cards; Node 3 (assessment) degrades to the real
 * answer-confidence + flat citation chips (no fabricated per-insight mapping);
 * Node 4 (next steps) renders only a live HITL multiple-choice prompt.
 */

import type { FC } from 'react'
import { Sparkles, ClipboardCheck, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Translator } from '@/i18n'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { KIND_TO_SIGNAL, kindForLane, authorityTag, asSourceKind } from '../../lib/source-kinds'
import type { CitationSource } from '../../types'
import type { TraceSourceCard } from '../../lib/trace-lanes'
import { ChainNode } from './ChainNode'
import { BranchOptions } from './BranchOptions'
import { SourceCard } from './SourceCard'
import { AuthorityTag } from '../AuthorityTag'
import { ConfidenceChip } from '../ConfidenceChip'

const ENTRANCE =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none'

/* ── Node 1: Framing ─────────────────────────────────────────────────────── */

export interface FramingNodeProps {
  t: Translator
  userQuestion: string
  order: number
  /** Which path the turn took after intent classification (WP-A transparency). */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Verbatim "why" for the routing decision, rendered as-is (classifier text). */
  routingReason?: string
  /** Set when this turn escalated shallow→deep — one-line narration. */
  escalationReason?: string
}

export const FramingNode: FC<FramingNodeProps> = ({
  t,
  userQuestion,
  order,
  routingDecision,
  routingReason,
  escalationReason,
}) => {
  // "Warum dieser Weg?" — the routing narration only appears when BOTH the
  // decision and its human-readable reason are present (contract: framing-node
  // area, e.g. `Einordnung: Tiefenrecherche — <reason>`).
  const showRouting = Boolean(routingDecision && routingReason?.trim())
  const showEscalation = Boolean(escalationReason?.trim())

  return (
    <ChainNode
      tabLabel={t('thinking.node.framingTab')}
      tabIcon={Sparkles}
      order={order}
      maxWidthClassName="max-w-[520px]"
    >
      <div className="text-[12.5px] font-semibold text-foreground">
        {t('thinking.node.framingTitle')}
      </div>
      {userQuestion.trim() && (
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          {t('thinking.node.framingQuestion', { question: userQuestion.trim() })}
        </p>
      )}
      {(showRouting || showEscalation) && (
        <div className="mt-2.5 flex flex-col gap-1 border-t border-base pt-2">
          {showRouting && routingDecision && (
            <div>
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                {t('thinking.routing.whyLabel')}
              </span>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">
                {t('thinking.routing.line', {
                  decision: t(`thinking.routing.decision.${routingDecision}`),
                  reason: routingReason!.trim(),
                })}
              </p>
            </div>
          )}
          {showEscalation && (
            <p className="text-[12.5px] leading-relaxed text-warning">
              {t('thinking.escalationNarration', { reason: escalationReason!.trim() })}
            </p>
          )}
        </div>
      )}
    </ChainNode>
  )
}

/* ── Node 2: Quellen fan-out ─────────────────────────────────────────────── */

export interface SourceFanOutNodeProps {
  t: Translator
  cards: TraceSourceCard[]
  order: number
}

export const SourceFanOutNode: FC<SourceFanOutNodeProps> = ({ t, cards, order }) => (
  <div
    className={cn('w-full', ENTRANCE)}
    style={{ animationDelay: `${order * 80}ms`, animationFillMode: 'both' }}
  >
    <div
      className="grid gap-2.5"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}
      role="list"
      aria-label={t('thinking.node.sourcesTitle')}
    >
      {cards.map((card) => (
        <SourceCard
          key={card.id}
          card={card}
          hitLabel={t('thinking.hitCount', { count: card.hitCount })}
          gapLabel={t('thinking.gapHit')}
        />
      ))}
    </div>
  </div>
)

/* ── Node 3: Assessment (confidence + citations) ─────────────────────────── */

interface CitationChip {
  key: string
  label: string
  signal: SourceSignal
  authority: string | null
  url?: string
}

/** Collapse the flat citation list into unique lane chips (mock has none real). */
const citationChips = (citations: CitationSource[]): CitationChip[] => {
  const byLane = new Map<string, CitationChip>()
  for (const c of citations) {
    const kind = asSourceKind(c.kind) ?? kindForLane(c.lane)
    const signal = KIND_TO_SIGNAL[kind]
    const label = c.laneLabel?.trim() || c.lane?.trim() || c.title?.trim() || kind
    const key = (c.lane || c.laneLabel || label).toLowerCase()
    if (!byLane.has(key)) {
      byLane.set(key, { key, label, signal, authority: authorityTag(c.lane), url: c.url })
    }
  }
  return Array.from(byLane.values())
}

export interface FindingsNodeProps {
  t: Translator
  answerConfidence?: 'low' | 'medium' | 'high'
  citations?: CitationSource[]
  order: number
}

export const FindingsNode: FC<FindingsNodeProps> = ({ t, answerConfidence, citations, order }) => {
  const chips = citations ? citationChips(citations) : []
  const MAX = 6
  const shown = chips.slice(0, MAX)
  const overflow = chips.length - shown.length

  return (
    <ChainNode
      tabLabel={t('thinking.node.findingsTab')}
      tabIcon={ClipboardCheck}
      order={order}
      maxWidthClassName="max-w-[600px]"
    >
      {/* Confidence is a MODEL self-assessment, not provenance — it must never
          borrow the --source-* palette (green/gold/blue mean "where this came
          from"). Render it in the neutral ConfidenceChip vocabulary shared with
          the answer footer, so confidence reads one way everywhere and the
          provenance colors stay reserved for real citations (design language
          §Principles/2: color never travels outside its meaning). */}
      {answerConfidence && <ConfidenceChip confidence={answerConfidence} />}
      {shown.length > 0 && (
        <div className={answerConfidence ? 'mt-3' : ''}>
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {t('thinking.node.findingsTitle')}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {shown.map((chip) =>
              chip.url ? (
                <a
                  key={chip.key}
                  href={chip.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-full border px-2.5 text-xs font-medium transition-[filter] hover:brightness-95 dark:hover:brightness-125"
                  style={sourceSignalStyle(chip.signal)}
                >
                  {chip.authority && <AuthorityTag>{chip.authority}</AuthorityTag>}
                  <span className="truncate">{chip.label}</span>
                </a>
              ) : (
                <span
                  key={chip.key}
                  className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-full border px-2.5 text-xs font-medium"
                  style={sourceSignalStyle(chip.signal)}
                >
                  {chip.authority && <AuthorityTag>{chip.authority}</AuthorityTag>}
                  <span className="truncate">{chip.label}</span>
                </span>
              )
            )}
            {overflow > 0 && (
              <span className="inline-flex h-6 items-center rounded-full border bg-secondary px-2.5 text-xs font-medium text-muted-foreground">
                {t('thinking.moreSources', { count: overflow })}
              </span>
            )}
          </div>
        </div>
      )}
    </ChainNode>
  )
}

/* ── Node 4: Next steps (live HITL choice only) ──────────────────────────── */

export interface ChoicePrompt {
  promptId: string
  text: string
  options: string[]
  isResponded: boolean
  selected?: string
}

export interface BranchesNodeProps {
  t: Translator
  prompt: ChoicePrompt
  onRespond: (promptId: string, choice: string) => void
  order: number
}

export const BranchesNode: FC<BranchesNodeProps> = ({ t, prompt, onRespond, order }) => (
  <ChainNode
    tabLabel={t('thinking.node.branchesTab')}
    tabIcon={GitBranch}
    variant="outlined"
    order={order}
    maxWidthClassName="max-w-[680px]"
  >
    <div className="mb-3">
      <div className="text-sm font-semibold text-foreground">
        {prompt.text.trim() || t('thinking.node.branchesTitle')}
      </div>
      <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {t('thinking.node.branchesSub')}
      </div>
    </div>
    <BranchOptions
      options={prompt.options}
      selected={prompt.selected}
      isResponded={prompt.isResponded}
      onSelect={(option) => onRespond(prompt.promptId, option)}
    />
  </ChainNode>
)
