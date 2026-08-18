import { type FC } from 'react'
import type { GridCard } from '@/shared/cards/schemas'
import { cardKey } from '../card-decision'
import { SummaryCard } from './SummaryCard'
import { LegalBasisCard } from './LegalBasisCard'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import { MemoryProposalCard } from './MemoryProposalCard'
import { RequirementChecklistCard } from './RequirementChecklistCard'
import { ComparisonTableCard } from './ComparisonTableCard'
import { BuildingSectionCard } from '../schematics/BuildingSectionCard'
import { StairDiagramCard } from '../schematics/StairDiagramCard'
import { DimensionDiagramCard } from '../schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '../schematics/SetbackPlanCard'
import { EgressDiagramCard } from '../schematics/EgressDiagramCard'
import { DaylightIncidenceCard } from '../schematics/DaylightIncidenceCard'
import { GuardrailCheckCard } from '../schematics/GuardrailCheckCard'
import { DensityCheckCard } from '../schematics/DensityCheckCard'
import { FireAccessPlanCard } from '../schematics/FireAccessPlanCard'
import { AcousticCheckCard } from '../schematics/AcousticCheckCard'
import { FireCompartmentCard } from '../schematics/FireCompartmentCard'
import { ThermalEnvelopeCard } from '../schematics/ThermalEnvelopeCard'
import { EnergyPerformanceCard } from '../schematics/EnergyPerformanceCard'
import { ElevatorRequirementCard } from '../schematics/ElevatorRequirementCard'
import { ParkingRequirementCard } from '../schematics/ParkingRequirementCard'
import { DocumentGridCard } from './DocumentGridCard'
import { IfcViewerCard } from './IfcViewerCard'
import { cardHighlightSpecs } from '@/features/bim/lib/card-highlights'
import {
  IfcComplianceCard,
  IfcDiffCard,
  IfcElementCard,
  IfcScheduleCard,
} from './IfcDataCards'
import type { SurfacedDocument } from '@/features/documents/hooks/use-surfaced-documents'
import { FadeIn } from '@/components/motion'

interface GridCardsProps {
  /** Parsed grid cards to render. */
  cards: GridCard[]
  /** Optional project ID for patch card API calls. */
  projectId?: string | null
  /**
   * The message these cards belong to. Interactive cards key their persisted
   * decision on it (`features/grid-cards/card-decision.ts`); without it they
   * still render and act, but the outcome doesn't survive a reload.
   */
  messageId?: string
  /**
   * Which of `cards` to draw, by index. Defaults to all of them.
   *
   * The chat passes a SUBSET here: a card the answer placed inline with a
   * `[[card:N]]` marker is already drawn in the prose, and only the rest fall
   * back to this block. The array must stay whole and the indices original —
   * `cardKey` is positional, so renumbering a filtered list would rename every
   * persisted decision and re-open cards the user has already answered.
   */
  indices?: readonly number[]
}

interface GridCardItemProps {
  /** The card to draw. */
  card: GridCard
  /** Its index in the message's `cards` array — its identity (see `cardKey`). */
  index: number
  /** Optional project ID for patch card API calls. */
  projectId?: string | null
  /** The message these cards belong to (see {@link GridCardsProps.messageId}). */
  messageId?: string
}

/**
 * One card, dispatched on its type.
 *
 * Split out of the stack so a card can also be drawn ALONE, wherever the answer
 * placed it — `GridCards` is then just the vertical stack of the leftovers.
 * `index` is passed rather than inferred for exactly that reason: an inline
 * card has no position in a list to be inferred from, and its identity must
 * still be the one the persisted decisions were keyed under.
 */
export const GridCardItem: FC<GridCardItemProps> = ({ card, index, projectId, messageId }) => {
  // Doubles as the React key and as the identity an interactive card's
  // persisted decision is stored under, so the two cannot drift apart.
  const key = cardKey(card, index)

  if (card.type === 'summary') {
    return (
      <FadeIn distance={6}>
        <SummaryCard {...card} />
      </FadeIn>
    )
  }

  if (card.type === 'legal_basis') {
    return (
      <FadeIn distance={6}>
        <LegalBasisCard {...card} />
      </FadeIn>
    )
  }

  if (card.type === 'requirement_checklist') {
    return (
      <FadeIn distance={6}>
        <RequirementChecklistCard
          title={card.title}
          items={card.items ?? []}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'comparison_table') {
    return (
      <FadeIn distance={6}>
        <ComparisonTableCard
          title={card.title}
          options={card.options ?? []}
          rows={card.rows ?? []}
          recommendation={card.recommendation}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'building_section') {
    return (
      <FadeIn distance={6}>
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
      <FadeIn distance={6}>
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
      <FadeIn distance={6}>
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
      <FadeIn distance={6}>
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
      <FadeIn distance={6}>
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

  if (card.type === 'daylight_incidence') {
    return (
      <FadeIn distance={6}>
        <DaylightIncidenceCard
          title={card.title}
          room_floor_area_m2={card.room_floor_area_m2}
          glass_area={card.glass_area}
          window_sill_height_m={card.window_sill_height_m}
          window_head_height_m={card.window_head_height_m}
          obstruction={card.obstruction}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'guardrail_check') {
    return (
      <FadeIn distance={6}>
        <GuardrailCheckCard
          title={card.title}
          context={card.context}
          fall_height={card.fall_height}
          rail_height={card.rail_height}
          max_opening={card.max_opening}
          bottom_gap={card.bottom_gap}
          has_horizontal_elements_in_climb_zone={card.has_horizontal_elements_in_climb_zone}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'density_check') {
    return (
      <FadeIn distance={6}>
        <DensityCheckCard
          title={card.title}
          parcel_area_m2={card.parcel_area_m2}
          footprint_area_m2={card.footprint_area_m2}
          gross_floor_area_m2={card.gross_floor_area_m2}
          coverage={card.coverage}
          density={card.density}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'fire_access_plan') {
    return (
      <FadeIn distance={6}>
        <FireAccessPlanCard
          title={card.title}
          parcel_width_m={card.parcel_width_m}
          parcel_depth_m={card.parcel_depth_m}
          building_width_m={card.building_width_m}
          building_depth_m={card.building_depth_m}
          route_width={card.route_width}
          gate_clearance_height={card.gate_clearance_height}
          aufstellflaeche={card.aufstellflaeche}
          walk_distance_to_entrance={card.walk_distance_to_entrance}
          gebaeudeklasse={card.gebaeudeklasse}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'acoustic_check') {
    return (
      <FadeIn distance={6}>
        <AcousticCheckCard
          title={card.title}
          checks={card.checks ?? []}
          sound_class={card.sound_class}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'fire_compartment') {
    return (
      <FadeIn distance={6}>
        <FireCompartmentCard
          title={card.title}
          storey_label={card.storey_label}
          compartments={card.compartments ?? []}
          gebaeudeklasse={card.gebaeudeklasse}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'thermal_envelope') {
    return (
      <FadeIn distance={6}>
        <ThermalEnvelopeCard
          title={card.title}
          components={card.components ?? []}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'energy_performance') {
    return (
      <FadeIn distance={6}>
        <EnergyPerformanceCard
          title={card.title}
          hwb={card.hwb}
          energy_class={card.energy_class}
          fgee={card.fgee}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'elevator_requirement') {
    return (
      <FadeIn distance={6}>
        <ElevatorRequirementCard
          title={card.title}
          storeys_served={card.storeys_served}
          entrance_level_index={card.entrance_level_index}
          is_required={card.is_required}
          requirement_note={card.requirement_note}
          cabin_width={card.cabin_width}
          cabin_depth={card.cabin_depth}
          door_width={card.door_width}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'parking_requirement') {
    return (
      <FadeIn distance={6}>
        <ParkingRequirementCard
          title={card.title}
          car_spaces={card.car_spaces}
          bicycle_spaces={card.bicycle_spaces}
          basis={card.basis}
          reference={card.reference}
          note={card.note}
        />
      </FadeIn>
    )
  }

  if (card.type === 'project_profile_patch') {
    return (
      <FadeIn distance={6}>
        <ProjectProfilePatchCard
          title={card.title || ''}
          rationale={card.rationale || ''}
          patch={card.patch || []}
          projectId={projectId}
          messageId={messageId}
          cardKey={key}
        />
      </FadeIn>
    )
  }

  if (card.type === 'document_grid') {
    return (
      <FadeIn distance={6}>
        <DocumentGridCard
          title={card.title}
          query={card.query}
          documents={(card.documents ?? []) as SurfacedDocument[]}
          projectId={projectId}
        />
      </FadeIn>
    )
  }

  if (card.type === 'ifc_viewer') {
    return (
      <FadeIn distance={6}>
        <IfcViewerCard
          title={card.title}
          modelFile={card.model_file ?? null}
          storey={card.storey ?? null}
          note={card.note ?? null}
          // Typed in `card-highlights.ts`, not here: the generated zod
          // renders a nested `$ref` as `z.any()`, so every field read off
          // a highlight would otherwise be unchecked.
          highlights={cardHighlightSpecs(card.highlights ?? [])}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'ifc_schedule') {
    return (
      <FadeIn distance={6}>
        <IfcScheduleCard
          title={card.title}
          modelFile={card.model_file ?? null}
          storey={card.storey ?? null}
          note={card.note ?? null}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'ifc_element') {
    return (
      <FadeIn distance={6}>
        <IfcElementCard
          title={card.title}
          globalId={card.global_id}
          modelFile={card.model_file ?? null}
          note={card.note ?? null}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'ifc_diff') {
    return (
      <FadeIn distance={6}>
        <IfcDiffCard
          title={card.title}
          baseModelFile={card.base_model_file}
          modelFile={card.model_file ?? null}
          note={card.note ?? null}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'ifc_compliance') {
    return (
      <FadeIn distance={6}>
        <IfcComplianceCard
          title={card.title}
          modelFile={card.model_file ?? null}
          ruleIds={card.rule_ids ?? []}
          note={card.note ?? null}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'memory_proposal') {
    return (
      <FadeIn distance={6}>
        <MemoryProposalCard
          title={card.title}
          content={card.content}
          kind={card.kind}
          confidence={card.confidence}
          messageId={messageId}
          cardKey={key}
        />
      </FadeIn>
    )
  }

  return null
}

/**
 * Renders a list of Grid cards in a vertical stack: the structured cards
 * (summary, legal_basis, project_profile_patch, requirement_checklist,
 * comparison_table) plus the fifteen schematic cards (building_section,
 * stair_diagram, dimension_diagram, setback_plan, egress_diagram,
 * daylight_incidence, guardrail_check, density_check, fire_access_plan,
 * acoustic_check, fire_compartment, thermal_envelope, energy_performance,
 * elevator_requirement, parking_requirement).
 */
export const GridCards: FC<GridCardsProps> = ({ cards, projectId, messageId, indices }) => {
  // A subset renders under its ORIGINAL indices, never renumbered — see
  // `GridCardsProps.indices`.
  const positions = indices ?? cards.map((_, index) => index)
  if (positions.length === 0) {
    return null
  }

  return (
    <div className="flex w-full flex-col gap-3">
      {positions.map((index) => {
        const card = cards[index]
        if (!card) return null
        return (
          <GridCardItem
            key={cardKey(card, index)}
            card={card}
            index={index}
            projectId={projectId}
            messageId={messageId}
          />
        )
      })}
    </div>
  )
}
