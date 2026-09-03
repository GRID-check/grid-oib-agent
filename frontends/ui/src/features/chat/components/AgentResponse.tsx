/**
 * AgentResponse Component
 *
 * Displays a completed agent response in the chat area.
 * Used for short answers that don't need the full report panel.
 * Left-aligned with distinct styling from user messages.
 */

'use client'

import { type FC, memo, useCallback, useId, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useShallow } from 'zustand/react/shallow'
import type { PluggableList } from 'unified'
import { useLocale, useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { remarkCitationMarkers } from '@/features/layout/lib/citation-markers'
import { formatTime } from '@/shared/utils/format-time'
import { useLayoutStore } from '@/features/layout/store'
import { GridCardItem, GridCards } from '@/features/grid-cards/components/GridCards'
import { CardSetProvider } from '@/features/grid-cards/card-set'
import {
  CALLOUT_SLOT_INDEX,
  hasPlacedCalloutMarker,
  remarkCardMarkers,
  unplacedCardIndices,
} from '@/features/grid-cards/card-markers'
import { MarkdownSlotProvider } from '@/shared/components/MarkdownRenderer/slot-context'
import type { GridCard } from '@/shared/cards/schemas'
import type { CitationSource } from '../types'
import type { AnswerConfidenceCappedReason } from '@/lib/conversations/message-provenance'
import {
  ANSWER_DEGRADED_REASONS,
  TRUNCATION_REASONS,
} from '@/lib/conversations/message-provenance'
import type { MessageStages } from '@/lib/conversations/message-stages'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import { useChatStore } from '../store'
import { useLoadJobData } from '../hooks'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  answerDocuments,
  answerSourceAnchorPrefix,
  buildCitationModel,
  splitAnswerBody,
} from '../lib/citations'
import { AnswerCitations } from './AnswerCitations'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'
import { SkillsUsedDisclosure } from '@/features/skills/components/SkillsUsedDisclosure'
import { AnswerSourcesRow } from './AnswerSourcesRow'
import { MemoryNotedChip } from './MemoryNotedChip'
import { turnMemoryItems, type TurnMemoryItem } from '../lib/turn-memory'
import { answerMetaToAnatomy } from '../lib/answer-meta-cards'
import { AnatomyBlock, AnatomyMasthead } from './AnswerAnatomy'
import type { AnswerMeta } from '@/lib/conversations/message-answer-meta'
import { ConfidenceChip, type AnswerConfidence } from './ConfidenceChip'
import { AnswerFeedback } from './AnswerFeedback'
import { AnswerActions } from './AnswerActions'

/**
 * The first paragraph of a long answer, typeset as a lede.
 *
 * The agent is asked to lead with the ruling or the number. That rule is the
 * `<stimme>` section of the researcher's system prompt („Der erste Satz ist die
 * Antwort"), unconditional on every answering turn since the `piloti-voice`
 * platform skill was folded into it. The answer arrives with its conclusion first —
 * but a conclusion set at exactly the weight of the reasoning beneath it is a
 * conclusion the reader still has to go looking for.
 * One notch of size and air is enough to make the answer legible before the
 * audit trail is read, without turning the reply into a document with a title.
 *
 * Applied only when it earns its keep: a short reply IS its own lede, and
 * enlarging its single paragraph would just look like a font bug.
 */
const LEDE_CLASS =
  '[&>.markdown-content>p:first-child]:text-[1.0625rem] ' +
  '[&>.markdown-content>p:first-child]:leading-[1.65] ' +
  '[&>.markdown-content>p:first-child]:mb-4'

/** Below this, the answer is short enough to read whole — no lede. */
const LEDE_MIN_CHARS = 600

/**
 * A lede only makes sense when the answer opens with prose. An answer that
 * opens with a heading, a list, a table, a quote, a fence or a card marker has
 * already chosen a different way in, and enlarging whatever `p` happens to come
 * first would land the emphasis somewhere arbitrary.
 */
const NON_PROSE_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|\[\[card:)/

function opensWithLede(body: string, isStreaming: boolean): boolean {
  if (isStreaming || body.length < LEDE_MIN_CHARS) return false
  const trimmed = body.trimStart()
  const firstLine = trimmed.split('\n', 1)[0]
  if (!firstLine || NON_PROSE_OPENER.test(firstLine)) return false
  // Two blocks minimum: a lede needs something to lead into.
  return trimmed.split(/\n{2,}/).length >= 2
}

export interface AgentResponseProps {
  /** Response content from the agent */
  content: string
  /** Timestamp of the response (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /** Whether to show a button to view the full report */
  showViewReport?: boolean
  /** Display variant - 'default' has box styling, 'inline' has no box (for use inside containers) */
  variant?: 'default' | 'inline'
  /** Deep research job ID for loading report data on-demand */
  jobId?: string
  /** Whether this message has active (streaming) deep research */
  isDeepResearchActive?: boolean
  /** Job status for determining button behavior */
  deepResearchJobStatus?: 'submitted' | 'running' | 'success' | 'failure' | 'interrupted'
  /**
   * Grid cards attached to this answer. Each is drawn where the answer placed
   * it with a `[[card:N]]` marker (N is 1-based over this array); the ones no
   * marker claimed follow the prose as a block. Positions are identity: a
   * rejected card leaves an `undefined` hole rather than renumbering the rest
   * (see `validateGridCards`), and a hole renders nothing.
   */
  cards?: (GridCard | undefined)[]
  /**
   * Citations already collected for this answer (deep-research path). Drives
   * the "Belegt durch" chip row — renders nothing when absent (no fake chips).
   */
  citations?: CitationSource[]
  /** Conversation this response belongs to (keys the per-answer feedback row) */
  conversationId?: string | null
  /**
   * The reader's answer to each interactive card of this answer, keyed by
   * `cardKey`. Needed HERE, not only inside the cards, because a
   * `memory_proposal` only becomes something Piloti remembered once the reader
   * says yes — and the „Piloti hat sich gemerkt" chip must not claim a write
   * that has not happened.
   */
  cardInteractions?: CardInteractions
  /**
   * What a POST-ANSWER STAGE computed for this turn
   * (`docs/architecture/post-answer-stages.md` §4.3). Only
   * `memoryReflection` is read here; the follow-ups rail is a SIBLING of this
   * component in the thread column, not part of the answer card (§6.1).
   */
  stages?: MessageStages
  /**
   * The answer's structured anatomy (verdict / takeaways / callout) — native
   * answer fields with a FIXED layout: the verdict renders above the prose,
   * the callout and the takeaways after it. Gated backend-side and sanitized
   * at every boundary; never part of `cards`.
   */
  answerMeta?: AnswerMeta
  /** The assistant's guarded self-assessed answer confidence (shallow answers only) */
  answerConfidence?: 'low' | 'medium' | 'high'
  /**
   * Why the self-assessed confidence was capped (WP-A transparency extra) —
   * `'ungrounded'` or `'quote_unverified'` add the matching cap explanation to
   * the ConfidenceChip tooltip (PB-9).
   */
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  /**
   * The model's own one-clause justification for its confidence level, shown
   * verbatim in the ConfidenceChip tooltip.
   */
  answerConfidenceReason?: string
  /**
   * Citation-verification result: how many citations were removed as
   * unverifiable, with de-duplicated reasons. Renders a muted note under the
   * "Belegt durch" sources row when present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * The turn's research was cut off at its budget ceiling: this answer rests on
   * the evidence gathered up to that point rather than on a finished search.
   * Renders one muted line directly under the sources row — a fact about the
   * EVIDENCE, in the same register as the row above it. Never a badge on the
   * answer and never folded into the confidence chip: that grades whether the
   * claims are sourced, which a truncated answer can be, perfectly.
   */
  researchTruncated?: true
  /**
   * WHY it was cut off, as the backend's stable token (`wall_clock`,
   * `step_limit`). Appended to the line above as a short parenthetical.
   *
   * Typed `string`, not the union, deliberately: this crosses a version
   * boundary — a newer backend can name a cutoff cause this build has never
   * heard of — and the component's contract is that it renders only tokens it
   * has a sentence for. An unknown one renders NOTHING; it is never shown raw,
   * because `wall_clock` under an answer about Fluchtwegbreiten is noise that
   * looks like a defect.
   */
  truncationReason?: string
  /**
   * Ways this answer is weaker than one from a finished run, as stable tokens
   * (`no_report_file`, `no_valid_citations`). Same token contract as above:
   * de-duplicated, unknown entries dropped, an empty list rendering nothing —
   * "degraded in zero ways" is the ordinary case and is not stated.
   */
  degradedReasons?: string[]
  /**
   * Skills whose full instructions the agent loaded while writing this answer
   * (`use_skill`), in activation order. Absent on a turn that activated none,
   * which is the common case — availability is not activation.
   */
  skillsActivated?: string[]
  /**
   * The `grid-hidden` subset of `skillsActivated` — a skill that runs on every
   * answer (the house voice), muted in the disclosure until the reader turns on
   * the reasoning view. Named there, never dropped.
   */
  skillsHidden?: string[]
  /**
   * The reader's `showReasoningSkills` preference. Passed in from the list
   * parent rather than read here, because this component renders once PER
   * MESSAGE — a hook that fetches the preference on mount would fire one GET per
   * answer in the thread and re-render every message when it settled. Defaults
   * to closed, so the muted rows stay muted for the SpectatedTurn and dev
   * surfaces that do not thread it.
   */
  showReasoning?: boolean
  /**
   * Whether the self-assessment ConfidenceChip renders (WorkOS
   * `chat-confidence-chip` flag, FB-6). Defaults to true so the feature stays
   * visible with flag enforcement off (fail-open) and existing callers/specs
   * are unaffected.
   */
  showConfidenceChip?: boolean
  /**
   * Client-side message identifier of this answer — keys the per-answer
   * thumbs feedback row (WS-7). No feedback row renders when absent (e.g.
   * legacy callers), so existing usages are unaffected.
   */
  messageId?: string
  /**
   * Whether the per-answer thumbs feedback row renders (WorkOS
   * `answer-feedback` flag). Defaults to true (fail-open, matching the other
   * flag props) — the row still requires a `messageId` to appear.
   */
  showAnswerFeedback?: boolean
  /**
   * Whether this answer is still streaming (C6). Drives the blinking caret at
   * the end of the answer body and the partial-markdown stabilizer in the
   * MarkdownRenderer. Threaded from `message.isStreaming` by ChatArea.
   */
  isStreaming?: boolean
  /**
   * Which path the turn turned out to take, observed after the answer (WP-A
   * transparency extra). `'meta'` marks a conversational / clarifying reply (greetings,
   * capability questions, Rückfragen) — rendered with a quiet neutral "Hinweis"
   * role tab so it reads clearly apart from a substantive Baurecht answer
   * (`'shallow'`/`'deep'`, the ink "Ergebnis" tab). Absent/`'error'` fall back
   * to the "Ergebnis" treatment, so existing callers render exactly as before.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
}

/** Blinking caret shown at the tail of a still-streaming answer (C6). */
const StreamingCaret: FC = () => (
  <span
    aria-hidden="true"
    className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-foreground/70 align-baseline motion-reduce:animate-none"
  />
)

/**
 * The verification's own vocabulary for dropping a citation
 * (`common/citation_verification.py`). Listed here because THIS is the file
 * that owns the words for them — see {@link localizeToken}.
 */
const CITATION_REMOVAL_REASONS = [
  'url_not_in_registry',
  'citation_key_not_in_registry',
  'unverifiable',
  'duplicate',
  'ungrounded',
  'quote_unverified',
] as const

/**
 * One stable backend token, in the reader's language — or nothing.
 *
 * The backend states these as tokens ON PURPOSE: it has no locale, and a
 * sentence composed in the agent tier would arrive in whichever language that
 * turn happened to think in. So the frontend owns the words, which makes the
 * unknown-token case the one that matters. It is not hypothetical — a token is
 * added on the producer's release train, not ours, and it also arrives from a
 * jsonb row written by a build that is not this one.
 *
 * The allow-list is checked BEFORE `t()` rather than trusting the dictionary to
 * miss: `createTranslator` falls back to the key itself, so an unmapped token
 * would not render nothing, it would render
 * `answerSources.truncationReason.tool_budget` under an answer about building
 * law. Silence is the honest rendering of "the system said something this build
 * cannot put into words" — the FACT (the run was cut off, N citations were
 * dropped) is carried by the line the token only qualifies, and that line still
 * renders.
 */
function localizeToken(
  t: Translator,
  group: string,
  token: string,
  known: readonly string[]
): string | null {
  return known.includes(token) ? t(`${group}.${token}`) : null
}

/**
 * The same, for a LIST of tokens: localized, de-duplicated, order preserved.
 * Duplicates are dropped by the rendered SENTENCE rather than by the token, so
 * two tokens that this build words identically still produce one line.
 */
function localizeTokens(
  t: Translator,
  group: string,
  tokens: string[] | undefined,
  known: readonly string[]
): string[] {
  const lines: string[] = []
  for (const token of tokens ?? []) {
    const line = typeof token === 'string' ? localizeToken(t, group, token, known) : null
    if (line && !lines.includes(line)) lines.push(line)
  }
  return lines
}

/**
 * Muted note under the "Belegt durch" row: citation verification removed one or
 * more citations from this answer as unverifiable (WP-A `citations_removed`).
 * The de-duplicated reasons hang off a tooltip so the row stays quiet by
 * default. Renders nothing when nothing was removed.
 */
const CitationsRemovedNote: FC<{ citationsRemoved?: { count: number; reasons: string[] } }> = ({
  citationsRemoved,
}) => {
  const t = useTranslations('chat')
  if (!citationsRemoved || citationsRemoved.count <= 0) return null

  const label = t('answerSources.citationsRemoved', { count: citationsRemoved.count })
  // Localized, not passed through. These are verification TOKENS
  // (`url_not_in_registry`), and the tooltip used to print them verbatim — which
  // nobody outside this repository can read. A token with no sentence here is
  // left out; the count above is the fact and it is unaffected.
  const reasons = localizeTokens(
    t,
    'answerSources.citationsRemovedReason',
    citationsRemoved.reasons,
    CITATION_REMOVAL_REASONS
  )

  const text = (
    <span className="text-xs leading-relaxed text-muted-foreground" role="note">
      {label}
    </span>
  )

  if (reasons.length === 0) {
    return <div className="mt-1.5">{text}</div>
  }

  return (
    <div className="mt-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="cursor-help rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={label}
          >
            <span className="text-xs leading-relaxed text-muted-foreground underline decoration-dotted underline-offset-2">
              {label}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {/* `text-current`: the tooltip paints its own foreground, and the
              eyebrow's muted ink would drop below AA on it. */}
          <SectionLabel className="mb-1 block text-current">
            {t('answerSources.citationsRemovedReasonsLabel')}
          </SectionLabel>
          <ul className="list-disc space-y-0.5 pl-4">
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * The line under the sources row for a turn whose research was CUT OFF.
 *
 * Two sentences, not one with a clause bolted on: an answer that found nothing
 * cannot be described as resting on "the evidence gathered up to that point",
 * because there is none — and that case, cut off before it found anything, is
 * both the worst one and the one a reader most needs told plainly. The gap row
 * above already says the answer cites nothing; this says the search stopped
 * early, so the two read as one statement instead of contradicting each other.
 *
 * `role="note"`, muted, no icon, no tint, no border: truncation is a property
 * of the EVIDENCE, not an error state and not a verdict on the answer.
 */
const ResearchTruncatedNote: FC<{
  researchTruncated?: true
  truncationReason?: string
  hasSources: boolean
}> = ({ researchTruncated, truncationReason, hasSources }) => {
  const t = useTranslations('chat')
  if (!researchTruncated) return null
  const sentence = t(
    hasSources
      ? 'answerSources.researchTruncated'
      : 'answerSources.researchTruncatedWithoutSources'
  )
  // The cause rides the same line as a parenthetical rather than claiming one of
  // its own: "it ran out of time" is not a second statement, it is the first one
  // finished. Absent (or unknown) leaves the sentence exactly as it was before
  // this field existed, which is what every turn before today's backend has.
  const cause = truncationReason
    ? localizeToken(t, 'answerSources.truncationReason', truncationReason, TRUNCATION_REASONS)
    : null
  return (
    <div className="mt-1.5">
      <span className="text-xs leading-relaxed text-muted-foreground" role="note">
        {cause ? `${sentence} (${cause})` : sentence}
      </span>
    </div>
  )
}

/**
 * What the cutoff COST — one muted line per degradation, under the truncation
 * line and in the same register.
 *
 * Separate lines rather than one joined sentence because the two known
 * degradations ask for different things: "no report was filed" tells the reader
 * this thread is the only copy, "nothing survived verification" tells them to
 * check the figures before they use them. Joining them would make one of the two
 * a subordinate clause of the other.
 *
 * Still `role="note"`, still no icon, tint or border. A salvaged answer can be
 * perfectly well-grounded in what it did reach, and this must not turn a good
 * one into an alarm — but it must also never be silent about the way the answer
 * is weaker, which is precisely what it was before this rendered at all.
 */
const AnswerDegradedNote: FC<{ degradedReasons?: string[] }> = ({ degradedReasons }) => {
  const t = useTranslations('chat')
  const lines = localizeTokens(
    t,
    'answerSources.degradedReason',
    degradedReasons,
    ANSWER_DEGRADED_REASONS
  )
  // An empty list is not a claim: a turn that degraded in none of the known ways
  // — and one whose every token this build cannot word — says nothing here.
  if (lines.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-0.5">
      {lines.map((line) => (
        <span key={line} className="text-xs leading-relaxed text-muted-foreground" role="note">
          {line}
        </span>
      ))}
    </div>
  )
}

/**
 * The single disclosure in the answer footer.
 *
 * The footer keeps verdict, body, the "Belegt durch" sources row and the copy
 * actions visible; everything else the turn carries — confidence, the memory
 * note, the skills that shaped the answer, the verification notes, the
 * full feedback row and the timestamp — lives behind ONE muted text-xs trigger
 * line. `SkillsUsedDisclosure` is MOVED here, not duplicated: it renders null
 * on a turn that activated nothing, like every other item inside.
 */
const AnswerDetails: FC<{
  hasConfidence: boolean
  answerConfidence?: AnswerConfidence
  answerConfidenceCappedReason?: AnswerConfidenceCappedReason
  answerConfidenceReason?: string
  memoryItems: TurnMemoryItem[]
  skillsActivated?: string[]
  skillsHidden?: string[]
  showReasoning?: boolean
  researchTruncated?: true
  truncationReason?: string
  degradedReasons?: string[]
  citationsRemoved?: { count: number; reasons: string[] }
  hasAnswerSources: boolean
  hasFeedback: boolean
  messageId?: string
  conversationId?: string | null
  timestamp?: Date | string
}> = ({
  hasConfidence,
  answerConfidence,
  answerConfidenceCappedReason,
  answerConfidenceReason,
  memoryItems,
  skillsActivated,
  skillsHidden,
  showReasoning,
  researchTruncated,
  truncationReason,
  degradedReasons,
  citationsRemoved,
  hasAnswerSources,
  hasFeedback,
  messageId,
  conversationId,
  timestamp,
}) => {
  const t = useTranslations('chat')
  // Without the locale `formatTime` uses the RUNTIME default, so a German user on
  // an en-US browser got "03:35 PM" beside cards that all say "15:35".
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col">
      <CollapsibleTrigger
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 touch-target flex items-center gap-1.5 self-start rounded-md text-xs leading-relaxed transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2"
        aria-label={t('answerDetails.triggerAria')}
        data-testid="answer-details-trigger"
      >
        <span>{t('answerDetails.trigger')}</span>
        <ChevronDown
          className={`size-3 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none${open ? ' rotate-180' : ''}`}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1.5">
        <div className="flex flex-col gap-2">
          {hasConfidence && (
            <ConfidenceChip
              confidence={answerConfidence}
              cappedReason={answerConfidenceCappedReason}
              reason={answerConfidenceReason}
            />
          )}
          <MemoryNotedChip items={memoryItems} />
          <SkillsUsedDisclosure
            skillsActivated={skillsActivated}
            hiddenSkills={skillsHidden}
            showReasoning={showReasoning}
          />
          <ResearchTruncatedNote
            researchTruncated={researchTruncated}
            truncationReason={truncationReason}
            hasSources={hasAnswerSources}
          />
          <AnswerDegradedNote degradedReasons={degradedReasons} />
          <CitationsRemovedNote citationsRemoved={citationsRemoved} />
          {hasFeedback && messageId && (
            <AnswerFeedback messageId={messageId} conversationId={conversationId} />
          )}
          {timestamp && <span className="text-subtle text-xs">{formatTime(timestamp, locale)}</span>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Agent response bubble component for completed responses
 */
const AgentResponseComponent: FC<AgentResponseProps> = ({
  content,
  timestamp,
  showViewReport = false,
  variant = 'default',
  jobId,
  isDeepResearchActive = false,
  deepResearchJobStatus,
  cards,
  citations,
  conversationId,
  cardInteractions,
  stages,
  answerMeta,
  answerConfidence,
  answerConfidenceCappedReason,
  answerConfidenceReason,
  citationsRemoved,
  researchTruncated,
  truncationReason,
  degradedReasons,
  skillsActivated,
  skillsHidden,
  showReasoning = false,
  showConfidenceChip = true,
  messageId,
  showAnswerFeedback = true,
  isStreaming = false,
  routingDecision,
}) => {
  const t = useTranslations('chat')
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const projectId = useChatStore((s) => s.projectId)
  // An answer that ends in a written "## Quellen" list used to state its sources
  // TWICE — that list AND the "Belegt durch" chips, each holding half the truth
  // (numbers/titles/pages vs. provenance color, authority and click-through).
  // Lift the list out of the body and hand its entries to AnswerSourcesRow,
  // which renders the one consolidated block; the inline [N] markers left in the
  // prose become links to its rows. Answers without such a section are untouched.
  const fallbackId = useId()
  const anchorPrefix = answerSourceAnchorPrefix(messageId ?? fallbackId)
  // The answer is finished before its first delta leaves the agent, so
  // `isStreaming` is a state the turn passes through in a frame or two. The
  // client-side typewriter that used to pace the reveal (`use-typed-reveal`)
  // was removed deliberately: the full text paints as soon as it arrives.
  // "Still arriving" is therefore the real streaming window only — the caret
  // trails the text, the footer stays reserved at its height, and nothing that
  // acts on a WHOLE answer — the copy actions, the cards no marker claimed —
  // is offered over half of one.
  const stillArriving = isStreaming
  const {
    body,
    entries: sourceEntries,
    numbers: citationNumbers,
  } = useMemo(() => splitAnswerBody(content), [content])

  // The lede is suppressed when the envelope carries a summary: the masthead's
  // standfirst holds that emphasis, and a 17px summary over a 17px first
  // paragraph would be the same statement twice at the same weight.
  // (`anatomy` is declared below; the class is derived after it.)
  // The markers are linked while the body is PARSED, not before: `[2][3]` — two
  // sources behind one claim, the shape the backend is told to write — is
  // indistinguishable from reference-link syntax in raw text, and used to reach
  // the reader as literal "[2][3]" beside neighbours that got their pill.
  //
  // Cards are placed the same way and for the same reason: the agent writes
  // `[[card:2]]` on a line of its own, and the card is spliced in there rather
  // than stacked above the answer it is supposed to illustrate.
  const cardCount = cards?.length ?? 0
  // The answer's structured anatomy, rendered FLAT (`AnswerAnatomy.tsx`) as
  // answer typography: the verdict as the masthead above the prose, the
  // takeaways closing it, the callout beside the paragraph its `[[callout]]`
  // marker anchors it to — or after the prose when unanchored. The shape set
  // feeds every CardSetProvider so cross-card rules (charter §A2) see the
  // anatomy too, even though it never joins the `cards` array.
  const anatomy = useMemo(() => answerMetaToAnatomy(answerMeta), [answerMeta])
  const ledeClass = opensWithLede(body, stillArriving) && !anatomy?.summary ? LEDE_CLASS : ''
  const markerPlugins = useMemo(
    (): PluggableList => [
      [remarkCitationMarkers, { numbers: citationNumbers, anchorPrefix }],
      [remarkCardMarkers, { count: cardCount, callout: Boolean(anatomy?.callout) }],
    ],
    [citationNumbers, anchorPrefix, cardCount, anatomy]
  )
  // The cards the prose did NOT claim. Read off the same body the renderer
  // parses, because the block below has to be built before that parse happens.
  const fallbackCardIndices = useMemo(() => unplacedCardIndices(body, cardCount), [body, cardCount])
  // The after-prose anatomy: the callout leaves this block the moment the
  // prose claims it with a marker — same pre-render reading as the card
  // fallback above, and for the same reason.
  const anatomyBelow = useMemo(() => {
    if (!anatomy) return []
    if (anatomy.callout && hasPlacedCalloutMarker(body)) {
      return anatomy.below.filter((card) => card.type !== 'callout')
    }
    return anatomy.below
  }, [anatomy, body])
  // Renders nothing when the index has no card yet — while streaming a marker
  // routinely arrives several frames before the card it names, and a hole is
  // better than a crash or a raw `[[card:2]]`.
  const cardSet = useMemo(
    () => [...(cards ?? []), ...(anatomy?.all ?? [])],
    [cards, anatomy]
  )
  const renderCardSlot = useCallback(
    (index: number) => {
      // The callout's slot: the one anatomy block the prose may anchor.
      if (index === CALLOUT_SLOT_INDEX) {
        if (!anatomy?.callout) return null
        return (
          <div className="mb-3 block!">
            <CardSetProvider cards={cardSet}>
              <AnatomyBlock card={anatomy.callout} />
            </CardSetProvider>
          </div>
        )
      }
      const card = cards?.[index]
      if (!card) return null
      // `mb-3` is the paragraph rhythm of the markdown body: the card replaced
      // a paragraph, so it has to leave the same gap behind it. `block!` beats
      // the streaming caret's `*:last-child]:inline` rule, which would collapse
      // a card that ends the answer for as long as the answer is still arriving.
      return (
        <div className="mb-3 block!">
          {/* The whole answer's cards, not just this one: a card placed inline
              by a marker still has to know what ELSE the answer is carrying —
              `summary` and `verdict_header` must not both claim the top of it
              (grid-card-charter.md §A2). See `grid-cards/card-set.tsx`. */}
          <CardSetProvider cards={cardSet}>
            <GridCardItem card={card} index={index} projectId={projectId} messageId={messageId} />
          </CardSetProvider>
        </div>
      )
    },
    [cards, cardSet, projectId, messageId]
  )
  // ONE derivation for the whole answer: the inline `[N]` markers in the prose
  // and the provenance chips below are the same citations seen twice, and two
  // derivations of one citation is exactly the defect the model removes.
  const documents = useMemo(
    () => buildCitationModel({ citations, entries: sourceEntries, cards }),
    [citations, sourceEntries, cards]
  )
  // The SAME predicate the sources row uses to decide between chips and the
  // "Ohne Quellenbeleg" gap row — so the truncation line never promises
  // "the evidence gathered up to that point" beside a row saying there is none.
  const hasAnswerSources = useMemo(() => answerDocuments(documents).length > 0, [documents])

  const { reportContent, deepResearchJobId, isDeepResearchStreaming, deepResearchStreamLoaded } =
    useChatStore(useShallow((s) => ({
      reportContent: s.reportContent,
      deepResearchJobId: s.deepResearchJobId,
      isDeepResearchStreaming: s.isDeepResearchStreaming,
      deepResearchStreamLoaded: s.deepResearchStreamLoaded,
  })))
  const reconnectToActiveJob = useChatStore((s) => s.reconnectToActiveJob)
  const { loadResearchPanelTab, isLoading, error } = useLoadJobData()
  // Computed here, not inside MemoryNotedChip: the merged footer's meta row only
  // renders when it has something to hold, and "Piloti noted N" is one of those
  // things — a memory-only turn (both chip flags off, no timestamp) must still
  // show it rather than have the row unmount around it.
  //
  // Read off THIS MESSAGE. It used to be `useConversationMemory(projectId,
  // conversationId)`, a three-shot poll of the project's memory endpoint fired
  // by every rendered answer: thirty GETs in a ten-answer thread, on a fixed
  // `[0, 1500, 4000]` ms schedule that was a guess about how long an LLM takes,
  // and scoped to the CONVERSATION, so every answer in the thread showed every
  // item — turn one's answer read „Piloti hat sich 5 gemerkt" after turn five.
  // The reflection stage now delivers a frame addressed to the turn it belongs
  // to, so the chip can finally be what it always claimed to be.
  const memoryItems = useMemo(
    () => turnMemoryItems({ stages, cards, cardInteractions }),
    [stages, cards, cardInteractions]
  )

  // Determine if we should show the action button
  // Show "View Progress" for active jobs, "View Report" for completed jobs
  const isJobActive = isDeepResearchActive || deepResearchJobStatus === 'submitted' || deepResearchJobStatus === 'running'
  const isJobComplete = deepResearchJobStatus === 'success' || deepResearchJobStatus === 'failure' || deepResearchJobStatus === 'interrupted'
  const shouldShowButton = showViewReport || (jobId && (isJobActive || isJobComplete))
  const buttonText = isJobActive ? t('agentResponse.viewProgress') : t('agentResponse.viewReport')

  // Check if a different job is currently streaming (in progress)
  const isAnotherJobStreaming = isDeepResearchStreaming && deepResearchJobId && deepResearchJobId !== jobId

  const handleViewReport = useCallback(async () => {
    // For active jobs, ensure stream is connected and open the panel
    if (isJobActive) {
      // Reconnect to active job if not already streaming this job
      if (!isDeepResearchStreaming || deepResearchJobId !== jobId) {
        await reconnectToActiveJob()
      }
      setResearchPanelTab('tasks')
      openRightPanel('research')
      return
    }

    // If another job is actively streaming, just open the panel to show current progress
    // Don't load this report's data as it would interrupt the active research
    if (isAnotherJobStreaming) {
      setResearchPanelTab('tasks')
      openRightPanel('research')
      return
    }

    // For completed jobs, check if we have ALL research data for THIS specific job
    // Important: must verify job ID matches to avoid showing wrong data
    const hasExistingDataForThisJob =
      jobId &&
      deepResearchJobId === jobId &&
      deepResearchStreamLoaded &&
      reportContent &&
      reportContent.trim().length > 0

    if (hasExistingDataForThisJob) {
      setResearchPanelTab('report')
      openRightPanel('research')
      return
    }

    if (jobId) {
      await loadResearchPanelTab(jobId, 'report')
    } else {
      setResearchPanelTab('report')
      openRightPanel('research')
    }
  }, [jobId, deepResearchJobId, reportContent, deepResearchStreamLoaded, isJobActive, isAnotherJobStreaming, isDeepResearchStreaming, loadResearchPanelTab, reconnectToActiveJob, setResearchPanelTab, openRightPanel])

  const hasCards = cardCount > 0

  // What the merged footer's meta row would actually hold. The flags alone are
  // not the answer: `showConfidenceChip` is on by default but the chip renders
  // nothing without a level, and the feedback row needs a `messageId` — gating
  // the row on the flags let it mount as an empty band (bare spacer + its own
  // gap) on a meta turn that has neither.
  const hasConfidence =
    showConfidenceChip &&
    (answerConfidence === 'low' || answerConfidence === 'medium' || answerConfidence === 'high')
  const hasFeedback = showAnswerFeedback && Boolean(messageId)
  // The copy actions. A still-arriving answer cannot be copied — half a
  // Prüfvermerk is worse than none — and a cards-only turn has no markdown to
  // hand over, so both are excluded rather than given a button that copies ''.
  const hasAnswerActions =
    !stillArriving && Boolean(content) && content.trim().length > 0 && content !== 'null'
  const hasMetaRow =
    hasConfidence ||
    hasFeedback ||
    hasAnswerActions ||
    Boolean(timestamp) ||
    memoryItems.length > 0
  // Streaming still has no chips/thumbs, but the row is reserved at chip
  // height so the footer does not jump when they land. An idle answer with
  // nothing to hold still omits the row (no empty band).
  const reserveMetaRow = hasMetaRow || stillArriving
  // What the single footer disclosure would actually hold. The copy actions
  // stay visible beside its trigger, so a bare answer (copyable and nothing
  // else) shows the action and no empty trigger line.
  const hasDetailsContent =
    hasConfidence ||
    hasFeedback ||
    Boolean(timestamp) ||
    memoryItems.length > 0 ||
    (skillsActivated?.length ?? 0) > 0 ||
    Boolean(researchTruncated) ||
    (degradedReasons?.length ?? 0) > 0 ||
    (citationsRemoved?.count ?? 0) > 0

  /**
   * Where a diagram inside this answer may be filed — or nothing at all.
   *
   * Both halves are required and neither can be invented. Without a `projectId`
   * there is no project to file into (a chat outside a project is a normal
   * state, not a broken one), and without a `messageId` there is no stable
   * identity for the diagram, so filing could not be idempotent and pressing
   * the button twice would file two indistinguishable copies. In either case the
   * diagram renders with no filing affordance rather than a disabled one — the
   * rule the research banner already follows for its `filed` object: a dead
   * action is worse than silence.
   */
  const diagramFilingTarget = useMemo(
    () => (projectId && messageId ? { projectId, answerId: messageId } : null),
    [projectId, messageId]
  )

  // Guard against null, undefined, empty, or literal "null" string content
  // when no cards are present. Cards can render even with empty text.
  if ((!content || !content.trim() || content === 'null') && !hasCards) {
    return null
  }

  // Inline variant - no box styling (for use inside containers like thinking process)
  if (variant === 'inline') {
    return (
      <DiagramFilingProvider target={diagramFilingTarget}>
      <AnswerCitations documents={documents} anchorPrefix={anchorPrefix}>
      <div className="flex w-full flex-col gap-2 overflow-hidden break-words">
        {/* The answer's masthead — verdict and/or summary, flat above the prose. */}
        {anatomy && (anatomy.verdict || anatomy.summary) && (
          <CardSetProvider cards={cardSet}>
            <AnatomyMasthead verdict={anatomy.verdict} summary={anatomy.summary} />
          </CardSetProvider>
        )}
        {/* Response Content rendered as markdown (with streaming caret). While
            streaming, the markdown block + its last child are forced inline so
            the caret trails the final glyph instead of dropping to a new line.
            Cards the answer placed with a marker are spliced into this body. */}
        <MarkdownSlotProvider render={renderCardSlot}>
          <div
            className={
              stillArriving
                ? '[&>.markdown-content>*:last-child]:inline [&>.markdown-content]:inline'
                : ledeClass || undefined
            }
          >
            <MarkdownRenderer content={body} isStreaming={stillArriving} remarkPlugins={markerPlugins} />
            {stillArriving && <StreamingCaret />}
          </div>
        </MarkdownSlotProvider>

        {/* Cards no marker claimed. AFTER the body, never before it: an answer
            that opens with three diagrams has pushed itself below the fold.
            Withheld until the reveal finishes, because "unplaced" is read off
            the body SO FAR: a card whose `[[card:N]]` has not been typed out yet
            looks unplaced, would render here, and would then jump up the answer
            the moment its marker arrives.
            `mt-1` for the same reason the action button below carries one: this
            column's `gap-2` is 8px and the markdown body's paragraph rhythm is
            12px, so without it an UNPLACED card hugged the prose 4px tighter
            than a placed one — visible the moment an answer carries both. */}
        {/* The anatomy below the prose: the callout (unless its marker placed
            it inline), then the takeaways. */}
        {!stillArriving && anatomyBelow.length > 0 && (
          <div className="mt-1 flex flex-col gap-3">
            <CardSetProvider cards={cardSet}>
              {anatomyBelow.map((card) => (
                <AnatomyBlock key={card.type} card={card} />
              ))}
            </CardSetProvider>
          </div>
        )}
        {!stillArriving && cards && fallbackCardIndices.length > 0 && (
          <div className="mt-1">
            <GridCards
              cards={cards}
              indices={fallbackCardIndices}
              projectId={projectId}
              messageId={messageId}
            />
          </div>
        )}

        {/* Optional action button */}
        {shouldShowButton && (
          <div className="mt-1 flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleViewReport}
              disabled={isLoading}
              aria-label={isLoading ? t('agentResponse.loading') : buttonText}
              title={error ? t('agentResponse.errorTitle', { message: error }) : isLoading ? t('agentResponse.loading') : buttonText}
            >
              <span className="flex items-center gap-1">
                {isLoading ? (
                  <>
                    <Spinner size="sm" label={t('agentResponse.loadingLabel')} className="size-3" />
                    <span className="text-xs">{t('agentResponse.loading')}</span>
                  </>
                ) : (
                  <>
                    <span className="text-xs">{buttonText}</span>
                    <ChevronRight className="size-3" aria-hidden="true" />
                  </>
                )}
              </span>
            </Button>
          </div>
        )}

        {/* "Belegt durch": provenance chips for sources this answer carries */}
        <AnswerSourcesRow
          documents={documents}
          anchorPrefix={anchorPrefix}
          routingDecision={routingDecision}
          isStreaming={stillArriving}
        />

        {/* No copy actions here, deliberately. This variant is the box-less
            rendering used INSIDE another container (the thinking process, the
            dev turn surfaces) — it has no consolidated meta row, so the buttons
            would land as one more loose element in a stack that already ends in
            chips, thumbs and a timestamp. And it never renders a delivered
            answer in the thread: ChatArea always uses the default variant, so
            every answer a reader would paste has its buttons on its own card.
            If that changes, <AnswerActions /> drops into the row below. */}
        {reserveMetaRow && (
          <div
            className={
              hasMetaRow
                ? 'animate-in fade-in-0 flex min-h-6 flex-col gap-1.5 duration-quick ease-out motion-reduce:animate-none'
                : 'min-h-6'
            }
            aria-hidden={hasMetaRow ? undefined : true}
          >
            {hasDetailsContent && (
              <AnswerDetails
                hasConfidence={hasConfidence}
                answerConfidence={answerConfidence}
                answerConfidenceCappedReason={answerConfidenceCappedReason}
                answerConfidenceReason={answerConfidenceReason}
                memoryItems={memoryItems}
                skillsActivated={skillsActivated}
                skillsHidden={skillsHidden}
                showReasoning={showReasoning}
                researchTruncated={researchTruncated}
                truncationReason={truncationReason}
                degradedReasons={degradedReasons}
                citationsRemoved={citationsRemoved}
                hasAnswerSources={hasAnswerSources}
                hasFeedback={hasFeedback}
                messageId={messageId}
                conversationId={conversationId}
                timestamp={timestamp}
              />
            )}
          </div>
        )}
      </div>
      </AnswerCitations>
      </DiagramFilingProvider>
    )
  }

  // Default variant — the click-dummy "Ergebnis" card: a role tab over a
  // tinted shell whose white inner block carries the composed answer, then a
  // "Belegt durch" provenance row and the feedback row, hairline-separated.
  //
  // A `meta`-routed turn (conversational reply / clarifying Rückfrage) swaps the
  // ink "Ergebnis" tab for a quiet neutral "Hinweis" tab so it reads clearly
  // apart from a substantive Baurecht answer — the only visual change; anatomy,
  // spacing and provenance rows are identical. Any other routing (shallow/deep/
  // error) or an absent signal keeps the "Ergebnis" tab (fail-open).
  const isMeta = routingDecision === 'meta'
  return (
    <DiagramFilingProvider target={diagramFilingTarget}>
    <AnswerCitations documents={documents} anchorPrefix={anchorPrefix}>
    {/* Full column width, not a fixed 680px: the answer is the thread's main
        content and reads as a centered column (the width itself is set by the
        list's max-w container), rather than a card hugging the left edge with
        dead space beside it. */}
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full flex-col duration-base ease-entrance motion-reduce:animate-none">
      {/* Role tab — uppercase 10.5/600. Substantive answer: near-black action
          fill + check. Meta reply: quiet secondary fill + conversation icon. */}
      {isMeta ? (
        <SectionLabel as="div" className="ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md bg-secondary px-2.5 py-1 text-secondary-foreground">
          <MessageCircle className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
          {t('roles.note')}
        </SectionLabel>
      ) : (
        <SectionLabel as="div" className="ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md bg-primary px-2.5 py-1 text-primary-foreground">
          <Check className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
          {t('roles.result')}
        </SectionLabel>
      )}

      {/* Shell: subtle surface + hairline + soft shadow, corners clipped. A meta
          reply sits on a quieter muted surface, so the whole card — not just the
          tab — reads as the calmer, non-result kind. Both kinds use shadow-sm,
          matching the composer's elevation so the answer never outranks it. */}
      <div
        className={
          isMeta
            ? 'overflow-hidden rounded-lg border border-input bg-muted shadow-sm'
            : 'overflow-hidden rounded-lg border border-input bg-input-background shadow-sm'
        }
      >
        {/* Answer body — the hero white surface. It fills the top of the card
            flush (corners clipped by the shell) and is separated from the
            provenance footer by a single hairline, so the whole thing reads as
            one considered object with sections — not a card floating in a tray. */}
        <div className="flex flex-col gap-2 break-words border-b bg-card px-[22px] pb-[17px] pt-[18px]">
          {/* The answer's masthead — verdict and/or summary, flat above the prose. */}
          {anatomy && (anatomy.verdict || anatomy.summary) && (
          <CardSetProvider cards={cardSet}>
            <AnatomyMasthead verdict={anatomy.verdict} summary={anatomy.summary} />
          </CardSetProvider>
        )}
        {/* Response Content rendered as markdown (with streaming caret).
              Cards the answer placed with a marker are spliced into this body. */}
          <MarkdownSlotProvider render={renderCardSlot}>
            <div
              className={
                stillArriving
                  ? '[&>.markdown-content>*:last-child]:inline [&>.markdown-content]:inline'
                  : ledeClass || undefined
              }
            >
              <MarkdownRenderer content={body} isStreaming={stillArriving} remarkPlugins={markerPlugins} />
              {stillArriving && <StreamingCaret />}
            </div>
          </MarkdownSlotProvider>

          {/* Cards no marker claimed. AFTER the body, never before it: an answer
              that opens with three diagrams has pushed itself below the fold.
              `mt-1` for the same reason the action button below carries one:
              this column's `gap-2` is 8px and the markdown body's paragraph
              rhythm is 12px, so without it an UNPLACED card hugged the prose 4px
              tighter than a placed one — visible the moment an answer carries
              both, which is what /dev/chat-turn?variant=two-cards shows. */}
          {/* The anatomy below the prose: the callout (unless its marker placed
              it inline), then the takeaways. */}
          {!stillArriving && anatomyBelow.length > 0 && (
          <div className="mt-1 flex flex-col gap-3">
            <CardSetProvider cards={cardSet}>
              {anatomyBelow.map((card) => (
                <AnatomyBlock key={card.type} card={card} />
              ))}
            </CardSetProvider>
          </div>
        )}
        {!stillArriving && cards && fallbackCardIndices.length > 0 && (
            <div className="mt-1">
              <GridCards
                cards={cards}
                indices={fallbackCardIndices}
                projectId={projectId}
                messageId={messageId}
              />
            </div>
          )}

          {/* Optional action button stays inside the block */}
          {shouldShowButton && (
            <div className="mt-1 flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleViewReport}
                disabled={isLoading}
                aria-label={isLoading ? t('agentResponse.loading') : buttonText}
                title={error ? t('agentResponse.errorTitle', { message: error }) : isLoading ? t('agentResponse.loading') : buttonText}
              >
                <span className="flex items-center gap-1">
                  {isLoading ? (
                    <>
                      <Spinner size="sm" label={t('agentResponse.loadingLabel')} className="size-3" />
                      <span className="text-xs">{t('agentResponse.loading')}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-xs">{buttonText}</span>
                      <ChevronRight className="size-3" aria-hidden="true" />
                    </>
                  )}
                </span>
              </Button>
            </div>
          )}
        </div>

        {/* Provenance footer — ONE tinted zone under the body's hairline that
            holds the sources block, the copy actions, and a single disclosure
            for everything else (confidence, memory note, skills used,
            verification notes, feedback, timestamp). The sources row must not
            draw its own divider here (the body hairline already separates), so
            it takes withDivider={false}. */}
        <div className="flex flex-col gap-2.5 px-[22px] pb-[14px] pt-3">
          <AnswerSourcesRow
            documents={documents}
            anchorPrefix={anchorPrefix}
            routingDecision={routingDecision}
            isStreaming={stillArriving}
            withDivider={false}
          />
          {reserveMetaRow && (
            <div
              className={
                hasMetaRow
                  ? 'animate-in fade-in-0 flex min-h-6 flex-wrap items-center gap-2 duration-quick ease-out motion-reduce:animate-none'
                  : 'min-h-6'
              }
              aria-hidden={hasMetaRow ? undefined : true}
            >
              {/* Copy the answer out — markdown, with or without its sources
                  written out. Before the disclosure: "take this with you" is
                  what the reader wants first; the details are the afterthought. */}
              {hasAnswerActions && (
                <AnswerActions
                  content={content}
                  body={body}
                  documents={documents}
                  conversationId={conversationId}
                  messageId={messageId}
                />
              )}
              {hasMetaRow && <span className="flex-1" aria-hidden="true" />}
              {hasDetailsContent && (
                <AnswerDetails
                  hasConfidence={hasConfidence}
                  answerConfidence={answerConfidence}
                  answerConfidenceCappedReason={answerConfidenceCappedReason}
                  answerConfidenceReason={answerConfidenceReason}
                  memoryItems={memoryItems}
                  skillsActivated={skillsActivated}
                  skillsHidden={skillsHidden}
                  showReasoning={showReasoning}
                  researchTruncated={researchTruncated}
                  truncationReason={truncationReason}
                  degradedReasons={degradedReasons}
                  citationsRemoved={citationsRemoved}
                  hasAnswerSources={hasAnswerSources}
                  hasFeedback={hasFeedback}
                  messageId={messageId}
                  conversationId={conversationId}
                  timestamp={timestamp}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </AnswerCitations>
    </DiagramFilingProvider>
  )
}

/**
 * Memoized so only the streaming answer bubble re-renders as tokens arrive
 * (its `content`/`isStreaming` change); every completed answer above it stays
 * put. React.memo's default shallow prop compare is sufficient here — the
 * props are primitives plus stable store-derived arrays/objects.
 */
export const AgentResponse = memo(AgentResponseComponent)
AgentResponse.displayName = 'AgentResponse'
