/**
 * Catalog of the platform-tunable retrieval counts (Platform → Retrieval).
 *
 * Source of truth for which counts the platform owner may tune, their boot
 * defaults (the values the workflow YAML / tool constants ship with), and
 * their accepted ranges. Mirrored by `_BOUNDS`/`_ALLOWED_VALUES` in the
 * backend's `src/aiq_agent/common/retrieval_settings.py`; parity is pinned by
 * `tests/fixtures/retrieval_settings_catalog.json` on both sides, so a key
 * added here without the backend bound fails in CI.
 *
 * Values are global (platform-level, no org layer) and reach the backend via
 * `GET /api/internal/retrieval-settings`; the backend TTL-caches them and
 * falls back to the YAML/constant default when the BFF is unreachable.
 */

export interface RetrievalSettingDefinition {
  /** Dotted setting key, e.g. `knowledge.top_k`. */
  key: string
  /** Boot default — what the tool uses when no platform row exists. */
  defaultValue: number
  /** Inclusive bounds. */
  min: number
  max: number
  /**
   * When set, only these discrete values are accepted (e.g. the RIS API
   * rejects page sizes outside {10, 20, 50, 100}). Takes precedence over
   * min/max validation.
   */
  allowedValues?: readonly number[]
  /** Short German label for the admin form. */
  label: string
  /** One-line German explanation shown under the field. */
  description: string
}

const RIS_PAGE_SIZES = [10, 20, 50, 100] as const

export const RETRIEVAL_SETTINGS: readonly RetrievalSettingDefinition[] = [
  {
    key: 'knowledge.top_k',
    defaultValue: 8,
    min: 1,
    max: 50,
    label: 'Wissensdatenbank: Treffer gesamt',
    description:
      'Chunks pro Kollektion und Obergrenze nach dem Zusammenführen aller Kollektionen (knowledge_search).',
  },
  {
    key: 'knowledge.max_chunks_per_document',
    defaultValue: 2,
    min: 0,
    max: 10,
    label: 'Wissensdatenbank: Chunks pro Dokument',
    description: 'Diversitäts-Kappe pro Dokument im Merge. 0 deaktiviert die Kappe.',
  },
  {
    key: 'surface.chunk_top_k',
    defaultValue: 24,
    min: 1,
    max: 100,
    label: 'Dokumente-Card: Chunks pro Kollektion',
    description: 'Chunks, die die Dokumente-Card pro Projekt-/Archiv-Kollektion abruft.',
  },
  {
    key: 'surface.max_files',
    defaultValue: 8,
    min: 1,
    max: 30,
    label: 'Dokumente-Card: Dateien maximal',
    description: 'Maximale Anzahl Dateien im Grid der Dokumente-Card.',
  },
  {
    key: 'web.max_results',
    defaultValue: 5,
    min: 1,
    max: 10,
    label: 'Websuche: Ergebnisse',
    description: 'Ergebnisse der Standard-Websuche (Tavily).',
  },
  {
    key: 'web.advanced_max_results',
    defaultValue: 2,
    min: 1,
    max: 10,
    label: 'Websuche (erweitert): Ergebnisse',
    description: 'Ergebnisse der erweiterten Websuche.',
  },
  {
    key: 'ris.max_results',
    defaultValue: 10,
    min: 1,
    max: 50,
    label: 'RIS-Suche: Ergebnisse',
    description: 'Gesetzestreffer, die die RIS-Suche dem Agenten zurückgibt.',
  },
  {
    key: 'ris.page_size',
    defaultValue: 20,
    min: 10,
    max: 100,
    allowedValues: RIS_PAGE_SIZES,
    label: 'RIS-Suche: Seitengröße',
    description: 'Vom RIS abgefragte Treffer pro Seite (nur 10, 20, 50 oder 100).',
  },
  {
    key: 'ris_catalog.max_matches',
    defaultValue: 5,
    min: 1,
    max: 20,
    label: 'RIS-Katalog: Treffer',
    description: 'Treffer der Normen-Katalogsuche (ris_catalog_lookup).',
  },
] as const

export const RETRIEVAL_SETTING_KEYS: readonly string[] = RETRIEVAL_SETTINGS.map((setting) => setting.key)

const BY_KEY = new Map(RETRIEVAL_SETTINGS.map((setting) => [setting.key, setting]))

export function getRetrievalSettingDefinition(key: string): RetrievalSettingDefinition | undefined {
  return BY_KEY.get(key)
}

/** `{key: defaultValue}` for every catalog entry — the boot state of the form. */
export function retrievalSettingDefaults(): Record<string, number> {
  const defaults: Record<string, number> = {}
  for (const setting of RETRIEVAL_SETTINGS) defaults[setting.key] = setting.defaultValue
  return defaults
}

/**
 * Validate one value against the catalog entry. Returns an error message
 * (German, shown in the form) or null when valid. Non-integers are rejected —
 * every count is a whole number of chunks/results.
 */
export function validateRetrievalSettingValue(key: string, value: number): string | null {
  const definition = getRetrievalSettingDefinition(key)
  if (!definition) return `Unbekannte Einstellung: ${key}`
  if (!Number.isInteger(value)) return `${definition.label}: nur ganze Zahlen erlaubt`
  if (definition.allowedValues) {
    return definition.allowedValues.includes(value)
      ? null
      : `${definition.label}: nur ${definition.allowedValues.join(', ')} erlaubt`
  }
  if (value < definition.min || value > definition.max) {
    return `${definition.label}: Wert zwischen ${definition.min} und ${definition.max} erforderlich`
  }
  return null
}
