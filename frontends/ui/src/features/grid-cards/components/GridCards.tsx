import { type FC, useCallback, useId } from 'react'
import type { GridCard } from '@/shared/cards/schemas'
import { cardKey } from '../card-decision'
import { ProjectProfilePatchCard } from './ProjectProfilePatchCard'
import { MemoryProposalCard } from './MemoryProposalCard'
import { FileOperationProposalCard } from './FileOperationProposalCard'
import { CalculationCard } from './CalculationCard'
import { BuildingSectionCard } from '../schematics/BuildingSectionCard'
import { StairDiagramCard } from '../schematics/StairDiagramCard'
import { DimensionDiagramCard } from '../schematics/DimensionDiagramCard'
import { SetbackPlanCard } from '../schematics/SetbackPlanCard'
import { EgressDiagramCard } from '../schematics/EgressDiagramCard'
import { DaylightIncidenceCard } from '../schematics/DaylightIncidenceCard'
import { GuardrailCheckCard } from '../schematics/GuardrailCheckCard'
import { FireAccessPlanCard } from '../schematics/FireAccessPlanCard'
import { DocumentGridCard } from './DocumentGridCard'
import { DocumentDraftCard } from './DocumentDraftCard'
import { TaskCreatedCard } from './TaskCreatedCard'
import { IfcViewerCard } from './IfcViewerCard'
import { IfcModelPickerCard } from './IfcModelPickerCard'
import { cardHighlightSpecs } from '@/features/bim/lib/card-highlights'
import {
  IfcComplianceCard,
  IfcDiffCard,
  IfcElementCard,
  IfcScheduleCard,
} from './IfcDataCards'
import type { SurfacedDocument } from '@/features/documents/hooks/use-surfaced-documents'
import { FadeIn } from '@/components/motion'
import { A2uiCard } from '@/features/a2ui/A2uiCard'

interface GridCardsProps {
  /**
   * Parsed grid cards to render, in wire order. `undefined` holes are cards
   * `validateGridCards` rejected: they hold their index so `[[card:N]]`
   * markers and persisted `cardKey` decisions after them stay bound, and they
   * render nothing.
   */
  cards: (GridCard | undefined)[]
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
  /**
   * Whether an interactive card here MUST be able to persist its decision.
   *
   * Default (false): with no `messageId` the card still takes an answer and
   * remembers it for this mount only. That suits the `/dev/cards` gallery and
   * previews, where nothing could be persisted and nothing is at stake.
   *
   * A surface that renders REAL cards passes true, and then an interactive card
   * with no owning message draws itself without its actions rather than taking
   * an answer it will drop. The deep-research report tab is that surface: its
   * cards come from a job output, and the message that carries them
   * (`card-owner.ts`) is not always loaded.
   */
  decisionsMustPersist?: boolean
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
  /** See {@link GridCardsProps.decisionsMustPersist}. */
  decisionsMustPersist?: boolean
}

interface GridCardViewProps extends GridCardItemProps {
  /**
   * The card's id inside a composed `surface`, absent for a lone card. A second
   * guard only: every card that stores a decision under its `cardKey` is in
   * `SURFACE_EXCLUDED_LEAVES` and never sits in a surface. Should one ever be
   * allowed there, its leaves (which share the surface's `index`) still get
   * distinct keys.
   */
  leafId?: string
}

/**
 * One card, drawn directly: the per-type dispatch.
 *
 * This is what A2UI's catalog calls for each card component (ADR-0065;
 * `GridCardItem` below hands it to `A2uiCard`), and what a card falls back to
 * when A2UI will not draw it. Callers draw cards with `GridCardItem`. A
 * `surface` never reaches it: the catalog has no `surface` component and the
 * fallback never hands one down (`SURFACE_EXCLUDED_LEAVES`).
 */
export const GridCardView: FC<GridCardViewProps> = ({
  card,
  index,
  projectId,
  messageId,
  decisionsMustPersist,
  leafId,
}) => {
  // The identity an interactive card's persisted decision is stored under.
  const key = leafId === undefined ? cardKey(card, index) : `${cardKey(card, index)}.${leafId}`

  if (card.type === 'calculation') {
    return (
      <FadeIn distance={6}>
        <CalculationCard
          title={card.title}
          steps={card.steps ?? []}
          limit={card.limit}
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
          parcel_area_m2={card.parcel_area_m2}
          footprint_area_m2={card.footprint_area_m2}
          gross_floor_area_m2={card.gross_floor_area_m2}
          coverage={card.coverage}
          density={card.density}
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
          decisionsMustPersist={decisionsMustPersist}
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

  if (card.type === 'document_draft') {
    return (
      <FadeIn distance={6}>
        <DocumentDraftCard
          title={card.title}
          path={card.path}
          bytes={card.bytes}
          version={card.version}
          documentId={card.document_id}
          versionId={card.version_id}
          versionState={card.version_state}
          messageId={messageId}
          cardKey={key}
          decisionsMustPersist={decisionsMustPersist}
        />
      </FadeIn>
    )
  }

  if (card.type === 'task_created') {
    return (
      <FadeIn distance={6}>
        <TaskCreatedCard
          taskId={card.task_id}
          kind={card.kind}
          title={card.title}
          goal={card.goal}
          dueAt={card.due_at}
          conversationId={card.conversation_id}
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

  if (card.type === 'ifc_model_picker') {
    return (
      <FadeIn distance={6}>
        <IfcModelPickerCard
          title={card.title}
          note={card.note ?? null}
          projectId={projectId ?? null}
        />
      </FadeIn>
    )
  }

  if (card.type === 'file_operation_proposal') {
    return (
      <FadeIn distance={6}>
        <FileOperationProposalCard
          title={card.title}
          operation={card.operation}
          operations={card.operations}
          note={card.note}
          messageId={messageId}
          cardKey={key}
          decisionsMustPersist={decisionsMustPersist}
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
          decisionsMustPersist={decisionsMustPersist}
        />
      </FadeIn>
    )
  }

  return null
}

/**
 * One card slot, drawn through A2UI (ADR-0065).
 *
 * A lone card or a composed `surface`: `A2uiCard` turns it into an A2UI
 * surface on the Piloti catalog and draws it, and every card component in that
 * catalog comes back here, to `GridCardView`, for the pixels. Props and
 * identity are unchanged, so every caller keeps working and every stored
 * message renders through the same path.
 *
 * Split out of the stack so a card can also be drawn ALONE, wherever the answer
 * placed it — `GridCards` is then just the vertical stack of the leftovers.
 * `index` is passed rather than inferred for exactly that reason: an inline
 * card has no position in a list to be inferred from, and its identity must
 * still be the one the persisted decisions were keyed under.
 */
export const GridCardItem: FC<GridCardItemProps> = ({ card, index, projectId, messageId, decisionsMustPersist }) => {
  // The surface id must be unique within the page; an answer without a
  // message id (a preview, a streaming draft) takes one from React instead.
  const fallbackId = useId()
  // One renderer while its inputs hold: it is the value of A2UI's renderer
  // context, and a new one re-renders every card component in the surface.
  const isSurface = card.type === 'surface'
  const render = useCallback(
    (leaf: GridCard, leafId: string) => (
      <GridCardView
        card={leaf}
        index={index}
        projectId={projectId}
        messageId={messageId}
        decisionsMustPersist={decisionsMustPersist}
        leafId={isSurface ? leafId : undefined}
      />
    ),
    [index, projectId, messageId, decisionsMustPersist, isSurface]
  )
  return <A2uiCard card={card} surfaceKey={`${messageId ?? fallbackId}:${index}`} render={render} />
}

/**
 * Renders a list of Grid cards in a vertical stack. A card is an action or
 * commitment, a to-scale schematic, a calculation, a live model binding or a
 * `surface` (ADR-0069); everything else is the answer's Markdown.
 */
export const GridCards: FC<GridCardsProps> = ({
  cards,
  projectId,
  messageId,
  indices,
  decisionsMustPersist,
}) => {
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
            decisionsMustPersist={decisionsMustPersist}
          />
        )
      })}
    </div>
  )
}
