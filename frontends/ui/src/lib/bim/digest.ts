/**
 * Model → prose digest, the bridge between a BIM model and the existing
 * retrieval stack.
 *
 * GRID answers legal questions by retrieving text chunks and citing them. A
 * model is not text, so on its own it is invisible to that machinery: ask "does
 * the project have an escape stair" in a chat that never mentions the model and
 * the retriever has nothing to return. The digest fixes that by writing the
 * model's *facts* down as a Markdown document and ingesting it alongside the
 * PDFs — so the model participates in ordinary retrieval, with the file name as
 * its citation, while exact counts and sums still come from the deterministic
 * query layer (`query.ts`).
 *
 * Deliberately bounded: this is a summary, not a serialization. Per-element
 * rows live in Postgres where they can be queried; dumping 200k of them into a
 * vector index would bury every other document in the corpus and answer nothing
 * the query tool does not answer better.
 */

import { healthCaveat } from './validate'
import type { BimElement, BimModelSummary } from './types'

/** How many rows each breakdown table keeps before it collapses to a tail row. */
const MAX_TABLE_ROWS = 40

/** How many distinct property values a property line enumerates. */
const MAX_PROPERTY_VALUES = 12

/** Elements whose named instances are worth listing individually. */
const NAMED_INSTANCE_TYPES = ['IfcSpace', 'IfcBuildingStorey']

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function areaLabel(summary: BimModelSummary): string {
  return summary.units.area?.symbol ?? 'm²'
}

function volumeLabel(summary: BimModelSummary): string {
  return summary.units.volume?.symbol ?? 'm³'
}

/**
 * `| a | b |` row, escaped so a cell cannot break out of the table.
 *
 * Three characters matter, and the ORDER of the first two does:
 *
 * - `\` first, because escaping `|` introduces backslashes. A cell already
 *   containing `\|` would otherwise become `\\|` — a literal backslash
 *   followed by an unescaped separator, which splits the row into two cells.
 * - `|` second, the separator itself.
 * - A newline ends the row wherever it appears, so it becomes a space.
 *
 * The cells are element names, type names and property values straight out of
 * whichever tool exported the model, so none of the three is hypothetical.
 * This digest is the text the retriever indexes; a row that breaks re-parses
 * as a different table and the model reads values under the wrong headings.
 */
function row(cells: Array<string | number>): string {
  const escaped = cells.map((cell) =>
    String(cell)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
  )
  return `| ${escaped.join(' | ')} |`
}

function table(headers: string[], rows: Array<Array<string | number>>): string[] {
  if (rows.length === 0) return []
  const kept = rows.slice(0, MAX_TABLE_ROWS)
  const lines = [row(headers), `|${headers.map(() => '---').join('|')}|`, ...kept.map(row)]
  if (rows.length > kept.length) {
    lines.push(row([`… ${rows.length - kept.length} weitere`, ...headers.slice(1).map(() => '')]))
  }
  return lines
}

interface StoreyBreakdown {
  storeyName: string
  elementCount: number
  spaceCount: number
  netFloorArea: number | null
}

/**
 * The key one storey's elements are collected under.
 *
 * Exported so the CALLER can look a row up by the same expression rather than
 * by position — see `buildStoreyBreakdown`.
 */
export function storeyBreakdownKey(storey: {
  globalId?: string | null
  name?: string | null
  expressId?: number
}): string {
  return storey.globalId ?? storey.name ?? String(storey.expressId ?? '')
}

/**
 * Per-storey rollup, keyed rather than ordered.
 *
 * It used to return an array and the digest read it back with
 * `breakdown[index]` against `summary.storeys` — which holds only while the
 * two are the same length. They are not: the map collapses two storeys that
 * share a GlobalId (a real export defect — `validate.ts` has a rule for it) or
 * two same-named storeys with no GlobalId, so the array came back SHORT and
 * every storey after the collision was rendered with the next storey's element
 * count, room count and floor area, with the last one showing zeros.
 */
export function buildStoreyBreakdown(
  summary: BimModelSummary,
  elements: readonly BimElement[]
): Map<string, StoreyBreakdown> {
  const byStorey = new Map<string, StoreyBreakdown>()
  for (const storey of summary.storeys) {
    byStorey.set(storeyBreakdownKey(storey), {
      storeyName: storey.name ?? '(ohne Namen)',
      elementCount: 0,
      spaceCount: 0,
      netFloorArea: null,
    })
  }
  for (const element of elements) {
    const key = element.storeyGlobalId ?? element.storeyName
    if (!key) continue
    const entry = byStorey.get(key)
    if (!entry) continue
    entry.elementCount += 1
    if (element.ifcType === 'IfcSpace') {
      entry.spaceCount += 1
      const area = firstQuantity(element, ['NetFloorArea', 'NetArea'])
      if (area !== null) entry.netFloorArea = (entry.netFloorArea ?? 0) + area
    }
  }
  return new Map(
    [...byStorey].map(([key, entry]) => [
      key,
      {
        ...entry,
        netFloorArea:
          entry.netFloorArea === null ? null : Math.round(entry.netFloorArea * 100) / 100,
      },
    ])
  )
}

function firstQuantity(element: BimElement, keys: readonly string[]): number | null {
  for (const set of Object.values(element.quantities)) {
    for (const key of keys) {
      const value = set[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return null
}

/** Distinct values a property takes across the model, with occurrence counts. */
function propertyValueSummary(
  elements: readonly BimElement[]
): Map<string, Map<string, number>> {
  const byProperty = new Map<string, Map<string, number>>()
  for (const element of elements) {
    for (const [setName, properties] of Object.entries(element.properties)) {
      for (const [propertyName, value] of Object.entries(properties)) {
        if (value === null || value === '') continue
        const key = `${setName}.${propertyName}`
        const values = byProperty.get(key) ?? new Map<string, number>()
        const label = String(value)
        values.set(label, (values.get(label) ?? 0) + 1)
        byProperty.set(key, values)
      }
    }
  }
  return byProperty
}

/**
 * Render the model as a Markdown document for the knowledge index.
 *
 * German, because the corpus, the UI and the answers are German — a digest in
 * English would sit in the same embedding space as the OIB Richtlinien while
 * describing the same things with different words, and retrieval would suffer
 * for no reason.
 */
export function buildModelDigest(
  summary: BimModelSummary,
  elements: readonly BimElement[],
  options: { filename: string }
): string {
  const lines: string[] = []
  const area = areaLabel(summary)
  const volume = volumeLabel(summary)

  lines.push(`# BIM-Modell: ${summary.projectName ?? options.filename}`)
  lines.push('')
  lines.push(
    `Dieses Dokument ist die automatisch erzeugte Zusammenfassung des IFC-Modells \`${options.filename}\`. ` +
      'Es beschreibt den Inhalt des Modells (Bauteile, Geschoße, Räume, Kennwerte) und dient als ' +
      'Grundlage für Fragen zum Gebäude.'
  )
  lines.push('')

  lines.push('## Modellangaben')
  lines.push('')
  const facts: Array<[string, string]> = [
    ['Projekt', summary.projectName ?? '—'],
    ['Grundstück / Standort', summary.siteName ?? '—'],
    ['Gebäude', summary.buildingNames.length ? summary.buildingNames.join(', ') : '—'],
    ['IFC-Schema', summary.schema ?? '—'],
    ['Erstellt mit', summary.header.originatingSystem ?? summary.header.preprocessorVersion ?? '—'],
    ['Exportdatum', summary.header.timeStamp ?? '—'],
    ['Verfasser', summary.header.author.join(', ') || '—'],
    ['Organisation', summary.header.organization.join(', ') || '—'],
    ['Längeneinheit', summary.units.length?.symbol ?? '—'],
    ['Bauteile gesamt', String(summary.totals.elements)],
    ['Räume gesamt', String(summary.totals.spaces)],
    ['Geschoße gesamt', String(summary.totals.storeys)],
  ]
  lines.push(...table(['Angabe', 'Wert'], facts.map(([key, value]) => [key, value])))
  lines.push('')

  const totals = summary.quantityTotals
  if (totals.netFloorAreaM2 !== null || totals.grossFloorAreaM2 !== null || totals.netVolumeM3 !== null) {
    lines.push('## Kennwerte')
    lines.push('')
    const rows: Array<Array<string | number>> = []
    if (totals.netFloorAreaM2 !== null)
      rows.push(['Netto-Grundfläche (Summe Räume)', `${formatNumber(totals.netFloorAreaM2)} ${area}`])
    if (totals.grossFloorAreaM2 !== null)
      rows.push(['Brutto-Grundfläche (Summe Räume)', `${formatNumber(totals.grossFloorAreaM2)} ${area}`])
    if (totals.netVolumeM3 !== null)
      rows.push(['Netto-Rauminhalt (Summe Räume)', `${formatNumber(totals.netVolumeM3)} ${volume}`])
    lines.push(...table(['Kennwert', 'Wert'], rows))
    lines.push('')
  }

  lines.push('## Geschoße')
  lines.push('')
  const breakdown = buildStoreyBreakdown(summary, elements)
  /*
    One row per KEY, not per storey entry.

    Keying the map fixed the misalignment this table used to have; it did not
    fix the doubling underneath it. Two storeys written with the same GlobalId
    — the export defect `validate.ts:identity` reports — collapse to one map
    entry, and both rows then rendered THAT entry: `EG | 2 Bauteile | 2 Räume |
    100 m²` and `1.OG | 2 | 2 | 100 m²` for a building with one room of 40 m²
    on each. The Bauteile and Netto-Grundfläche columns summed to double the
    building. This digest is indexed for retrieval, so the agent can quote it.
  */
  const renderedStoreys = new Set<string>()
  const storeyRows = summary.storeys.flatMap((storey) => {
    const key = storeyBreakdownKey(storey)
    if (renderedStoreys.has(key)) return []
    renderedStoreys.add(key)
    // By key, not by position — see `buildStoreyBreakdown`.
    const entry = breakdown.get(key)
    // A row is an array of cells, so `flatMap` needs it wrapped — otherwise
    // the five cells become five rows.
    return [
      [
        storey.name ?? '(ohne Namen)',
        storey.elevation === null ? '—' : `${formatNumber(storey.elevation)} m`,
        entry?.elementCount ?? 0,
        entry?.spaceCount ?? 0,
        entry?.netFloorArea === null || entry?.netFloorArea === undefined
          ? '—'
          : `${formatNumber(entry.netFloorArea)} ${area}`,
      ],
    ]
  })
  lines.push(...table(['Geschoß', 'Höhenlage', 'Bauteile', 'Räume', 'Netto-Grundfläche'], storeyRows))
  lines.push('')

  lines.push('## Bauteile nach Typ')
  lines.push('')
  lines.push(
    ...table(
      ['IFC-Typ', 'Anzahl'],
      Object.entries(summary.typeCounts).map(([type, count]) => [type, count])
    )
  )
  lines.push('')

  for (const type of NAMED_INSTANCE_TYPES) {
    const named = elements.filter((element) => element.ifcType === type && element.name)
    if (named.length === 0) continue
    lines.push(`## ${type === 'IfcSpace' ? 'Räume' : 'Geschoße (Bauteile)'}`)
    lines.push('')
    lines.push(
      ...table(
        ['Name', 'Geschoß', 'Netto-Grundfläche'],
        named.map((element) => {
          const netArea = firstQuantity(element, ['NetFloorArea', 'NetArea'])
          return [
            element.name ?? '—',
            element.storeyName ?? '—',
            netArea === null ? '—' : `${formatNumber(netArea)} ${area}`,
          ]
        })
      )
    )
    lines.push('')
  }

  if (summary.materialNames.length > 0) {
    lines.push('## Materialien')
    lines.push('')
    lines.push(summary.materialNames.join(', '))
    lines.push('')
  }

  const propertyValues = propertyValueSummary(elements)
  if (propertyValues.size > 0) {
    lines.push('## Eigenschaften im Modell')
    lines.push('')
    lines.push(
      'Vorhandene Merkmale (Property Sets) mit den im Modell tatsächlich belegten Werten:'
    )
    lines.push('')
    const propertyRows = [...propertyValues.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, values]) => {
        const rendered = [...values.entries()]
          .sort(([, aCount], [, bCount]) => bCount - aCount)
          .slice(0, MAX_PROPERTY_VALUES)
          .map(([value, count]) => `${value} (${count}×)`)
          .join('; ')
        return [key, rendered]
      })
    lines.push(...table(['Merkmal', 'Werte'], propertyRows))
    lines.push('')
  }

  // The health caveat goes in the DIGEST too, not only in the query results:
  // an answer grounded in retrieved text must carry the same qualification as
  // one grounded in a count, or the two disagree about the same model.
  const caveat = summary.health ? healthCaveat(summary.health) : null
  if (caveat) {
    lines.push('## Modellqualität')
    lines.push('')
    lines.push(caveat)
    lines.push('')
  }
  if (summary.health && summary.health.issues.length > 0) {
    lines.push(
      ...table(
        ['Prüfung', 'Schwere', 'Betroffen'],
        summary.health.issues.map((issue) => [
          issue.detail ? `${issue.rule} (${issue.detail})` : issue.rule,
          issue.severity,
          issue.total === null ? String(issue.count) : `${issue.count} / ${issue.total}`,
        ])
      )
    )
    lines.push('')
  }

  if (summary.truncatedAt !== null) {
    lines.push(
      `> Hinweis: Das Modell enthält mehr als ${summary.truncatedAt} Bauteile. ` +
        // Precisely which numbers. "Die Gesamtzahlen oben sind vollständig"
        // covered the Kennwerte — which are accumulated over every entity
        // during extraction and genuinely are complete — but the tables under
        // it are built from the CAPPED element list, so the per-storey column
        // sums to less than the Netto-Grundfläche directly above it. Both are
        // indexed for retrieval, so the agent could cite either.
        'Die Kennwerte und Flächensummen oben sind vollständig; die Geschoß- und ' +
        'Bauteiltabellen darunter beziehen sich nur auf die gespeicherten Bauteile.'
    )
    lines.push('')
  }

  return lines.join('\n')
}
