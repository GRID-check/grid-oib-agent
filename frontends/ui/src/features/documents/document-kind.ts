/**
 * Content-aware document-kind inference for the Files card grid (WS-4).
 *
 * Pure helpers — no React, no I/O — that map a document's real metadata onto
 * one of six visual kinds used to pick a skeleton thumbnail:
 * floor plan (Grundriss), section (Schnitt), site plan (Lageplan), official
 * notice (Bescheid), photo, or generic text document.
 *
 * Inference order (most trustworthy signal first):
 *   1. Controlled ingestion tags (backend-classified, user-correctable).
 *   2. Content type (any `image/*` is a photo).
 *   3. Filename heuristics (German building-domain terms + image extensions).
 *   4. Fallback: generic document.
 */

export type DocumentKind = 'floorplan' | 'section' | 'siteplan' | 'notice' | 'photo' | 'document'

/**
 * Controlled-vocabulary tag → kind. Keys are lowercase. Tags that have no
 * distinctive skeleton (Gutachten, Vertrag, …) intentionally fall through to
 * the generic document.
 */
const TAG_KIND: Record<string, DocumentKind> = {
  grundriss: 'floorplan',
  schnitt: 'section',
  // An elevation (Ansicht) is drawn like a section face — closest skeleton.
  ansicht: 'section',
  bebauungsplan: 'siteplan',
  'flächenwidmungsplan': 'siteplan',
  lageplan: 'siteplan',
  bescheid: 'notice',
  foto: 'photo',
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp|svg)$/

export interface DocumentKindInput {
  filename: string
  contentType?: string | null
  tags?: string[] | null
}

export function inferDocumentKind({ filename, contentType, tags }: DocumentKindInput): DocumentKind {
  // 1. Ingestion tags are authoritative when present.
  for (const tag of tags ?? []) {
    const kind = TAG_KIND[tag.toLowerCase()]
    if (kind) return kind
  }

  // 2. MIME type: any raster/vector image is a photo.
  if ((contentType ?? '').toLowerCase().startsWith('image/')) return 'photo'

  // 3. Filename heuristics. Site-plan terms are matched before the generic
  //    "plan" pattern so "Lageplan"/"site-plan" never reads as a floor plan.
  const name = filename.toLowerCase()
  if (/lageplan|bebauungsplan|fl(ä|ae)chenwidmung|site.?plan/.test(name)) return 'siteplan'
  if (/schnitt|ansicht/.test(name)) return 'section'
  if (/grundriss|grundriß|floor.?plan|plan/.test(name)) return 'floorplan'
  if (/bescheid|genehmigung|permit/.test(name)) return 'notice'
  if (IMAGE_EXT.test(name) || /foto|photo/.test(name)) return 'photo'

  // 4. Default: generic text document.
  return 'document'
}

/** Uppercase display extension ("PDF", "DOCX"); empty string when there is none. */
export function fileExtensionLabel(filename: string): string {
  const match = /\.([a-z0-9]{1,5})$/i.exec(filename.trim())
  return match ? match[1].toUpperCase() : ''
}

/**
 * Tint (background + text CSS values) for a file-extension chip.
 *
 * There is no dedicated file-type token family yet, so the chips lean on the
 * provenance/source token family from the overhaul spec (§4) with graceful
 * fallbacks to today's semantic feedback tokens — never raw hex — so they
 * render correctly both before and after the WS-1 token retune lands:
 *   documents (pdf/doc/txt) → project-knowledge green,
 *   plans (dwg/dxf/ifc)     → law blue,
 *   photos                  → office gold,
 *   everything else         → neutral.
 */
export interface ExtChipTint {
  background: string
  color: string
}

const TINTS = {
  law: {
    background: 'var(--source-law-tint, var(--background-color-feedback-info-subtle))',
    color: 'var(--source-law-text, var(--text-color-feedback-info))',
  },
  project: {
    background: 'var(--source-project-tint, var(--background-color-feedback-success-subtle))',
    color: 'var(--source-project-text, var(--text-color-feedback-success))',
  },
  office: {
    background: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
    color: 'var(--source-office-text, var(--text-color-feedback-warning))',
  },
  neutral: {
    background: 'var(--source-auto-tint, var(--muted))',
    color: 'var(--source-auto-text, var(--muted-foreground))',
  },
} as const satisfies Record<string, ExtChipTint>

const EXT_TINT: Record<string, ExtChipTint> = {
  pdf: TINTS.project,
  doc: TINTS.project,
  docx: TINTS.project,
  txt: TINTS.project,
  md: TINTS.project,
  rtf: TINTS.project,
  dwg: TINTS.law,
  dxf: TINTS.law,
  ifc: TINTS.law,
  jpg: TINTS.office,
  jpeg: TINTS.office,
  png: TINTS.office,
  gif: TINTS.office,
  webp: TINTS.office,
  svg: TINTS.office,
  heic: TINTS.office,
}

export function extChipTint(extLabel: string): ExtChipTint {
  return EXT_TINT[extLabel.toLowerCase()] ?? TINTS.neutral
}
