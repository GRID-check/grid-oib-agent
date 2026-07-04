import { type FC } from 'react'
import type { GridCard } from '@/shared/cards/schemas'
import { SummaryCard } from './SummaryCard'
import { LegalBasisCard } from './LegalBasisCard'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import { FadeIn } from '@/components/motion'

interface GridCardsProps {
  /** Parsed grid cards to render. */
  cards: GridCard[]
  /** Optional project ID for patch card API calls. */
  projectId?: string | null
}

/**
 * Renders a list of Grid cards (summary / legal_basis / project_profile_patch) in a vertical stack.
 */
export const GridCards: FC<GridCardsProps> = ({ cards, projectId }) => {
  if (cards.length === 0) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {cards.map((card, index) => {
        const key = `${card.type}-${index}`

        if (card.type === 'summary') {
          return (
            <FadeIn key={key} distance={6}>
              <SummaryCard {...card} />
            </FadeIn>
          )
        }

        if (card.type === 'legal_basis') {
          return (
            <FadeIn key={key} distance={6}>
              <LegalBasisCard {...card} />
            </FadeIn>
          )
        }

        if (card.type === 'project_profile_patch') {
          return (
            <FadeIn key={key} distance={6}>
              <ProjectProfilePatchCard
                title={card.title || ''}
                rationale={card.rationale || ''}
                preview={card.preview || []}
                patch={card.patch || []}
                projectId={projectId}
              />
            </FadeIn>
          )
        }

        return null
      })}
    </div>
  )
}
