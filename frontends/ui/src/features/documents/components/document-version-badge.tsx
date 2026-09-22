'use client'

/**
 * The editorial state of a document, as one quiet word.
 *
 * ## Why it is neutral, and why it is not in the assignment row
 *
 * **Neutral chroma.** The only chroma in this product is the provenance signal
 * system (`docs/design/grid-design-language.md`: colour belongs to provenance,
 * and never travels without its icon and label). An editorial state is not
 * provenance — it says whether the office has asserted the content — so it gets
 * ink and paper, and the word does the work. Amber for „In Prüfung" would put
 * the warning role on a state that is the normal middle of every review, which
 * is the collision `ProposalShell` already paid for once (charter §0.4).
 *
 * **Beside the assignment row, never inside it.** ADR-0047's addendum, restated
 * by ADR-0054: `Zuweisen` is responsibility, the byline is provenance, and the
 * lifecycle is a fifth relation about the CONTENT. A file can be Anna's and not
 * yet freigegeben; a file can be freigegeben and „Unvergeben". Rendering this
 * chip among the assignment faces would make „verantwortlich" and „freigegeben"
 * one word, which is the mistake those two ADRs exist to prevent.
 *
 * When it appears at all is {@link showsVersionStateBadge} — the badge is off on
 * a plain upload, on purpose.
 */

import { Badge } from '@/components/ui/badge'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  documentBadgeState,
  type DocumentBadgeState,
  type DocumentVersionBadgeSubject,
} from '../lib/document-lifecycle'

/**
 * Two registers, both neutral: what is happening now, and what is history.
 *
 * `secondary` is the filled quiet chip; `outline` is the same word with no
 * ground under it, for the states that are over — a superseded version and an
 * archived item are things a reader is looking BACK at. Exhaustive over the
 * state union, so a new state does not compile until somebody has decided which
 * register it reads in.
 */
const BADGE_VARIANT: Record<DocumentBadgeState, 'secondary' | 'outline'> = {
  draft: 'secondary',
  in_review: 'secondary',
  changes_requested: 'secondary',
  approved: 'secondary',
  published: 'secondary',
  rejected: 'outline',
  superseded: 'outline',
  archived: 'outline',
}

/** The i18n leaf per state. A map, so `tsc` fails on a state with no wording. */
const LABEL_KEY: Record<DocumentBadgeState, string> = {
  draft: 'lifecycle.states.draft',
  in_review: 'lifecycle.states.inReview',
  changes_requested: 'lifecycle.states.changesRequested',
  approved: 'lifecycle.states.approved',
  published: 'lifecycle.states.published',
  rejected: 'lifecycle.states.rejected',
  superseded: 'lifecycle.states.superseded',
  archived: 'lifecycle.states.archived',
}

export function documentVersionStateLabel(state: DocumentBadgeState, t: Translator): string {
  return t(LABEL_KEY[state])
}

export interface DocumentVersionStateBadgeProps extends DocumentVersionBadgeSubject {
  className?: string
  /** Render even where the badge rule would stay silent — the state IS the subject. */
  always?: boolean
  /**
   * Test hook. Distinct on the pane's header badge, because a version list
   * renders one of these per row and „the document's state" and „this row's
   * state" are two different questions to ask the DOM.
   */
  testId?: string
}

/**
 * Renders nothing when the rule says nothing, which is most files.
 *
 * `always` exists for the two surfaces whose subject is the state itself: the
 * version list, where every row is a state, and the dev gallery. It skips the
 * "is this worth saying" rule, never the wording.
 */
export function DocumentVersionStateBadge({
  className,
  always = false,
  testId = 'document-version-badge',
  ...subject
}: DocumentVersionStateBadgeProps): JSX.Element | null {
  const t = useTranslations('files')
  const state = always
    ? (subject.lifecycle === 'archived' ? 'archived' : (subject.versionState ?? null))
    : documentBadgeState(subject)
  if (!state) return null

  return (
    <Badge
      variant={BADGE_VARIANT[state]}
      className={cn('shrink-0 font-medium', className)}
      data-testid={testId}
      data-state={state}
      title={t('lifecycle.badgeTitle', { state: documentVersionStateLabel(state, t) })}
    >
      {documentVersionStateLabel(state, t)}
    </Badge>
  )
}
