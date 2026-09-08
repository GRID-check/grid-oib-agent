'use client'

/**
 * The Büro's empty canvas (WS-5, `workspace-chat-ui.md` §4).
 *
 * Sits under the hero greeting on an empty workspace thread and answers the one
 * question a reader arriving at `/app/chat` has: what is this place for, given
 * that it looks exactly like the project chat they know. The description names
 * what Piloti reads here, and three example prompts — one per outcome kind
 * (Baurecht, register, comparison) — say it again in the form the reader will
 * actually type.
 *
 * They PREFILL and do not send. A canned prompt that fires immediately is a
 * question the reader did not ask, and the comparison example is deliberately
 * incomplete ("… von …") because it cannot be finished before a project is in
 * view — which is the phase-3 mounting control, not something this state fakes.
 */

import { type FC } from 'react'
import { Building2 } from 'lucide-react'

import { Chip } from '@/components/ui/chip'
import { EmptyState } from '@/components/ui/empty-state'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'

/** The three outcome kinds, in the order the design lists them. */
const EXAMPLE_KEYS = ['law', 'register', 'compare'] as const

export interface WorkspaceEmptyStateProps {
  /**
   * Put this text in the composer. Never sends it — the reader finishes the
   * question and presses send themselves.
   */
  onPrompt: (text: string) => void
}

export const WorkspaceEmptyState: FC<WorkspaceEmptyStateProps> = ({ onPrompt }) => {
  const t = useTranslations('chat')
  // The empty canvas is the one place the composer is lifted into the middle of
  // the column, so everything above it shares half a phone screen with a hero
  // greeting. The disc is the only decorative element here and the first thing
  // to give: the building glyph still stands in the scope chip below, which is
  // where it carries meaning rather than weight.
  const isMobile = useIsMobile()

  return (
    <EmptyState
      variant="bare"
      icon={isMobile ? undefined : Building2}
      title={t('workspace.empty.title')}
      description={t('workspace.empty.description')}
      data-testid="workspace-empty-state"
      // The bare variant's own `py-10` is padding this block cannot afford: it
      // sits between a hero greeting and a composer that has been lifted into
      // the middle of the column, and on a phone that space is the whole
      // budget. The greeting above supplies the air.
      className="py-0"
      action={
        // Wraps rather than scrolls: three questions of very different lengths,
        // and on a phone the third one alone fills the row.
        <div className="flex flex-wrap items-center justify-center gap-2">
          {EXAMPLE_KEYS.map((key) => {
            const prompt = t(`workspace.empty.examples.${key}`)
            return (
              <Chip
                key={key}
                asChild
                variant="outline"
                size="md"
                interactive
                className="max-w-full"
              >
                <button type="button" onClick={() => onPrompt(prompt)}>
                  <span className="min-w-0 truncate">{prompt}</span>
                </button>
              </Chip>
            )
          })}
        </div>
      }
    />
  )
}

export default WorkspaceEmptyState
