/**
 * AgentResponse Component
 *
 * Displays a completed agent response in the chat area: the prose, the cards it
 * placed, the sources it stands on and the footer beneath them. Left-aligned
 * with distinct styling from user messages.
 *
 * It is the WHOLE rendering of an answer. A run's report is this same card,
 * drawn under the run's block in the thread that commissioned it (ADR-0062), so
 * there is no other surface an answer can send the reader to and no control here
 * that offers one.
 */

'use client'

import {
  type FC,
  type ReactNode,
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { animate } from 'motion/react'
import {
  AnimatePresence,
  motion,
  motionBase,
  motionInstant,
  motionQuick,
  motionQuickExit,
  useIconSwapTransition,
  useMotionToken,
} from '@/components/motion'
import { HeightArrival, HeightExpand } from '@/components/motion/height-arrival'
import { cn } from '@/lib/utils'
import { Check, ChevronDown, FileText, MessageCircle } from 'lucide-react'
import { Chip } from '@/components/ui/chip'
import { SectionLabel } from '@/components/ui/section-label'
import type { PluggableList } from 'unified'
import { useLocale, useTranslations } from '@/i18n'
import { AnswerCost } from './AnswerCost'
import type { Translator } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { remarkCitationMarkers } from '@/features/layout/lib/citation-markers'
import { remarkFileReferences } from '@/features/layout/lib/file-reference-markers'
import { formatTime } from '@/shared/utils/format-time'
import { formatDurationElapsed } from '@/lib/format'
import { GridCardItem } from '@/features/grid-cards/components/GridCards'
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
import { ANSWER_DEGRADED_REASONS, TRUNCATION_REASONS } from '@/lib/conversations/message-provenance'
import type { MessageStages } from '@/lib/conversations/message-stages'
import type { CardInteractions } from '@/features/grid-cards/card-decision'
import { useChatStore } from '../store'
import { registerShownText, useAnswerRevealStore } from '../stores/answer-reveal-store'
import { useAnswerFileReferences } from '../hooks/use-answer-file-references'
import { usePacedText } from '../hooks/use-paced-text'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  answerDocuments,
  answerSourceAnchorPrefix,
  buildCitationModel,
  proseLength,
  splitAnswerBody,
  type CitedDocument,
} from '../lib/citations'
import { AnswerCitations } from './AnswerCitations'
import { DiagramFilingProvider } from '@/features/diagrams/diagram-filing-context'
import { NestedMarkdownPluginsProvider } from '@/shared/components/MarkdownRenderer/nested-plugins-context'
import { SkillsUsedDisclosure } from '@/features/skills/components/SkillsUsedDisclosure'
import { AnswerSourcesRow } from './AnswerSourcesRow'
import { MemoryNotedChip } from './MemoryNotedChip'
import { turnMemoryItems, type TurnMemoryItem } from '../lib/turn-memory'
import { answerMetaToAnatomy, summaryDuplicatesBody } from '../lib/answer-meta-cards'
import { AnatomyBlock, AnatomyMasthead, mastheadShows } from './AnswerAnatomy'
import { FindingsMatrix } from './FindingsMatrix'
import type { AnswerKind, AnswerMeta } from '@/lib/conversations/message-answer-meta'
import type { Finding, Findings } from '@/lib/conversations/message-findings'
import { ConfidenceChip, type AnswerConfidence } from './ConfidenceChip'
import { AnswerFeedback } from './AnswerFeedback'
import { RetryThoroughButton } from './RetryThoroughButton'
import { AnswerActions } from './AnswerActions'
import { CardSlot, CardSlotLiveProvider } from './CardSlotArrival'
import type { RetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import type { QuoteStamp } from '@/lib/conversations/message-quote-stamps'
import { projectKeysIn } from '@/lib/text/answer-directives'
import { AnswerDataProvider, type AnswerData } from '@/shared/components/MarkdownRenderer/answer-block-context'
import { AnswerProjectStrip } from '@/shared/components/MarkdownRenderer/project-binding'
import { useProjectFacts } from '../hooks/use-project-facts'
import { isNotRegulated, searchedSources } from '../lib/answer-data'

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

/**
 * The prose wrapper's classes: the lede. Nothing for the caret: it is placed
 * inside the block being written (`MarkdownRenderer`'s `caret`), so every
 * block keeps its own display while it streams. Forcing the last block inline
 * to trail the caret behind its last glyph made it ignore its measure, its
 * list indent and its margins until the next block began (stream audit
 * 2026-10, A1).
 */
const proseClass = (lede: string): string | undefined => lede || undefined

/**
 * What separates a written summary from the prose in the one text the pace
 * reveals: a paragraph break, so neither side's markup reaches into the other
 * when the reveal judges a clean cut.
 */
const SUMMARY_GAP = '\n\n'

/** What the copy actions are handed while the answer is still arriving. */
const NO_DOCUMENTS: CitedDocument[] = []

/**
 * The mark on the role tab. A check says the answer is complete, so it is
 * held back while the answer arrives (and after Stop, which leaves it
 * incomplete): a quiet dot stands in its place at the same size, and at the
 * settle the check lands on `iconSwapTransition` (scale on `springSnap`,
 * opacity on a tween), the turn's one small moment of arrival, and simply
 * appears under reduced motion. A restored answer shows its check at once.
 */
const RoleTabMark: FC<{ complete: boolean; arrived: boolean }> = ({ complete, arrived }) => {
  const swap = useIconSwapTransition()
  return (
    <span className="inline-flex size-2.5 items-center justify-center" aria-hidden="true">
      {complete ? (
        <motion.span
          className="inline-flex"
          initial={arrived ? { opacity: 0, scale: 0.6 } : false}
          animate={{ opacity: 1, scale: 1, transition: swap.enter }}
        >
          <Check className="size-2.5" strokeWidth={2.6} />
        </motion.span>
      ) : (
        <span className="size-1 rounded-full bg-current opacity-60" data-testid="role-tab-pending" />
      )}
    </span>
  )
}

/**
 * A lede only makes sense when the answer opens with prose. An answer that
 * opens with a heading, a list, a table, a quote, a fence or a card marker has
 * already chosen a different way in, and enlarging whatever `p` happens to come
 * first would land the emphasis somewhere arbitrary.
 */
const NON_PROSE_OPENER = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|\[\[card:)/

/** Enough of the opening to tell every opener above from prose (`[[card:` is the longest). */
const OPENER_DECIDABLE_CHARS = 8

/**
 * Whether the answer opens with prose, or `null` while too little of it has
 * arrived to say (a lone `#` may yet be a heading).
 */
function opensWithProse(text: string, final: boolean): boolean | null {
  const trimmed = text.trimStart()
  if (!final && trimmed.length < OPENER_DECIDABLE_CHARS && !trimmed.includes('\n')) return null
  const firstLine = trimmed.split('\n', 1)[0]
  return Boolean(firstLine) && !NON_PROSE_OPENER.test(firstLine)
}

export interface AgentResponseProps {
  /** Response content from the agent */
  content: string
  /** Timestamp of the response (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /** How long the answer took, question sent to answer final, in milliseconds. */
  answerDurationMs?: number
  /** Display variant - 'default' has box styling, 'inline' has no box (for use inside containers) */
  variant?: 'default' | 'inline'
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
  /** The report's findings, drawn as the Befundmatrix between the masthead and the prose. */
  findings?: Findings
  /** The previous report's findings on the same subject, for the matrix's change marks. */
  previousFindings?: Findings
  /** Commission a run to clear an open finding; absent when the thread cannot. */
  onCommissionFinding?: (finding: Finding) => Promise<boolean>
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
   * unverifiable, with de-duplicated reasons. Renders a muted note inside the
   * answer details, whose trigger carries a warning dot when it is present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * Retrieved-but-uncited documents for this answer (document key +
   * lane/kind + page, no prose). Renders the collapsed "Gelesen, nicht
   * zitiert" disclosure inside the answer details; absent when everything
   * retrieved was cited.
   */
  readSources?: CitationSource[]
  /**
   * The turn's research was cut off at its budget ceiling: this answer rests on
   * the evidence gathered up to that point rather than on a finished search.
   * Renders one muted line inside the answer details, whose trigger carries a
   * warning dot when it is present — a fact about the EVIDENCE, in the same register
   * as the sources row. Never a badge on the
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
   * role tab when the envelope has no `kind`. Envelope `kind` wins when present:
   * `direct` → Hinweis, `walkthrough` → Antwort, `ruling` (or a legacy
   * no-kind verdict) → Ergebnis. Absent/`'error'` fall back to the "Ergebnis"
   * treatment, so existing callers render exactly as before.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /**
   * Somebody else's turn, drawn for a colleague reading along
   * (`SpectatedTurn`, ADR-0039 §5). No card acts — every interactive card
   * draws without its actions, and none is given the reader's project or the
   * message to record a decision on — and neither feedback nor copy actions
   * are offered over an answer that is about to be replaced by the persisted
   * one, which carries its own. A file the answer names still links.
   */
  readOnly?: boolean
  /**
   * The backend's account of the turn's retrieval rounds. Read here for the
   * „Gesucht in" pane of a `:::not-found`, which lists what the turn searched
   * from this record and never from the model's words.
   */
  retrievalLedger?: RetrievalLedger
  /** The server's check of each quote line (`TurnResult.quote_stamps`), for „Wortlaut belegt [N]". */
  quoteStamps?: QuoteStamp[]
  /**
   * The project profile `:project[key]` binds, when the caller has it (a
   * preview, a spec). Omitted, the open project's profile is fetched once for
   * the thread (`useProjectFacts`).
   */
  projectProfile?: unknown
  /**
   * The reader pressed Stop on this turn (`ChatMessage.stopped`). The answer
   * keeps what was on screen at the press, says „Gestoppt" where the writing
   * ended, and does not claim to be complete: the role tab's check is held
   * back, as for a turn still running.
   */
  stopped?: boolean
  /**
   * The turn failed (`RUN_ERROR`) under this answer (`ChatMessage.failed`).
   * What had been shown stays, frozen as for Stop and dimmed, with the error
   * card the thread puts under it; nothing in the footer becomes operable,
   * because a cut-off fragment is not an answer to copy or rate.
   */
  failed?: boolean
}

/** Role-tab label for the default answer card. Envelope `kind` wins. */
function answerRoleTab(
  kind: AnswerKind | undefined,
  routingDecision: AgentResponseProps['routingDecision'],
  hasVerdict: boolean
): 'note' | 'answer' | 'result' {
  if (kind === 'direct' || kind === 'handoff') return 'note'
  if (kind === 'walkthrough') return 'answer'
  if (kind === 'ruling' || (!kind && hasVerdict)) return 'result'
  if (routingDecision === 'meta') return 'note'
  return 'result'
}

/**
 * The caret at the tail of a still-streaming answer (C6), placed after the
 * last word by the renderer (`streaming-caret.tsx`).
 *
 * It takes no room: a zero-width box at the baseline, the bar and the veil
 * drawn out of it. A caret with a width pushed the last word to the next line
 * when it just fitted, and pulled it back when the caret moved on.
 *
 * Solid while words advance and breathing only while the reveal stands still
 * (`idle`, from `usePacedText`), as an editor's caret does: a caret pulsing
 * under arriving words read as a blink, and the pause is what a breath is
 * for. It fades out while the finish reveals the last words (`fading`), so by
 * the time the answer settles and it is removed there is nothing left to
 * disappear. The fade is on the wrapper and the breath on the bar: two
 * animations of one property on one element fight.
 *
 * `veil`: the newest words come out of a short gradient trailing the caret,
 * drawn in the card's colour, so each word the reveal adds starts faint and
 * darkens as the next ones push it out, like ink settling. Eased stops rather
 * than a straight ramp, so the faint end does not read as an edge. It moves
 * with the caret and animates nothing, so it costs no more than the caret
 * does. A fade per word (a span per word, each with its own entrance) cost a
 * 4x throttled phone 10 fps and 200 ms of main thread a second on a
 * prose-heavy answer (docs/design/streaming-chat-answer.md). Only on the card,
 * whose colour it is drawn in.
 */
const StreamingCaret: FC<{ fading?: boolean; veil?: boolean; idle?: boolean }> = ({
  fading = false,
  veil = false,
  idle = false,
}) => (
  <span
    aria-hidden="true"
    data-testid="streaming-caret"
    data-idle={idle ? 'true' : undefined}
    className={`group/caret relative inline-block h-0 w-0 transition-opacity duration-base ease-out ${fading ? 'opacity-0' : 'opacity-100'}`}
  >
    {veil && (
      // Hidden after markup with a ground of its own (a code span, a citation
      // pill: `data-caret-after`), which the card's colour would paint over,
      // and wherever the reader asked for contrast or the system's colours.
      <span className="pointer-events-none absolute right-0 -bottom-[0.3em] h-[1.4em] w-[2.5em] bg-[linear-gradient(to_right,transparent,color-mix(in_oklab,var(--card)_30%,transparent)_45%,var(--card))] in-data-[caret-after=markup]:hidden contrast-more:hidden forced-colors:hidden" />
    )}
    <span className="bg-foreground/70 absolute -bottom-[0.2em] left-px h-[1.1em] w-[2px] rounded-full group-data-[idle=true]/caret:animate-caret-breathe motion-reduce:animate-none forced-colors:bg-[CanvasText]" />
  </span>
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
    <span className="text-muted-foreground text-xs leading-relaxed" role="note">
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
            className="rounded-xs focus-visible:ring-ring/60 cursor-help text-left focus-visible:outline-none focus-visible:ring-2"
            aria-label={label}
          >
            <span className="text-muted-foreground text-xs leading-relaxed underline decoration-dotted underline-offset-2">
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
    hasSources ? 'answerSources.researchTruncated' : 'answerSources.researchTruncatedWithoutSources'
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
      <span className="text-muted-foreground text-xs leading-relaxed" role="note">
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
        <span key={line} className="text-muted-foreground text-xs leading-relaxed" role="note">
          {line}
        </span>
      ))}
    </div>
  )
}

/**
 * How many read-but-uncited documents the disclosure shows before it stops.
 * A summary, not a dump — the same cap the "Belegt durch" row uses, so the
 * two never disagree about what "a handful" means.
 */
const MAX_READ_SOURCES = 8

/**
 * The label the "Gelesen, nicht zitiert" disclosure shows for one entry — the
 * document's identity and nothing else.
 *
 * The single definition of "renderable" for this disclosure: the section below
 * skips every entry without one (never falling back to `content`, which on a
 * verbose entry is a locator line or a passage), and `hasDetailsContent`
 * counts the same entries — otherwise the details trigger opens onto an empty
 * section.
 */
function readSourceLabel(source: CitationSource): string | undefined {
  return source.fileName ?? source.title ?? source.citationKey
}

/**
 * "Gelesen, nicht zitiert": what the turn read beyond what the answer claims.
 *
 * Muted document chips only — a name plus the page, never a passage and
 * never a claim about what the document says. The label is the document's
 * identity (`fileName ?? title ?? citationKey`) and nothing else: the entries
 * ride a `.passthrough()` schema, so `content` on a verbose entry is a locator
 * line or a passage, and falling back to it would render evidence prose as a
 * chip. An entry without any identity is skipped, never rendered. The entries
 * carry no prose by construction (the backend drops every prose key), and this
 * renders no field that could restate evidence, so an uncited document cannot
 * ground anything here. Renders nothing when everything retrieved was cited.
 *
 * Past eight the list folds behind a disclosure control — the count first,
 * every name on expand — so a wide retrieval still names each document
 * without burying the footer. Dedupe stays backend-side: one row per entry.
 */
const ReadSourcesSection: FC<{ readSources?: CitationSource[] }> = ({ readSources }) => {
  const t = useTranslations('chat')
  const [expanded, setExpanded] = useState(false)
  const named = useMemo(
    () =>
      (readSources ?? []).flatMap((source) => {
        const label = readSourceLabel(source)
        return label === undefined ? [] : [{ source, label }]
      }),
    [readSources]
  )
  if (named.length === 0) return null
  const visible = expanded ? named : named.slice(0, MAX_READ_SOURCES)
  const hidden = named.length - visible.length

  return (
    <div className="flex flex-col gap-1.5" data-testid="read-sources">
      <SectionLabel>{t('answerDetails.readSources.label')}</SectionLabel>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="list"
        aria-label={t('answerDetails.readSources.label')}
      >
        {visible.map(({ source, label }) => (
          <span key={source.id} role="listitem">
            <Chip size="sm" variant="muted" data-testid="read-source-chip">
              <FileText aria-hidden />
              {label}
              {typeof source.page === 'number' && (
                <span className="opacity-80">{t('answerSources.page', { page: source.page })}</span>
              )}
            </Chip>
          </span>
        ))}
        {named.length > MAX_READ_SOURCES && (
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={expanded}
            data-testid="read-sources-more"
            className="rounded-xs text-muted-foreground duration-quick hover:text-foreground focus-visible:ring-ring/60 cursor-pointer text-xs leading-relaxed underline decoration-dotted underline-offset-2 transition-colors ease-out focus-visible:outline-none focus-visible:ring-2"
          >
            {expanded
              ? t('answerDetails.readSources.less')
              : t('answerDetails.readSources.more', { count: hidden })}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * The single disclosure in the answer footer.
 *
 * The footer keeps verdict, body, the "Belegt durch" sources row, the copy
 * actions and the feedback thumbs visible; everything else the turn carries
 * — confidence, the memory note, the skills that shaped the answer, the
 * verification notes and the timestamp — lives behind ONE muted text-xs
 * trigger line. When the turn carries something the reader must not miss —
 * a cut-off, a salvaged run, stripped citations, low confidence — the trigger
 * carries a warning dot, because a warning behind an unmarked trigger is a
 * warning nobody read. It does not open itself: the warnings land at the
 * settle, and the disclosure opening then moved the footer under a reader
 * who had just reached the end. `SkillsUsedDisclosure` is MOVED here, not duplicated: it
 * renders null on a turn that activated nothing, like every other item
 * inside. Feedback stays out on purpose: rating the answer must not cost a
 * click first.
 */
const AnswerDetails = memo(function AnswerDetails({
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
  readSources,
  hasAnswerSources,
  timestamp,
  answerDurationMs,
  conversationId,
  messageId,
  before,
  after,
}: {
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
  readSources?: CitationSource[]
  hasAnswerSources: boolean
  timestamp?: Date | string
  answerDurationMs?: number
  /** Both needed for the answer's cost line; without either it is omitted. */
  conversationId?: string | null
  messageId?: string
  /** Set on the trigger's own line: the footer's copy actions before it, feedback after. */
  before?: ReactNode
  after?: ReactNode
}) {
  const t = useTranslations('chat')
  // Without the locale `formatTime` uses the RUNTIME default, so a German user on
  // an en-US browser got "03:35 PM" beside cards that all say "15:35".
  const { locale } = useLocale()
  const [open, setOpen] = useState(false)
  // Something the reader must not miss: a cut-off, a salvaged run, stripped
  // citations, low confidence. These arrive with the terminal frame, after the
  // answer settled, and used to OPEN the disclosure from an effect: 100-400px
  // snapping in under a reader who had just reached the end. Now the trigger
  // carries a warning dot instead, positioned over the gap beside it so it
  // takes no width and moves nothing, and fading in only when it arrives in
  // front of the reader. The details open when the reader asks.
  const needsAttention = Boolean(
    researchTruncated ||
    degradedReasons?.length ||
    citationsRemoved?.count ||
    answerConfidence === 'low'
  )
  const [attentionAtMount] = useState(needsAttention)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col">
      {/* One line: copy, the trigger, and feedback at the far end. The
          Collapsible is full-width so its content can open below; with the
          trigger alone inside it, it took a line of its own under the rest. */}
      <div className="flex min-h-6 flex-wrap items-center gap-2">
        {before}
        <CollapsibleTrigger
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 touch-target duration-quick flex items-center gap-1.5 self-start rounded-md text-xs leading-relaxed transition-colors ease-out focus-visible:outline-none focus-visible:ring-2"
          aria-label={t(needsAttention ? 'answerDetails.triggerAriaAttention' : 'answerDetails.triggerAria')}
          data-testid="answer-details-trigger"
        >
          <span>{t('answerDetails.trigger')}</span>
          <span className="relative inline-flex">
            <ChevronDown
              className={`duration-quick size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none${open ? ' rotate-180' : ''}`}
              aria-hidden="true"
            />
            {needsAttention && (
              <span
                aria-hidden="true"
                data-testid="answer-details-attention"
                className={cn(
                  'text-feedback-warning absolute -right-2 top-0 size-1.5 rounded-full bg-current',
                  !attentionAtMount && 'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none'
                )}
              />
            )}
          </span>
        </CollapsibleTrigger>
        {after ? (
          <>
            <span className="flex-1" aria-hidden="true" />
            {after}
          </>
        ) : null}
      </div>
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
          <ReadSourcesSection readSources={readSources} />
          {(Boolean(timestamp) || Boolean(answerDurationMs)) && (
            <span className="text-subtle text-xs" data-testid="answer-time">
              {timestamp && formatTime(timestamp, locale)}
              {timestamp && answerDurationMs ? ' · ' : null}
              {answerDurationMs
                ? t('answerDetails.duration', {
                    duration: formatDurationElapsed(answerDurationMs / 1000, locale),
                  })
                : null}
            </span>
          )}
          {conversationId && messageId ? <AnswerCost conversationId={conversationId} messageId={messageId} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

/**
 * Agent response bubble component for completed responses
 */
const AgentResponseComponent: FC<AgentResponseProps> = ({
  content,
  timestamp,
  answerDurationMs,
  variant = 'default',
  cards,
  citations,
  conversationId,
  cardInteractions,
  stages,
  answerMeta,
  findings,
  previousFindings,
  onCommissionFinding,
  answerConfidence,
  answerConfidenceCappedReason,
  answerConfidenceReason,
  citationsRemoved,
  readSources,
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
  readOnly = false,
  retrievalLedger,
  quoteStamps,
  projectProfile,
  stopped = false,
  failed = false,
}) => {
  const t = useTranslations('chat')
  const storeProjectId = useChatStore((s) => s.projectId)
  // A read-only answer is not the reader's: nothing in it may act on the
  // project the READER has open (ADR-0039 §5), and no card in it may record a
  // decision on the message (`useCardDecision` can decide whenever it has a
  // message id). Reading stays: a named file still links.
  const projectId = readOnly ? null : storeProjectId
  const cardMessageId = readOnly ? undefined : messageId
  // What the answer's blocks read from the record rather than the prose: the
  // project's values, where the turn searched, the server's quote checks.
  // „ergänzen" and „Als Aufgabe" only fill the composer, and not in somebody
  // else's turn (readOnly).
  const projectFacts = useProjectFacts(storeProjectId, projectProfile)
  const setComposerPrefill = useChatStore((s) => s.setComposerPrefill)
  const answerData = useMemo(
    (): AnswerData => ({
      project: projectFacts ?? undefined,
      prefill: readOnly ? undefined : setComposerPrefill,
      searched: searchedSources(retrievalLedger),
      quoteStamps,
      notRegulated: isNotRegulated(answerMeta),
    }),
    [projectFacts, readOnly, setComposerPrefill, retrievalLedger, quoteStamps, answerMeta]
  )
  // An answer that ends in a written "## Quellen" list used to state its sources
  // TWICE — that list AND the "Belegt durch" chips, each holding half the truth
  // (numbers/titles/pages vs. provenance color, authority and click-through).
  // Lift the list out of the body and hand its entries to AnswerSourcesRow,
  // which renders the one consolidated block; the inline [N] markers left in the
  // prose become links to its rows. Answers without such a section are untouched.
  const fallbackId = useId()
  const roleTabId = `${fallbackId}-role`
  const anchorPrefix = answerSourceAnchorPrefix(messageId ?? fallbackId)
  // The prose streams while the model writes it (ADR-0066), in bursts. It is
  // shown at a steady pace a beat behind what has arrived (`usePacedText`,
  // rules in `../lib/stream-pace.ts`), so it reads as being written rather
  // than lurching forward a sentence at a time. When the turn ends, the text
  // it held back is finished in a few hundred ms, and only then does the
  // answer settle. Everything that belongs to a WHOLE answer (the caret going,
  // the footer, citations turning real) follows `live`, not `isStreaming`, so
  // it all lands in the one frame the text is complete. The unplaced cards
  // may land earlier (`unplacedIsFinal`): a live frame carries cards only once
  // the prose is complete, so they wait only for the reveal to catch up.
  // Only the prose is paced: a written „## Quellen" section is lifted into the
  // source rows, never drawn as text, and pacing it held the settle back by
  // half a second after the last visible word. It joins the text once the
  // prose is all shown.
  const prose = useMemo(() => content.slice(0, proseLength(content)), [content])
  // Whether the reader is watching this answer arrive. Every entrance below is
  // gated on it: an answer restored on thread open, switch or reload is drawn
  // as it stands, with nothing arriving.
  const [mountedLive] = useState(isStreaming)
  // Whether prose has been on screen in this view (set below, once it is).
  const [wroteBefore, setWroteBefore] = useState(false)
  const anatomy = useMemo(() => answerMetaToAnatomy(answerMeta), [answerMeta])
  // A summary that restates the body's opening is the same statement twice,
  // so the masthead drops it (see `summaryDuplicatesBody`); the rules are
  // where `keptSummary` is written, below.
  const summary = anatomy?.summary
  const [keptSummary, setKeptSummary] = useState<string>()
  const summaryDuplicates = useMemo(
    () => Boolean(summary) && summaryDuplicatesBody(summary, prose),
    [summary, prose]
  )
  const effectiveSummary =
    summary && (summary === keptSummary || !summaryDuplicates) ? summary : undefined
  // The summary standfirst is WRITTEN, not faded in, when it leads an answer
  // the reader is watching begin: it arrives whole in the masthead event, and
  // a two-to-five-line paragraph appearing in one frame read as the answer's
  // first words popping in finished while the sentence under it was being
  // written (recording 2026-10). It is paced as the head of the prose, so one
  // reveal writes it and then the body, with one caret, in reading order.
  // Decided once, at the first summary: one that arrives after prose is on
  // screen fades in whole as before, since writing it in above text the
  // reader is on would move that text line by line.
  const [summaryWritten, setSummaryWritten] = useState<boolean | null>(null)
  if (summaryWritten === null && effectiveSummary) setSummaryWritten(mountedLive && isStreaming && !wroteBefore)
  const lead = summaryWritten && effectiveSummary ? `${effectiveSummary}${SUMMARY_GAP}` : ''
  // A failed turn freezes like a stopped one: what was shown is what stays.
  const paced = usePacedText(lead + prose, isStreaming, undefined, stopped || failed, messageId, lead.length)
  // The reveal split back into its two places: the summary's share for the
  // masthead, the rest for the body.
  const pacedProse = paced.text.slice(lead.length)
  const shownSummary = lead ? paced.text.slice(0, effectiveSummary?.length) : effectiveSummary
  const writingSummary = Boolean(lead) && !paced.settled && paced.text.length < lead.length
  // Ended under the reader before it was finished: by Stop, or by a failure.
  // Nothing the stream had not put on screen by then arrives afterwards (the
  // takeaways, the unplaced cards, the „Ohne Quellenbeleg" row): what the
  // reader saw is what is kept. An answer restored later is drawn whole.
  const cutShort = (stopped || failed) && mountedLive
  const settled = paced.settled
  const shownContent = pacedProse.length >= prose.length ? content : pacedProse
  const live = !settled
  // What is on screen, for Stop to keep (`stopStreaming`): the text that had
  // arrived runs up to two seconds ahead of it.
  const shownContentRef = useRef(shownContent)
  useLayoutEffect(() => {
    if (!messageId || !live) return
    return registerShownText(messageId, () => shownContentRef.current)
  }, [messageId, live])

  // A retraction (`answer_retracted`): a tool round's preamble streamed, was
  // withdrawn, and the real answer follows. The content empties mid-stream,
  // and the card used to return nothing for it: it vanished in one frame, and
  // the next round's first word drew it again with a second entrance. Now the
  // frame stays. The words fade out (`motionQuickExit`), the body holds its
  // height with one quiet line in it („Antwort wird erstellt …"), and the
  // next round's first word, or the settle, releases the height on a glide.
  // Only for an answer the reader watched write something.
  // The answer's structured anatomy, rendered FLAT (`AnswerAnatomy.tsx`) as
  // answer typography: the verdict as the masthead above the prose, the
  // takeaways closing it, the callout beside the paragraph its `[[callout]]`
  // marker anchors it to — or after the prose when unanchored.
  // A streaming answer whose masthead arrived before its first word is not
  // empty: the masthead stands while the prose is still being written.
  const hasLiveMasthead =
    live && Boolean(anatomy && (anatomy.verdict || anatomy.summary || anatomy.topic))
  const blank =
    (!content || !content.trim() || content === 'null') && (cards?.length ?? 0) === 0 && !hasLiveMasthead
  if (mountedLive && live && !wroteBefore && shownContent.trim()) setWroteBefore(true)
  // Until the next round's first word is on screen, not merely arrived: the
  // pace shows it a frame or more later, and letting go at the arrival
  // dropped the held height for that gap.
  const retracted =
    mountedLive && isStreaming && wroteBefore && (blank || (!shownContent.trim() && !hasLiveMasthead))
  // The words the retraction took, held on screen while they fade. Written
  // after every commit that showed words, read in the commit that lost them.
  const lastWords = useRef('')
  useLayoutEffect(() => {
    shownContentRef.current = shownContent
    if (shownContent.trim()) lastWords.current = shownContent
  })
  const [retractionFaded, setRetractionFaded] = useState(false)
  if (!retracted && retractionFaded) setRetractionFaded(false)
  const drawnContent = retracted ? (retractionFaded ? '' : lastWords.current) : shownContent
  // The finish: the stream is over, the rest of the text is being revealed.
  const finishing = live && !isStreaming
  // Outside the answer, the Herleitung's collapse waits for the same moment.
  const beginReveal = useAnswerRevealStore((s) => s.begin)
  const endReveal = useAnswerRevealStore((s) => s.end)
  useLayoutEffect(() => {
    if (!messageId || !live) return
    beginReveal(messageId)
    return () => endReveal(messageId)
  }, [messageId, live, beginReveal, endReveal])
  const {
    body,
    entries: sourceEntries,
    numbers: splitNumbers,
  } = useMemo(() => splitAnswerBody(drawnContent), [drawnContent])
  // The numbers keep one identity while they stay the same: the split makes a
  // new set for every reveal step, and a new set is a new plugin list, which
  // re-parses every block of the answer instead of the one that grew.
  const citationNumbersKey = [...splitNumbers].join(',')
  const citationNumbers = useMemo(
    (): ReadonlySet<number> => new Set(citationNumbersKey ? citationNumbersKey.split(',').map(Number) : []),
    [citationNumbersKey]
  )

  // The markers are linked while the body is PARSED, not before: `[2][3]` — two
  // sources behind one claim, the shape the backend is told to write — is
  // indistinguishable from reference-link syntax in raw text, and used to reach
  // the reader as literal "[2][3]" beside neighbours that got their pill.
  //
  // Cards are placed the same way and for the same reason: the agent writes
  // `[[card:2]]` on a line of its own, and the card is spliced in there rather
  // than stacked above the answer it is supposed to illustrate.
  const cardCount = cards?.length ?? 0
  // A summary that restates the body's opening is the same statement twice,
  // so the masthead drops it (see `summaryDuplicatesBody`). Judged against
  // everything that has ARRIVED (`prose`), not the paced body, and never
  // taken back once shown: judged on the paced body it vanished from above
  // the prose the moment the reveal completed the first sentence, pulling
  // everything the reader was on up by its height. A summary that has been
  // on screen in this view stays for it (`keptSummary`); a duplicate that
  // arrives after the prose has opened is caught before it is ever shown.
  // The lede gate reads the result: a hidden summary hands the emphasis back
  // to the first paragraph instead of leaving the answer with none.
  // Derived state, set during render: the next render (before paint) holds it.
  if (!retracted && effectiveSummary && effectiveSummary !== keptSummary) setKeptSummary(effectiveSummary)
  // The Projektbezug strip: the project facts the answer binds, drawn from the
  // profile under the masthead, only where the answer binds one. Read off what
  // has arrived, so it is there from the first frame its keys exist. It stands
  // ABOVE the prose only when the answer already bound a fact as it mounted (a
  // stored answer, a reload); one that binds its first fact while the reader
  // is reading gets it BELOW the prose instead, where it moves nothing they
  // have read. The next view puts it back on top.
  const stripKeys = useMemo(() => (prose.includes(':project[') ? projectKeysIn(prose) : []), [prose])
  const [stripAbove] = useState(() => prose.includes(':project['))
  // The lede, decided ONCE from what is known at the answer's first words:
  // its kind (a note is never a lede), whether it opens with prose, and
  // whether the masthead already carries a summary or a topic (the
  // standfirst holds that emphasis, and a 17px masthead line over a 17px
  // first paragraph would be the same statement twice). It used to be
  // decided on the paced body behind a 600-character gate, so the first
  // paragraph the reader was on restyled from 16 to 17px mid-stream. There is
  // no length gate any more, because length is the one thing not known at the
  // first word; a settled answer runs the same predicate, so a stored answer
  // looks as it did live. Not eased: font size is a layout property, and the
  // motion vocabulary animates none (`grid/motion-vocabulary`).
  const roleTab = answerRoleTab(answerMeta?.kind, routingDecision, Boolean(answerMeta?.verdict))
  const opener = opensWithProse(prose, !isStreaming)
  const ledeNow = opener === true && roleTab !== 'note' && !effectiveSummary && !anatomy?.topic
  const [frozenLede, setFrozenLede] = useState<boolean | null>(null)
  if (mountedLive && !retracted && frozenLede === null && opener !== null) setFrozenLede(ledeNow)
  // Retracted words decided nothing: once they have faded, the answer that
  // follows decides the lede and the kept summary afresh, from its own first
  // words. Not before: the fading words keep the size they were shown at.
  if (retracted && retractionFaded && (frozenLede !== null || keptSummary !== undefined || summaryWritten !== null)) {
    setFrozenLede(null)
    setSummaryWritten(null)
    setKeptSummary(undefined)
  }
  const ledeClass = (mountedLive ? frozenLede === true : ledeNow) ? LEDE_CLASS : ''
  // The files this answer NAMES, as opposed to the ones it cites. A sentence
  // like „Beginnen Sie mit pd8280-2.pdf" is pointing at a document the reader
  // owns, and until the index below resolved that name it was dead text. The
  // hook is inert for an answer with no filename in it, which is most of them.
  const fileReferences = useAnswerFileReferences({
    body,
    projectId: storeProjectId,
    // The conversation whose private attachments a named file may live in.
    conversationId: conversationId ?? null,
  })
  // A new list re-parses every block of the answer, so it is rebuilt only when
  // what the plugins read changes: a boolean for the callout, not the anatomy.
  const hasCallout = Boolean(anatomy?.callout)
  //
  // `pending: true` on both passes, live or not, so the list does NOT change
  // when the answer settles: a new list re-parses the whole answer, and the
  // settle frame is already the most expensive one the answer has (it starved
  // every animation that ran in it). Whether a marker with nothing behind it
  // yet is pending or nothing is decided where it renders, from
  // `CardSlotLiveProvider`: `CitationMarker` draws a pending pill while live
  // and the plain „[N]" once settled; `CardSlot` holds the place while live
  // and folds it away once settled.
  const markerPlugins = useMemo(
    (): PluggableList => [
      // While it streams, a marker with no source yet is a pending pill, not
      // a stray "[2]": the settled text names its source within seconds.
      [remarkCitationMarkers, { numbers: citationNumbers, anchorPrefix, pending: true }],
      // A card marker holds its card's place until the card, written after
      // the prose, arrives to fill it. Pending, the count is not read.
      [remarkCardMarkers, { count: 0, callout: hasCallout, pending: true }],
      // AFTER the citation pass, so a filename that happens to sit inside a
      // marker's label is left alone: the pass skips `link` subtrees, and by
      // this point every `[N]` already is one.
      [remarkFileReferences, { fileNames: fileReferences.fileNames }],
    ],
    [citationNumbers, anchorPrefix, hasCallout, fileReferences.fileNames]
  )
  // What a run of Markdown INSIDE a card (a tab's `Text`) parses with: the
  // citations only. Its `[2]` is this answer's source 2; card markers are not
  // slots there.
  const nestedPlugins = useMemo(
    (): PluggableList => [[remarkCitationMarkers, { numbers: citationNumbers, anchorPrefix }]],
    [citationNumbers, anchorPrefix]
  )
  // The cards the prose did NOT claim. Read off the same body the renderer
  // parses, because the block below has to be built before that parse happens.
  const fallbackCardIndices = useMemo(() => unplacedCardIndices(body, cardCount), [body, cardCount])
  // Whether "unplaced" is final, so the cards no marker claimed may be drawn.
  // A live frame carries cards only once the envelope's `answer` string has
  // closed (the backend reads them after it, ADR-0066), so a streaming answer
  // that holds cards has all of its prose; once the pace has shown all of it,
  // no marker is still to come. Waiting for the terminal instead held every
  // unplaced card back until verification and the pipeline were done: 22 s
  // after the card was written on the recorded `oib2` turn.
  const unplacedIsFinal = !live || ((cards?.length ?? 0) > 0 && shownContent === content)
  // Whether the unplaced cards were drawn while the answer was live: an answer
  // cut short keeps them only then (`cutShort`).
  const [unplacedDrawnLive, setUnplacedDrawnLive] = useState(false)
  if (live && unplacedIsFinal && !unplacedDrawnLive) setUnplacedDrawnLive(true)
  const drawUnplaced = unplacedIsFinal && (!cutShort || unplacedDrawnLive)
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
  // Citation chips ("Belegt durch") always wear their lane tints: lane tint
  // is provenance (where it stands), not decoration — washes/alarms spend the
  // hue budget elsewhere, never by muting the source signal. Grey chips read
  // as broken, so there is no muted variant and no spend counting here.
  // What a `[[card:N]]` marker in the prose draws. A card the answer has not
  // reached yet (N past the end of `cards`) holds a place while the answer
  // streams, since the cards are written after the prose, and nothing once it
  // is done (`CardSlot` reads which from `CardSlotLiveProvider`, so this
  // renderer keeps its identity when the answer settles and no card re-renders
  // for it). A hole INSIDE `cards` (a card the validator refused, or one an
  // observer may not see) is never coming, so it draws nothing at any time:
  // a hole is better than a crash, a raw `[[card:2]]` or a skeleton forever.
  const arrivalPrefix = messageId ?? fallbackId
  const renderCardSlot = useCallback(
    (index: number) => {
      // The callout's slot: the one anatomy block the prose may anchor.
      if (index === CALLOUT_SLOT_INDEX) {
        if (!anatomy?.callout) return null
        return (
          <div className="mb-3">
            <AnatomyBlock card={anatomy.callout} />
          </div>
        )
      }
      const card = cards?.[index]
      const arrivalKey = `${arrivalPrefix}:${index}`
      // Still arriving: the card is written after the prose, so its marker
      // holds the place it will arrive into rather than nothing (ADR-0066).
      // A hole is a card that will never come: a place it held folds away.
      if (!card) return <CardSlot arrivalKey={arrivalKey} refused={index < (cards?.length ?? 0)} />
      return (
        <CardSlot arrivalKey={arrivalKey}>
          <GridCardItem
            card={card}
            index={index}
            projectId={projectId}
            messageId={cardMessageId}
            decisionsMustPersist={readOnly}
          />
        </CardSlot>
      )
    },
    [cards, projectId, cardMessageId, anatomy?.callout, arrivalPrefix, readOnly]
  )
  // ONE derivation for the whole answer: the inline `[N]` markers in the prose
  // and the provenance chips below are the same citations seen twice, and two
  // derivations of one citation is exactly the defect the model removes.
  const documents = useMemo(
    () => buildCitationModel({ citations, entries: sourceEntries }),
    [citations, sourceEntries]
  )
  // The SAME predicate the sources row uses to decide between chips and the
  // "Ohne Quellenbeleg" gap row — so the truncation line never promises
  // "the evidence gathered up to that point" beside a row saying there is none.
  const hasAnswerSources = useMemo(() => answerDocuments(documents).length > 0, [documents])

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

  // What the merged footer's meta row would actually hold. The flags alone are
  // not the answer: `showConfidenceChip` is on by default but the chip renders
  // nothing without a level, and the feedback row needs a `messageId` — gating
  // the row on the flags let it mount as an empty band (bare spacer + its own
  // gap) on a meta turn that has neither.
  const hasConfidence =
    showConfidenceChip &&
    (answerConfidence === 'low' || answerConfidence === 'medium' || answerConfidence === 'high')
  // Rating somebody else's answer is not the reader's to do (readOnly).
  const hasFeedback = !readOnly && showAnswerFeedback && Boolean(messageId)
  // The copy actions. A still-arriving answer cannot be copied — half a
  // Prüfvermerk is worse than none — and a cards-only turn has no markdown to
  // hand over, so it gets no button that copies ''. While the answer arrives
  // the actions are THERE but invisible and inert (`pending`): inserted at the
  // settle, they widened the row, and on a phone wrapped it onto a second
  // line, under a reader who had just finished the last sentence.
  const hasAnswerActions =
    !readOnly &&
    (live || (Boolean(content) && content.trim().length > 0 && content !== 'null'))
  const hasMetaRow =
    hasConfidence || hasFeedback || hasAnswerActions || Boolean(timestamp) || memoryItems.length > 0
  // The row is reserved at chip height while the answer arrives, so the
  // footer does not jump when what it holds becomes operable. An idle answer
  // with nothing to hold still omits the row (no empty band).
  const reserveMetaRow = hasMetaRow || live
  // What the single footer disclosure would actually hold. The copy actions
  // and the feedback stay visible beside its trigger, so a bare answer shows
  // the action and no empty trigger line. Read sources count only when at
  // least one entry is renderable (same `readSourceLabel` filter as the
  // section itself): unrenderable entries alone must not mount a trigger
  // that opens onto an empty section.
  const hasRenderableReadSources = (readSources ?? []).some(
    (source) => readSourceLabel(source) !== undefined
  )
  const hasDetailsContent =
    hasConfidence ||
    Boolean(timestamp) ||
    Boolean(answerDurationMs) ||
    memoryItems.length > 0 ||
    (skillsActivated?.length ?? 0) > 0 ||
    Boolean(researchTruncated) ||
    (degradedReasons?.length ?? 0) > 0 ||
    (citationsRemoved?.count ?? 0) > 0 ||
    hasRenderableReadSources

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

  // Memoised elements: the footer's `AnswerDetails` is memoised, and a new
  // element on every reveal tick re-rendered it and the feedback buttons with
  // it, about 3 ms of each 16 ms tick on a 4× throttled phone (React
  // performance audit, 2026-09).
  //
  // While live the actions hold their width with nothing to copy: their shape
  // does not depend on the text (one copy button either way, the export by
  // ids), and feeding them every reveal step re-rendered them per word.
  // A failed answer keeps them so too: a cut-off fragment is not an answer to
  // copy or rate, and the reserved row stays as it was.
  const inert = live || failed
  const actionsContent = inert ? '' : content
  const actionsBody = inert ? '' : body
  const actionsDocuments = inert ? NO_DOCUMENTS : documents
  const answerActions = useMemo(
    () =>
      hasAnswerActions ? (
        <AnswerActions
          content={actionsContent}
          body={actionsBody}
          documents={actionsDocuments}
          conversationId={conversationId}
          messageId={messageId}
          pending={inert}
        />
      ) : null,
    [hasAnswerActions, actionsContent, actionsBody, actionsDocuments, conversationId, messageId, inert]
  )
  const feedback = useMemo(
    () =>
      hasFeedback && messageId ? (
        <>
          {!inert && <RetryThoroughButton messageId={messageId} conversationId={conversationId} />}
          <AnswerFeedback compact pending={inert} messageId={messageId} conversationId={conversationId} />
        </>
      ) : null,
    [hasFeedback, messageId, conversationId, inert]
  )

  // A terminal that does not continue what is shown (a settled snapshot that
  // rewrites or shortens the text) replaces the body in one frame; tables and
  // diagrams the reader was looking at vanished with no transition at all.
  // The new body fades in instead, on the same element: nothing remounts, so
  // the Markdown tree is not rebuilt for it.
  //
  // The body's frame does not drop to the new height in that frame either:
  // the verified text is often much shorter (the recorded `oib2` terminal is
  // 541 characters against 1,724 streamed), and everything under the body,
  // the footer and the next turn, jumped up by the difference. The frame
  // keeps its old height as a minimum and lets go of it on a glide
  // (`glideFrameDown`), as it does after a retraction.
  const proseRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const heightRelease = useMotionToken(motionBase)
  // The frame's height before a change: a `ResizeObserver` reports after
  // layout effects, so in the commit that changes the body it still holds the
  // height the reader saw.
  const frameHeight = useRef<number | null>(null)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!mountedLive || !frame || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!frame.style.minHeight) frameHeight.current = frame.offsetHeight
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [mountedLive])
  // The footer's room while the answer arrives. Reserved (invisible) so the
  // settle does not push what lies under the card, but only once the body
  // reaches below the viewport: reserved from the first frame, it drew the
  // card's first words over a 116px empty band of shell (phone recording,
  // 2026-10), the card tall and empty before the prose had filled it. Below
  // the viewport the room is never seen. An answer that ends shorter than
  // the viewport has the footer open at the settle instead, below the last
  // line, where nothing the reader is on moves. One-way: once reserved, kept.
  const [footerReserved, setFooterReserved] = useState(!mountedLive)
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (footerReserved || !live || !frame || typeof ResizeObserver === 'undefined') return
    const check = () => {
      if (frame.getBoundingClientRect().bottom > window.innerHeight) setFooterReserved(true)
    }
    check()
    const observer = new ResizeObserver(check)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [footerReserved, live])
  // The release eases the held MINIMUM down rather than the height: words
  // that keep arriving grow the body while it runs, and a tweened height
  // would clip them and land short of where they had got to.
  const glideFrameDown = useCallback(
    (frame: HTMLElement, from: number): (() => void) | undefined => {
      frame.style.minHeight = ''
      const to = frame.offsetHeight
      const done = () => {
        frame.style.minHeight = ''
        frameHeight.current = frame.offsetHeight
      }
      if (to >= from - 1 || heightRelease === motionInstant) {
        done()
        return undefined
      }
      // Held before the first animation frame, so no frame paints the drop.
      frame.style.minHeight = `${from}px`
      const controls = animate(frame, { minHeight: [`${from}px`, `${to}px`] }, heightRelease)
      void controls.then(done)
      return () => {
        controls.stop()
        frame.style.minHeight = ''
      }
    },
    [heightRelease]
  )
  const previousBody = useRef(body)
  const bodyFade = useMotionToken(motionBase)
  useLayoutEffect(() => {
    const previous = previousBody.current.trimEnd()
    previousBody.current = body
    // Not for a body that went blank: that is a retraction, faded below.
    if (!mountedLive || !previous || !body || body.startsWith(previous) || !proseRef.current) return
    const controls = animate(proseRef.current, { opacity: [0, 1] }, bodyFade)
    const frame = frameRef.current
    const stopGlide = frame && frameHeight.current !== null ? glideFrameDown(frame, frameHeight.current) : undefined
    return () => {
      controls.stop()
      stopGlide?.()
    }
  }, [body, mountedLive, bodyFade, glideFrameDown])

  // The retraction, on the elements that are already there (nothing remounts).
  // The words fade out on the exit curve, then give way to the quiet line;
  // the body's frame holds the height it had, so nothing below moves while
  // the answer has nothing to say, and lets go on a glide when it does.
  const retractionFade = useMotionToken(motionQuickExit)
  useLayoutEffect(() => {
    const frame = frameRef.current
    const prose = proseRef.current
    if (!retracted || !frame || !prose) return
    if (frameHeight.current !== null) frame.style.minHeight = `${frameHeight.current}px`
    if (retractionFaded) return
    const controls = animate(prose, { opacity: [1, 0] }, retractionFade)
    // Timed by the token rather than the animation's promise: a page that
    // gets no frames (hidden) must still reach the quiet line.
    const timer = window.setTimeout(() => setRetractionFaded(true), (retractionFade.duration ?? 0) * 1000)
    return () => {
      window.clearTimeout(timer)
      controls.stop()
      prose.style.opacity = ''
    }
  }, [retracted, retractionFaded, retractionFade])
  // The next round's first word, or the settle, lets go of the held height.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (retracted || !frame || !frame.style.minHeight) return
    return glideFrameDown(frame, frame.offsetHeight)
  }, [retracted, glideFrameDown])

  // The masthead. Part of the answer's own entrance when it mounts with it
  // (no second fade inside one); fading in alone when it arrives later; and,
  // gated out by a snapshot or the terminal, fading out BEFORE its height goes,
  // in one frame once it is invisible, rather than vanishing from above the
  // prose. Its confidence is the verdict's own, from the masthead event: the
  // turn's self-assessment arrives with the terminal and inserted a gauge row
  // and a reason paragraph above the prose the reader was on. That one lives
  // in the answer details.
  const mastheadExitToken = useMotionToken(motionQuickExit)
  const mastheadEnter = useMotionToken(motionQuick)
  const showMasthead =
    anatomy !== null &&
    mastheadShows({
      verdict: anatomy.verdict,
      summary: shownSummary,
      topic: anatomy.topic,
      kind: answerMeta?.kind,
    })
  const masthead = (
    <AnimatePresence initial={false}>
      {showMasthead && anatomy && (
        // eslint-disable-next-line grid/motion-vocabulary -- the fold after the fade: height goes in one frame (duration 0) once the masthead is invisible
        <motion.div
          key="masthead"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            height: 0,
            transition: {
              opacity: mastheadExitToken,
              height: { duration: 0, delay: mastheadExitToken.duration ?? 0 },
            },
          }}
          transition={mastheadEnter}
        >
          <AnatomyMasthead
            verdict={anatomy.verdict}
            summary={shownSummary}
            topic={anatomy.topic}
            context={anatomy.context}
            kind={answerMeta?.kind}
            caret={writingSummary && <StreamingCaret idle={paced.idle} veil={variant !== 'inline'} />}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )

  // What arrives BELOW the prose: a Projektbezug strip that turned up after the
  // answer began, the takeaways and unplaced callout, the cards no marker
  // claimed. Each takes its height smoothly (`HeightArrival`) instead of
  // shoving the footer down by all of it in one frame, and only when the
  // reader watches it arrive: `initial={false}` stands a stored answer's
  // blocks at once.
  //
  // The unplaced cards are withheld until "unplaced" is final
  // (`unplacedIsFinal`): it is read off the body SO FAR, and a card whose
  // `[[card:N]]` has not been shown yet would render here and then jump up the
  // answer. They arrive like a placed card (`CardSlot`: placeholder, then the
  // drawn card fading in over it), so a card looks the same arriving whether
  // or not the prose placed it. `mt-1` because the column's `gap-2` is 8px and
  // the markdown body's paragraph rhythm is 12px, so without it an UNPLACED
  // card hugged the prose 4px tighter than a placed one
  // (/dev/chat-turn?variant=two-cards).
  const lateBlocks = (
    <AnimatePresence initial={false}>
      {!stripAbove && stripKeys.length > 0 && (
        <HeightArrival key="project-strip">
          <AnswerProjectStrip keys={stripKeys} />
        </HeightArrival>
      )}
      {!live && !cutShort && anatomyBelow.length > 0 && (
        <HeightArrival key="anatomy-below" className="mt-1 gap-3">
          {anatomyBelow.map((card) => (
            <AnatomyBlock key={card.type} card={card} />
          ))}
        </HeightArrival>
      )}
      {drawUnplaced && cards && fallbackCardIndices.length > 0 && (
        <HeightArrival key="unplaced-cards" className="mt-1 [&>:last-child]:mb-0">
          {fallbackCardIndices.map((index) => {
            const card = cards[index]
            if (!card) return null
            return (
              <CardSlot key={index} arrivalKey={`${arrivalPrefix}:${index}`} arriving={mountedLive}>
                <GridCardItem
                  card={card}
                  index={index}
                  projectId={projectId}
                  messageId={cardMessageId}
                  decisionsMustPersist={readOnly}
                />
              </CardSlot>
            )
          })}
        </HeightArrival>
      )}
    </AnimatePresence>
  )

  // A failed answer dims to what it is, a fragment, on a transition rather
  // than in one frame; the error card under it says why.
  const dimmed = cn(
    'transition-opacity duration-base ease-out motion-reduce:transition-none',
    failed && 'opacity-60'
  )

  // Where the writing ended when the reader pressed Stop: one quiet word under
  // the last one shown, fading in on the press.
  const stoppedMarker =
    stopped && !live ? (
      <p
        className={cn(
          'text-muted-foreground text-xs',
          mountedLive && 'animate-in fade-in-0 duration-quick ease-out motion-reduce:animate-none'
        )}
        data-testid="answer-stopped"
      >
        {t('answerStoppedMarker')}
      </p>
    ) : null

  // Guard against null, undefined, empty, or literal "null" string content
  // when no cards are present. Cards can render even with empty text. A
  // retracted answer keeps its frame (above).
  if (blank && !retracted) return null

  // While a retracted answer has nothing to show, one quiet line says the
  // answer is still coming, in the room the withdrawn words held.
  const retractionLine =
    retracted && retractionFaded ? (
      <motion.p
        className="text-muted-foreground text-sm"
        data-testid="answer-retracting"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={mastheadEnter}
      >
        {t('thinking.working')}
      </motion.p>
    ) : null

  // Inline variant - no box styling (for use inside containers like thinking process)
  if (variant === 'inline') {
    return (
      <AnswerDataProvider value={answerData}>
    <DiagramFilingProvider target={diagramFilingTarget}>
        <NestedMarkdownPluginsProvider plugins={nestedPlugins}>
          <AnswerCitations
            documents={documents}
            anchorPrefix={anchorPrefix}
            resolveFileReference={fileReferences.resolve}
          >
            <div
              ref={frameRef}
              className={cn(
                'flex w-full flex-col gap-2 overflow-hidden break-words',
                dimmed
              )}
              aria-busy={live || undefined}
              data-testid={failed ? 'answer-failed' : undefined}
              lang="de"
            >
              {/* The answer's masthead — verdict/topic and/or summary, flat above the prose. */}
              {masthead}
              {stripAbove && <AnswerProjectStrip keys={stripKeys} />}
              {findings && (
                <FindingsMatrix
                  findings={findings}
                  anchorPrefix={anchorPrefix}
                  previous={previousFindings}
                  onCommission={onCommissionFinding}
                />
              )}
              {/* Response Content rendered as markdown, the streaming caret after
            its last word. Cards the answer placed with a marker are spliced
            into this body. */}
              {retractionLine}
              <CardSlotLiveProvider value={live}>
                <MarkdownSlotProvider render={renderCardSlot}>
                  <div ref={proseRef} className={proseClass(ledeClass)}>
                    <MarkdownRenderer
                      content={body}
                      isStreaming={live}
                      remarkPlugins={markerPlugins}
                      caret={live && !retracted && !writingSummary && <StreamingCaret fading={finishing} idle={paced.idle} />}
                    />
                  </div>
                </MarkdownSlotProvider>
              </CardSlotLiveProvider>

              {stoppedMarker}
              {/* What arrives below the prose: never before it, since an answer
            that opens with three diagrams has pushed itself below the fold. */}
              {lateBlocks}

              {/* "Belegt durch": provenance chips for sources this answer carries */}
              <AnswerSourcesRow
                documents={documents}
                anchorPrefix={anchorPrefix}
                routingDecision={routingDecision}
                isStreaming={live || cutShort}
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
                  className={hasMetaRow ? 'flex min-h-6 flex-col gap-1.5' : 'min-h-6'}
                  aria-hidden={hasMetaRow ? undefined : true}
                >
                  {hasDetailsContent && (
                    <AnswerDetails
                      conversationId={conversationId}
                      messageId={messageId}
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
                      readSources={readSources}
                      hasAnswerSources={hasAnswerSources}
                      timestamp={timestamp}
                      answerDurationMs={answerDurationMs}
                    />
                  )}
                  {hasFeedback && messageId && (
                    <AnswerFeedback pending={inert} messageId={messageId} conversationId={conversationId} />
                  )}
                </div>
              )}
            </div>
          </AnswerCitations>
        </NestedMarkdownPluginsProvider>
      </DiagramFilingProvider>
    </AnswerDataProvider>
    )
  }

  // Default variant — the click-dummy "Ergebnis" card: a role tab over a
  // tinted shell whose white inner block carries the composed answer, then a
  // "Belegt durch" provenance row and the feedback row, hairline-separated.
  //
  // Envelope `kind` names the document. `direct` swaps the ink tab for a quiet
  // "Hinweis"; observed `meta` does the same when kind is absent and there is
  // no legacy verdict. `walkthrough` keeps the ink shell but labels the tab
  // "Antwort". `ruling`, a legacy no-kind verdict, and any other routing
  // (shallow/deep/error) keep "Ergebnis" (fail-open).
  const isNote = roleTab === 'note'
  const tabLabel =
    roleTab === 'note'
      ? t('roles.note')
      : roleTab === 'answer'
        ? t('roles.answer')
        : t('roles.result')
  return (
    <AnswerDataProvider value={answerData}>
    <DiagramFilingProvider target={diagramFilingTarget}>
      <NestedMarkdownPluginsProvider plugins={nestedPlugins}>
        <AnswerCitations
          documents={documents}
          anchorPrefix={anchorPrefix}
          resolveFileReference={fileReferences.resolve}
        >
          {/* Full column width, not a fixed 680px: the answer is the thread's main
        content and reads as a centered column (the width itself is set by the
        list's max-w container), rather than a card hugging the left edge with
        dead space beside it. */}
          {/* No entrance of its own: the thread row owns it, gated on whether
            the answer is arriving or being restored (a CSS entrance here
            replayed on every thread open, switch and reload). */}
          {/* An article named by its role tab, busy while it arrives, in the
            answer's language (German) whatever the UI locale: hyphenation
            and a screen reader's voice follow `lang`. */}
          <article
            className="flex w-full flex-col"
            aria-labelledby={roleTabId}
            aria-busy={live || undefined}
            data-testid={failed ? 'answer-failed' : undefined}
            lang="de"
          >
            {/* Role tab — uppercase 10.5/600. Substantive answer: near-black action
          fill + check. Meta / direct reply: quiet secondary fill + conversation icon. */}
            {isNote ? (
              <SectionLabel
                as="div"
                id={roleTabId}
                className="bg-secondary text-secondary-foreground ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md px-2.5 py-1"
              >
                <MessageCircle className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
                {tabLabel}
              </SectionLabel>
            ) : (
              <SectionLabel
                as="div"
                id={roleTabId}
                className="bg-primary text-primary-foreground ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-md px-2.5 py-1"
              >
                <RoleTabMark complete={!live && !stopped && !failed} arrived={mountedLive} />
                {tabLabel}
              </SectionLabel>
            )}

            {/* Shell: subtle surface + hairline + soft shadow, corners clipped. A meta
          reply sits on a quieter muted surface, so the whole card — not just the
          tab — reads as the calmer, non-result kind. Both kinds use shadow-sm,
          matching the composer's elevation so the answer never outranks it. */}
            <div
              className={
                isNote
                  ? 'border-input bg-muted relative overflow-hidden rounded-lg border shadow-sm'
                  : 'border-input bg-input-background relative overflow-hidden rounded-lg border shadow-sm'
              }
            >
              {/* Answer body — the hero white surface. It fills the top of the card
            flush (corners clipped by the shell) and is separated from the
            provenance footer by a single hairline, so the whole thing reads as
            one considered object with sections — not a card floating in a tray. */}
              <div
                ref={frameRef}
                className={cn(
                  'bg-card flex flex-col gap-2 break-words px-[22px] pb-[17px] pt-[18px]',
                  dimmed
                )}
              >
                {/* The answer's masthead — verdict/topic and/or summary, flat above the prose. */}
                {masthead}
                {stripAbove && <AnswerProjectStrip keys={stripKeys} />}
                {findings && (
                  <FindingsMatrix
                    findings={findings}
                    anchorPrefix={anchorPrefix}
                    previous={previousFindings}
                    onCommission={onCommissionFinding}
                  />
                )}
                {/* Response Content rendered as markdown, the streaming caret after
              its last word. Cards the answer placed with a marker are spliced
              into this body. */}
                {retractionLine}
                <CardSlotLiveProvider value={live}>
                  <MarkdownSlotProvider render={renderCardSlot}>
                    <div ref={proseRef} className={proseClass(ledeClass)}>
                      <MarkdownRenderer
                        content={body}
                        isStreaming={live}
                        remarkPlugins={markerPlugins}
                        caret={live && !retracted && !writingSummary && <StreamingCaret fading={finishing} idle={paced.idle} veil />}
                      />
                    </div>
                  </MarkdownSlotProvider>
                </CardSlotLiveProvider>

                {stoppedMarker}
                {/* What arrives below the prose: never before it, since an answer
              that opens with three diagrams has pushed itself below the fold. */}
                {lateBlocks}
              </div>

              {/* Provenance footer — ONE tinted zone under the body's hairline that
            holds the sources block, the copy actions, and a single disclosure
            for everything else (confidence, memory note, skills used,
            verification notes, feedback, timestamp). The sources row must not
            draw its own divider here (the body hairline already separates), so
            it takes withDivider={false}. */}
              {/* Hidden while the answer arrives and faded in at the settle.
                Shown, it moved down a line with every line the prose grew
                while it was in view: most of the turn's layout shift (0.18 of
                the 0.20 on the desktop harness). Hidden content does not
                shift, and nothing in it was operable before the settle anyway
                (the actions and feedback are `pending`). Its room is kept
                only below the viewport (`footerReserved`); otherwise it opens
                at the settle. The body's hairline is the footer's top border,
                so a closed footer leaves no second line along the shell's
                own bottom edge. */}
              <HeightExpand open={!live || footerReserved} instant={live}>
                <div
                  className={cn(
                    'duration-base flex flex-col gap-2.5 border-t px-[22px] pb-[14px] pt-3 transition-opacity ease-out motion-reduce:transition-none',
                    live && mountedLive && 'invisible opacity-0'
                  )}
                  data-testid="answer-footer"
                >
                  <AnswerSourcesRow
                    documents={documents}
                    anchorPrefix={anchorPrefix}
                    routingDecision={routingDecision}
                    isStreaming={live || cutShort}
                    withDivider={false}
                  />
                  {reserveMetaRow && (
                    <div
                      className={hasMetaRow ? 'flex min-h-6 flex-wrap items-center gap-2' : 'min-h-6'}
                      aria-hidden={hasMetaRow ? undefined : true}
                    >
                      {/* Copy the answer out — markdown, with or without its sources
                    written out. Before the disclosure: "take this with you" is
                    what the reader wants first; the details are the afterthought.
                    `compact` feedback: the thumbs stay on this line and their
                    disclosure takes the next one full-width. */}
                      {hasDetailsContent ? (
                        <AnswerDetails
                          conversationId={conversationId}
                          messageId={messageId}
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
                          readSources={readSources}
                          hasAnswerSources={hasAnswerSources}
                          timestamp={timestamp}
                          answerDurationMs={answerDurationMs}
                          before={answerActions}
                          after={feedback}
                        />
                      ) : (
                        <>
                          {answerActions}
                          {hasMetaRow && <span className="flex-1" aria-hidden="true" />}
                          {feedback}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </HeightExpand>
              {/* The elevation again, OVER the content: in dark mode it carries
                an inset top highlight, and the full-bleed body painted over the
                shell's own. Its outer shadow is clipped here; the shell's stands. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-sm"
              />
            </div>
          </article>
        </AnswerCitations>
      </NestedMarkdownPluginsProvider>
    </DiagramFilingProvider>
    </AnswerDataProvider>
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
