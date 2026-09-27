'use client'

/**
 * Where a card will be drawn, before it has been: the card's own frame with
 * shimmer bars where its content will sit.
 *
 * It wears the framed register (`Card` + `CARD_SHELL`: the radius, the
 * invisible border and the muted ground every framed card has), so the step
 * from placeholder to card is a change of content inside a frame that stays
 * where it is, not one box swapped for another. It stands for the card in two
 * places: a streamed card's arrival (`CardSlotArrival.tsx`), and the moment
 * between A2UI mounting a surface and drawing it (`A2uiCard`).
 *
 * Its height comes from {@link CARD_PLACEHOLDER_HEIGHTS}: a card is held at
 * the size it usually is, so what is left when the card lands is a small
 * correction rather than a 96 px box growing to 400.
 */

import type { FC } from 'react'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { GridCard } from '@/shared/cards/schemas'
import { CARD_SHELL } from './card-chrome'

/** The placeholder's height when the card's type is not known yet, or has no row below. */
export const DEFAULT_CARD_PLACEHOLDER_HEIGHT = 96

/**
 * A card's usual height in px, per type: each type's preview fixture
 * (`preview-fixtures.ts`, shaped like real answers) drawn through the chat's
 * path on `/dev/a2ui` in a 632 px column (the answer column is 636 px,
 * `grid-card-charter.md` §0.5.3), Chromium, 2026-09-27, rounded to 10 px.
 * Typical, not a maximum: the arrival corrects to the card's measured height
 * once it has drawn, so a row only has to be close. The `ifc_*` cards and
 * `document_grid` have no fixture there and are estimates from their layout;
 * a type with no row takes the default.
 */
export const CARD_PLACEHOLDER_HEIGHTS: Partial<Record<GridCard['type'], number>> = {
  callout: 130,
  task_created: 130,
  memory_proposal: 140,
  follow_ups: 160,
  summary: 160,
  verdict_header: 170,
  document_draft: 170,
  requirement_checklist: 200,
  key_takeaways: 210,
  legal_basis: 210,
  calculation: 230,
  file_operation_proposal: 230,
  project_profile_patch: 230,
  ifc_model_picker: 230,
  ifc_element: 240,
  norm_chain: 250,
  typed_table: 290,
  ifc_schedule: 300,
  ifc_diff: 300,
  ifc_compliance: 300,
  document_grid: 300,
  comparison_table: 330,
  diagram: 340,
  acoustic_check: 360,
  condition_tree: 380,
  deadline_timeline: 380,
  surface: 390,
  document_checklist: 400,
  change_impact: 430,
  parking_requirement: 430,
  dimension_diagram: 470,
  fire_compartment: 470,
  ifc_viewer: 480,
  energy_performance: 490,
  density_check: 550,
  thermal_envelope: 560,
  process_map: 560,
  building_section: 560,
  elevator_requirement: 580,
  egress_diagram: 590,
  guardrail_check: 620,
  daylight_incidence: 660,
  stair_diagram: 710,
  setback_plan: 730,
  fire_access_plan: 770,
}

/** The placeholder height for a card of `type`; the default when the type is unknown. */
export const cardPlaceholderHeight = (type?: string): number =>
  (type && CARD_PLACEHOLDER_HEIGHTS[type as GridCard['type']]) || DEFAULT_CARD_PLACEHOLDER_HEIGHT

interface CardPlaceholderProps {
  /** The card's type, when it is known; sizes the placeholder. */
  type?: string
  /** Overrides the height (px), e.g. to fill a frame that is already sized. */
  height?: number | string
  className?: string
}

/** A card-shaped placeholder: the framed register with shimmer where the content goes. */
export const CardPlaceholder: FC<CardPlaceholderProps> = ({ type, height, className }) => (
  <Card
    aria-hidden="true"
    data-slot="card-placeholder"
    data-card-type={type}
    className={cn(CARD_SHELL, 'gap-2 overflow-hidden p-5', className)}
    style={{ height: height ?? cardPlaceholderHeight(type) }}
  >
    <Skeleton className="h-3 w-24 shrink-0" />
    <Skeleton className="h-4 w-2/3 shrink-0" />
    <Skeleton className="min-h-0 w-full flex-1" />
  </Card>
)
