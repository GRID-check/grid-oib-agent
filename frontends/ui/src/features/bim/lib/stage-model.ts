/**
 * What the viewer's rail shows: the project's models, and the building's
 * levels.
 *
 * Pure, and separate from the components, for the reason the repo already
 * learned once: a list that is sorted, labelled and resolved inside a render
 * function can only be tested by mounting a WebGPU viewport, which no test
 * runner can do. Everything here is arithmetic over the summary the server
 * already extracted.
 *
 * The vocabulary is deliberately not IFC's. A `IfcBuildingStorey` is a
 * "Geschoss" to the person looking at it, an `IfcWallStandardCase` is a wall,
 * and a viewer that says otherwise is asking its reader to learn a schema
 * before they can look at their own building.
 */

import type { BimModelSummary, BimStorey } from '@/lib/bim/types'

/** One row of the rail's level list. */
export interface StageLevel {
  /** The storey's own name, which is also how the URL addresses it. */
  name: string
  /** Metres above the model origin, or null when the export omits it. */
  elevation: number | null
  /** Elements the extractor placed on this storey. */
  elementCount: number
}

/**
 * The building's levels, top first.
 *
 * Descending elevation, because that is how a building is drawn in section and
 * how every architect reads a level list — the roof at the top of the list is
 * the roof at the top of the building. Ascending order is what a database
 * returns and it inverts the reader's mental model on every glance.
 *
 * Storeys with no published elevation sort last rather than as zero: an
 * unplaced storey is unknown, not at ground level, and sorting it into the
 * middle of the stack asserts something the file never said.
 */
export function stageLevels(summary: BimModelSummary | null | undefined): StageLevel[] {
  const storeys: readonly BimStorey[] = summary?.storeys ?? []
  return storeys
    .filter((storey): storey is BimStorey & { name: string } => Boolean(storey.name?.trim()))
    .map((storey) => ({
      name: storey.name.trim(),
      elevation: typeof storey.elevation === 'number' && Number.isFinite(storey.elevation)
        ? storey.elevation
        : null,
      elementCount: storey.elementCount,
    }))
    .sort((a, b) => {
      if (a.elevation === null && b.elevation === null) return a.name.localeCompare(b.name)
      if (a.elevation === null) return 1
      if (b.elevation === null) return -1
      return b.elevation - a.elevation
    })
}

/** The elevation of one named storey, for the section cut's default height. */
export function levelElevation(
  summary: BimModelSummary | null | undefined,
  name: string | null
): number | null {
  if (!name) return null
  const match = stageLevels(summary).find((level) => level.name === name)
  return match?.elevation ?? null
}

/**
 * A model's display name: the file name without its extension.
 *
 * `Haus-A_v3.ifc` is a file; `Haus-A_v3` is a model. The rail is listing
 * buildings, and the three characters that say "this is an IFC" are the least
 * interesting thing about any of them — the whole rail is IFCs.
 */
export function stageModelLabel(filename: string): string {
  return filename.replace(/\.(ifc|ifczip|ifcxml)$/i, '')
}

/**
 * Resolve the model a link names, or fall back to a sensible default.
 *
 * Links carry the FILE NAME rather than an id (see `model-link.ts`): ids change
 * when a file is re-ingested and mean nothing in a chat message. Matching is
 * exact first, then by prefix-free substring, so a link written against
 * `Haus-A.ifc` still opens after someone renames the upload to
 * `Haus-A (final).ifc`.
 *
 * @param preferred The `?model=` value, if the link carried one.
 */
export function pickStageModel<T extends { filename: string; status: string; updatedAt: string }>(
  models: readonly T[],
  preferred: string | null | undefined
): T | null {
  if (models.length === 0) return null

  const wanted = preferred?.trim().toLowerCase()
  if (wanted) {
    const exact = models.find((model) => model.filename.toLowerCase() === wanted)
    if (exact) return exact
    const partial = models.find((model) => model.filename.toLowerCase().includes(wanted))
    if (partial) return partial
  }

  // No link, or a link naming a model this project no longer has. The newest
  // READY model is the honest default: opening a viewer onto a model that is
  // still extracting shows a progress bar where a building should be, and the
  // reader cannot tell that from a failure.
  const ready = models.filter((model) => model.status === 'ready')
  const pool = ready.length > 0 ? ready : models
  return [...pool].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
}

/**
 * `+3.20`, `-2.80`, `±0.00` — an elevation as a drawing labels it.
 *
 * The sign is the whole point: a level list where the basement and the first
 * floor both read `2.80` is a list that has lost the only distinction anyone
 * is scanning it for. Ground level gets `±` rather than a bare `0.00` for the
 * same reason — it is the datum, and saying so is what makes the signs above
 * and below it legible at a glance.
 *
 * The unit is NOT appended here. It belongs to the dictionary, because a
 * number formatted in one language and captioned in another is exactly the
 * seam that produces `+3.20 m` in an otherwise German rail.
 */
export function formatLevelElevation(metres: number): string {
  const rounded = Math.round(metres * 100) / 100
  if (rounded === 0) return '±0.00'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)}`
}

/**
 * `IfcWallStandardCase` → `Wall`.
 *
 * Both suffixes go: `StandardCase` is an IFC modelling distinction (a wall with
 * a single material layer set) that no architect asked about, and the `Ifc`
 * prefix is the schema announcing itself. What is left is the noun the person
 * clicked on.
 */
export function readableIfcType(ifcType: string): string {
  return ifcType.replace(/^Ifc/, '').replace(/StandardCase$/, '').replace(/ElementedCase$/, '')
}

/**
 * Split a CamelCase IFC noun into words: `CurtainWall` → `Curtain Wall`.
 *
 * Applied after {@link readableIfcType} so a label reads as language rather
 * than as an identifier. Runs of capitals are left alone, so `IfcHVACDuct`
 * does not become `H V A C Duct`.
 */
export function humaniseIfcType(ifcType: string): string {
  return readableIfcType(ifcType)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}
