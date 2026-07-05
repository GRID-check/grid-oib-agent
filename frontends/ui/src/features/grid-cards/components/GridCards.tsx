import { type FC } from 'react'
import type { GridCard } from '@/shared/cards/schemas'
import { SummaryCard } from './SummaryCard'
import { LegalBasisCard } from './LegalBasisCard'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import { BuildingSectionCard } from '../schematics/BuildingSectionCard'
import { StairDiagramCard } from '../schematics/StairDiagramCard'
import { DimensionDiagramCard } from '../schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '../schematics/SetbackPlanCard'
import { EgressDiagramCard } from '../schematics/EgressDiagramCard'
import { FadeIn } from '@/components/motion'

interface GridCardsProps {
  /** Parsed grid cards to render. */
  cards: GridCard[]
  /** Optional project ID for patch card API calls. */
  projectId?: string | null
}

/**
 * Renders a list of Grid cards in a vertical stack: summary / legal_basis /
 * project_profile_patch plus the five schematic cards (building_section,
 * stair_diagram, dimension_diagram, setback_plan, egress_diagram).
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

        if (card.type === 'building_section') {
          return (
            <FadeIn key={key} distance={6}>
              <BuildingSectionCard
                title={card.title}
                storeys={card.storeys ?? []}
                markers={card.markers}
                reference={card.reference}
                note={card.note}
              />
            </FadeIn>
          )
        }

        if (card.type === 'stair_diagram') {
          return (
            <FadeIn key={key} distance={6}>
              <StairDiagramCard
                title={card.title}
                riser_count={card.riser_count}
                riser_height={card.riser_height}
                tread_depth={card.tread_depth}
                width={card.width}
                comfort_note={card.comfort_note}
                reference={card.reference}
              />
            </FadeIn>
          )
        }

        if (card.type === 'dimension_diagram') {
          return (
            <FadeIn key={key} distance={6}>
              <DimensionDiagramCard
                title={card.title}
                shape={card.shape}
                dimensions={card.dimensions ?? []}
                reference={card.reference}
                note={card.note}
              />
            </FadeIn>
          )
        }

        if (card.type === 'setback_plan') {
          return (
            <FadeIn key={key} distance={6}>
              <SetbackPlanCard
                title={card.title}
                parcel_width_m={card.parcel_width_m}
                parcel_depth_m={card.parcel_depth_m}
                building_width_m={card.building_width_m}
                building_depth_m={card.building_depth_m}
                sides={card.sides ?? []}
                reference={card.reference}
              />
            </FadeIn>
          )
        }

        if (card.type === 'egress_diagram') {
          return (
            <FadeIn key={key} distance={6}>
              <EgressDiagramCard
                title={card.title}
                segments={card.segments ?? []}
                total_length={card.total_length}
                start_label={card.start_label}
                exit_label={card.exit_label}
                reference={card.reference}
              />
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
