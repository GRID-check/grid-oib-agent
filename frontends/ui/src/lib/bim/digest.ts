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

/** `| a | b |` row, escaping markdown table metacharacters in cell text. */
function row(cells: Array<string | number>): string {
  return `| ${cells
    .map((cell) => String(cell).replace(/\\/g, '\\\\').replace(/\|/g, '\\|'))
    .join(' | ')} |`
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

/** Per-storey rollup, in the storey order the summary already established. */
export function buildStoreyBreakdown(
  summary: BimModelSummary,
  elements: readonly BimElement[]
): StoreyBreakdown[] {
  const byStorey = new Map<string, StoreyBreakdown>()
  for (const storey of summary.storeys) {
    byStorey.set(storey.globalId ?? storey.name ?? String(storey.expressId), {
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
  return [...byStorey.values()].map((entry) => ({
    ...entry,
    netFloorArea: entry.netFloorArea === null ? null : Math.round(entry.netFloorArea * 100) / 100,
  }))
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
      'Es beschreibt den Inhalt des Modells (Bauteile, Geschosse, Räume, Kennwerte) und dient als ' +
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
    ['Geschosse gesamt', String(summary.totals.storeys)],
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

  lines.push('## Geschosse')
  lines.push('')
  const breakdown = buildStoreyBreakdown(summary, elements)
  const storeyRows = summary.storeys.map((storey, index) => {
    const entry = breakdown[index]
    return [
      storey.name ?? '(ohne Namen)',
      storey.elevation === null ? '—' : `${formatNumber(storey.elevation)} m`,
      entry?.elementCount ?? 0,
      entry?.spaceCount ?? 0,
      entry?.netFloorArea === null || entry?.netFloorArea === undefined
        ? '—'
        : `${formatNumber(entry.netFloorArea)} ${area}`,
    ]
  })
  lines.push(...table(['Geschoss', 'Höhenlage', 'Bauteile', 'Räume', 'Netto-Grundfläche'], storeyRows))
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
    lines.push(`## ${type === 'IfcSpace' ? 'Räume' : 'Geschosse (Bauteile)'}`)
    lines.push('')
    lines.push(
      ...table(
        ['Name', 'Geschoss', 'Netto-Grundfläche'],
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
        'Die Zusammenfassung listet eine begrenzte Auswahl; die Gesamtzahlen oben sind vollständig.'
    )
    lines.push('')
  }

  return lines.join('\n')
}
