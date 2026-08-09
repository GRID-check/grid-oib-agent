/**
 * The Prüfbuch as BCF 2.1 — the ledger's open items, opened as issues in the
 * tool the model was authored in.
 *
 * This is the step that makes the catalogue actionable rather than merely
 * true. "34 tragende Wände führen kein `Pset_WallCommon.FireRating`" is a good
 * sentence on a web page and a useless one in a CAD session: the architect
 * still has to find those 34 walls. A BCF topic carrying their GlobalIds is
 * double-clickable — ArchiCAD, Revit, Solibri and BIMcollab all select the
 * elements and zoom to them. The web page states the problem; the BCF file
 * puts the cursor on it.
 *
 * ## What is in a topic, and what deliberately is not
 *
 * One topic per requirement that is failing or undecidable — never per
 * element. A rule that leaves 34 walls undecidable is ONE piece of work
 * ("author FireRating on the load-bearing walls"), and exploding it into 34
 * issues would bury the other requirements in a topic list nobody reads. The
 * elements travel as the topic's viewpoint selection, which is where a BCF
 * reader expects to find "the things this is about".
 *
 * No snapshot image. BCF viewpoints may carry a PNG of the camera view, and
 * every geometric operation in this product happens in the browser — the
 * server has no kernel, no camera and no way to render one. A fabricated or
 * blank snapshot would be worse than none: readers show it as the topic's
 * thumbnail, and a blank thumbnail reads as "nothing to see here".
 *
 * No `extensions.xsd`. BCF 2.1 allows an archive to constrain its own
 * vocabulary; every value written here is already in the default set that
 * readers ship with, so declaring the vocabulary could only ever make the file
 * more fragile, not more portable.
 *
 * ## Determinism
 *
 * Topic GUIDs are derived (UUIDv5) from the PROJECT and the rule id, not from
 * the revision — so re-exporting after Rev.4 updates the same topics in a BCF
 * server rather than duplicating the whole list. Every date in the archive
 * comes from data (the revision's timestamp, the confirmation's timestamp)
 * rather than from a clock, which together with {@link createZip} makes an
 * unchanged ledger export to byte-identical bytes.
 */

import 'server-only'
import { createHash } from 'node:crypto'
import { createZip, type ZipEntry } from './zip'
import { rulesWithOpenWork } from './rules'
import type { BimElementVerdict, BimRuleResultWithConfirmation } from './rules'

/**
 * Namespace for the UUIDv5 topic ids. A fixed constant, never regenerated:
 * changing it re-issues every topic in every project as a new one.
 */
const GRID_BCF_NAMESPACE = '8f3d6a1e-5c47-4b9e-9a2d-7e1c0b4f8a53'

/** Verdict rows carried in a topic description before the count speaks. */
const DESCRIPTION_ROWS = 12

export interface BcfModelRef {
  id: string
  filename: string
  /** The IfcProject GlobalId, when the spatial tree published one. */
  ifcProjectGlobalId: string | null
  /** The revision's own timestamp — every date in the archive derives from it. */
  updatedAt: Date
}

export interface BcfExportInput {
  projectId: string
  projectName: string | null
  model: BcfModelRef
  /** A full run of the catalogue, confirmations already attached. */
  results: readonly BimRuleResultWithConfirmation[]
  /** Shown as the topic author; the exporting user, not the confirming one. */
  author: string
}

export interface BcfExport {
  filename: string
  bytes: Uint8Array
  /** How many topics the archive carries — zero is a legitimate answer. */
  topics: number
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * Escape for both text nodes and attribute values.
 *
 * Deliberately escapes quotes as well as the three text-critical characters:
 * a rule title reaching an attribute is a one-line change away, and an escaper
 * that is only correct in one position is a trap for whoever makes it.
 */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Strip what XML 1.0 cannot represent at all.
 *
 * Control characters below 0x20 (other than tab, newline and carriage return)
 * are not escapable — `&#x0;` is as illegal as a raw NUL — and IFC property
 * values arrive from whatever wrote the file. A reader that rejects the whole
 * archive because one element name carries a stray 0x1f is a bug in this
 * exporter, not in the reader.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g

const clean = (value: string): string => value.replace(ILLEGAL_XML, '')

const text = (value: string): string => xml(clean(value))

/** ISO-8601 with seconds and a `Z` — `xsd:dateTime` as every reader wants it. */
const isoDate = (value: Date): string => `${value.toISOString().slice(0, 19)}Z`

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/** RFC 4122 §4.3 name-based UUID, SHA-1 flavour. */
function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest()
  const bytes = Uint8Array.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const topicGuid = (projectId: string, ruleId: string): string =>
  uuidV5(GRID_BCF_NAMESPACE, `${projectId}:${ruleId}`)

const childGuid = (projectId: string, ruleId: string, kind: string): string =>
  uuidV5(GRID_BCF_NAMESPACE, `${projectId}:${ruleId}:${kind}`)

// ---------------------------------------------------------------------------
// Topic content
// ---------------------------------------------------------------------------

function verdictLines(verdicts: readonly BimElementVerdict[], total: number, capped: boolean): string[] {
  const lines = verdicts.slice(0, DESCRIPTION_ROWS).map((verdict) => {
    const where = verdict.storeyName ? ` (${verdict.storeyName})` : ''
    return `- ${verdict.name ?? verdict.globalId}${where}: ${verdict.reading}`
  })
  const shown = Math.min(verdicts.length, DESCRIPTION_ROWS)
  if (total > shown) {
    // `capped` says the RULE dropped rows before we ever saw them, so the
    // remainder is a floor rather than an exact count. Saying "mindestens"
    // costs one word and stops the file from asserting a number it cannot know.
    lines.push(`- … ${capped ? 'mindestens ' : ''}${total - shown} weitere`)
  }
  return lines
}

/** The topic body: the requirement, the reading, and what would settle it. */
export function bcfDescription(result: BimRuleResultWithConfirmation, model: BcfModelRef): string {
  const sections: string[] = [
    `Anforderung: ${result.thresholdDe}`,
    `Quelle: ${result.richtlinie}, Punkt ${result.clause}`,
    `Modellstand: ${model.filename} (${isoDate(model.updatedAt).slice(0, 10)})`,
    '',
    `Ergebnis: ${result.passed} erfüllt, ${result.failed} nicht erfüllt, ${result.undecidable} nicht entscheidbar.`,
  ]

  if (result.failures.length > 0) {
    sections.push('', 'Nicht erfüllt:', ...verdictLines(result.failures, result.failed, result.truncated))
  }
  if (result.unknowns.length > 0) {
    sections.push(
      '',
      'Nicht entscheidbar:',
      ...verdictLines(result.unknowns, result.undecidable, result.truncated)
    )
  }
  if (result.missing.length > 0) {
    sections.push(
      '',
      'Fehlende Eigenschaften:',
      ...result.missing.map((entry) => `- ${entry.path} (${entry.elements} Bauteile)`)
    )
  }

  sections.push(
    '',
    'Aus dem GRID-Prüfbuch exportiert. Orientierung, keine Rechtsberatung — die Werte stammen aus dem Modell und ersetzen keine Prüfung.'
  )
  return sections.join('\n')
}

function topicTitle(result: BimRuleResultWithConfirmation): string {
  const verdict = result.failed > 0 ? 'nicht erfüllt' : 'nicht entscheidbar'
  return `${result.richtlinie}, Punkt ${result.clause} — ${result.titleDe} (${verdict})`
}

/**
 * The elements a reader should select when the topic is opened.
 *
 * Failures first: on a rule with both, the ones that are wrong matter more
 * than the ones that are unknown, and a reader that truncates a long selection
 * truncates the tail.
 */
function topicComponents(result: BimRuleResultWithConfirmation): string[] {
  const ids = [...result.failures, ...result.unknowns].map((verdict) => verdict.globalId)
  return [...new Set(ids)]
}

interface TopicComment {
  guid: string
  date: Date
  author: string
  body: string
}

function topicComments(result: BimRuleResultWithConfirmation, projectId: string): TopicComment[] {
  const confirmation = result.confirmation
  if (!confirmation) return []
  const parsed = new Date(confirmation.confirmedAt)
  const stale = result.confirmationStale
    ? ' Diese Bestätigung wurde gegen eine ANDERE Modellrevision abgegeben und gilt nicht automatisch für den hier exportierten Stand.'
    : ''
  const note = confirmation.note ? ` Anmerkung: ${confirmation.note}` : ''
  return [
    {
      guid: childGuid(projectId, result.ruleId, 'confirmation'),
      // A confirmation whose timestamp will not parse still has to travel; the
      // revision's date is the only other honest answer available here.
      date: Number.isNaN(parsed.getTime()) ? new Date(0) : parsed,
      author: confirmation.confirmedBy,
      // The note goes LAST: it is free text that may or may not end in a full
      // stop, and anything appended after it reads as part of it.
      body: `Im Prüfbuch manuell bestätigt.${stale}${note}`,
    },
  ]
}

function markupXml(
  result: BimRuleResultWithConfirmation,
  input: BcfExportInput,
  guid: string,
  hasViewpoint: boolean
): string {
  const { model, projectId, author } = input
  const created = isoDate(model.updatedAt)
  const settled = result.confirmation !== null && !result.confirmationStale
  const status = settled ? 'Closed' : 'Open'
  const type = result.failed > 0 ? 'Issue' : 'Request'
  const priority = result.failed > 0 ? 'High' : 'Normal'

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Markup xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <Header>',
    `    <File IfcProject="${text(model.ifcProjectGlobalId ?? '')}" isExternal="true">`,
    `      <Filename>${text(model.filename)}</Filename>`,
    `      <Date>${created}</Date>`,
    '    </File>',
    '  </Header>',
    `  <Topic Guid="${guid}" TopicType="${type}" TopicStatus="${status}">`,
    `    <Title>${text(topicTitle(result))}</Title>`,
    `    <Priority>${priority}</Priority>`,
    `    <Labels>${text(result.richtlinie)}</Labels>`,
    `    <Labels>${result.failed > 0 ? 'nicht erfüllt' : 'nicht entscheidbar'}</Labels>`,
    `    <CreationDate>${created}</CreationDate>`,
    `    <CreationAuthor>${text(author)}</CreationAuthor>`,
    `    <Description>${text(bcfDescription(result, model))}</Description>`,
    '  </Topic>',
  ]

  for (const comment of topicComments(result, projectId)) {
    lines.push(
      `  <Comment Guid="${comment.guid}">`,
      `    <Date>${isoDate(comment.date)}</Date>`,
      `    <Author>${text(comment.author)}</Author>`,
      `    <Comment>${text(comment.body)}</Comment>`,
      '  </Comment>'
    )
  }

  if (hasViewpoint) {
    lines.push(
      `  <Viewpoints Guid="${childGuid(projectId, result.ruleId, 'viewpoint')}">`,
      '    <Viewpoint>viewpoint.bcfv</Viewpoint>',
      '  </Viewpoints>'
    )
  }

  lines.push('</Markup>', '')
  return lines.join('\n')
}

function viewpointXml(result: BimRuleResultWithConfirmation, projectId: string, globalIds: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<VisualizationInfo Guid="${childGuid(projectId, result.ruleId, 'viewpoint')}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    '  <Components>',
    '    <Selection>',
    ...globalIds.map((id) => `      <Component IfcGuid="${text(id)}" />`),
    '    </Selection>',
    // Required by the 2.1 schema, and `true` is the honest value: this
    // selection says "look at these", never "hide everything else".
    '    <Visibility DefaultVisibility="true" />',
    '  </Components>',
    '</VisualizationInfo>',
    '',
  ].join('\n')
}

const VERSION_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Version VersionId="2.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  '  <DetailedVersion>2.1</DetailedVersion>',
  '</Version>',
  '',
].join('\n')

/** A filesystem-safe stem for the download name. */
function slug(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned === '' ? fallback : cleaned
}

/**
 * Build the archive.
 *
 * An input with nothing outstanding produces a valid, topic-free archive
 * rather than an error: "the ledger is clean" is a result the architect may
 * legitimately want to file, and the caller can read {@link BcfExport.topics}
 * to say so in the UI.
 */
export function buildComplianceBcf(input: BcfExportInput): BcfExport {
  const entries: ZipEntry[] = [{ path: 'bcf.version', content: VERSION_XML }]
  // A rule earns a topic only when it leaves work behind — the same predicate
  // the panel counts with, so the button never promises a topic count the
  // archive does not carry.
  const topics = rulesWithOpenWork(input.results)

  for (const result of topics) {
    const guid = topicGuid(input.projectId, result.ruleId)
    const globalIds = topicComponents(result)
    entries.push({
      path: `${guid}/markup.bcf`,
      content: markupXml(result, input, guid, globalIds.length > 0),
    })
    if (globalIds.length > 0) {
      entries.push({
        path: `${guid}/viewpoint.bcfv`,
        content: viewpointXml(result, input.projectId, globalIds),
      })
    }
  }

  const stem = slug(input.projectName ?? '', 'projekt')
  const revision = isoDate(input.model.updatedAt).slice(0, 10)
  return {
    filename: `pruefbuch-${stem}-${revision}.bcfzip`,
    bytes: createZip(entries),
    topics: topics.length,
  }
}
