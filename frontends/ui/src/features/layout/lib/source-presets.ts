/**
 * Composer source-preset shortcuts (WS-3, click-dummy overhaul spec §1/§2.2).
 *
 * The shortcut chips ("Baurecht & Richtlinien" / "Projektunterlagen" /
 * "Büroarchiv") map onto whatever data sources the backend registry ACTUALLY
 * exposes (`GET /v1/data_sources`, e.g. `web_search`, `ris`). Nothing is
 * invented: each preset selects the subset of real sources whose id/name
 * matches its signal, and everything else is disabled.
 *
 * Important honesty note: project documents and the org Archiv are retrieved
 * through the knowledge layer, which is NOT a toggleable data source (the API
 * client filters `knowledge_layer` out of the list). So the "Projektunterlagen"
 * and "Büroarchiv" presets legitimately resolve to an empty external-source
 * subset — meaning "answers ground in the document corpus, external search
 * off" — unless the registry grows matching sources, in which case they are
 * picked up automatically.
 */

import type { DataSourceFromAPI } from '@/adapters/api'
import type { SourcePresetId } from '../types'

/**
 * The provenance signal a source belongs to (spec §4 `--source-*` family).
 * `auto` covers web search / anything unclassified.
 */
export type SourceSignal = 'law' | 'project' | 'office' | 'auto'

/**
 * A `--source-*` token family name: the four signals plus the lane-level
 * accents that refine one of them.
 *
 * `oib` is not a fifth signal — the OIB corpus is still `law` everywhere the
 * coarse provenance stratum is what matters (icon, presets, trust grouping).
 * It exists because OIB and RIS are the two tiers architects compare most, and
 * painting both the same blue left the authority badge carrying that entire
 * distinction on its own. Resolve it with `accentForLane` in the chat feature,
 * which is the only place a fine lane key is known.
 */
export type SourceTint = SourceSignal | 'oib'

/** Matches law/regulation sources: RIS, Baurecht, OIB Richtlinien, norms. */
const LAW_RE = /(^|[^a-z])ris([^a-z]|$)|recht|\blaw\b|richtlin|oib|norm|gesetz/i
/** Matches project-document/knowledge sources. */
const PROJECT_RE = /knowledge|projekt|project|unterlag|document|dokument|file|upload/i
/** Matches office-archive sources. */
const OFFICE_RE = /archiv|archive|office|b[uü]ro/i

/** Signal each preset selects for. */
const PRESET_SIGNAL: Record<SourcePresetId, SourceSignal> = {
  law: 'law',
  project: 'project',
  office: 'office',
}

/** Minimal shape needed for classification (subset of DataSourceFromAPI). */
export type ClassifiableSource = Pick<DataSourceFromAPI, 'id' | 'name'> & {
  description?: string
}

/**
 * Classify a real data source into a provenance signal by id first, then name.
 * Unknown sources (e.g. `web_search`) fall through to `auto`.
 */
export const classifySourceSignal = (source: ClassifiableSource): SourceSignal => {
  const haystacks = [source.id, source.name ?? '']
  for (const value of haystacks) {
    if (!value) continue
    if (LAW_RE.test(value)) return 'law'
    if (OFFICE_RE.test(value)) return 'office'
    if (PROJECT_RE.test(value)) return 'project'
  }
  return 'auto'
}

/**
 * Compute the enabled-source ids a preset stands for, given the sources that
 * really exist. May legitimately be empty (external sources off; the
 * always-in-scope knowledge layer carries the documents).
 */
export const computePresetSourceIds = (
  preset: SourcePresetId,
  sources: ClassifiableSource[] | null | undefined
): string[] => {
  if (!sources || sources.length === 0) return []
  const signal = PRESET_SIGNAL[preset]
  return sources.filter((source) => classifySourceSignal(source) === signal).map((s) => s.id)
}
