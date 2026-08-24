/**
 * Model → project profile.
 *
 * GRID's compliance reasoning runs off the project brief: `gebaeudeklasse`,
 * `fluchtniveau`, `geschosse_oberirdisch`, `hauptnutzung`. Those are asked in
 * the intake wizard, by hand, from a person who already drew them.
 *
 * A model knows most of them exactly. Storey elevations give the number of
 * storeys above and below ground and the Fluchtniveau band; the space mix gives
 * the main use; the room count gives the unit count. Deriving them turns the
 * model from "a thing you can look at" into the project's own source of truth
 * for the facts every later answer depends on.
 *
 * ## Why this proposes rather than writes
 *
 * A derived fact is an inference from an export, and an export can be a working
 * file. `geschosse_oberirdisch` is used to pick a Gebäudeklasse, and a wrong
 * Gebäudeklasse is a wrong answer about fire safety. So this module produces
 * SUGGESTIONS with the evidence they came from, and the agent offers them
 * through the existing `project_profile_patch` card — the user confirms, as
 * they do for every other agent-proposed profile change (ADR-0030).
 *
 * Pure: a function of the extracted index.
 */

import type { BimModelSummary } from './types'

/** Confidence in a derived fact — mirrors the memory vocabulary. */
export type BimSuggestionConfidence = 'low' | 'medium' | 'high'

export interface BimProfileSuggestion {
  /** Profile fact key, e.g. `geschosse_oberirdisch`. */
  key: string
  value: string | number
  confidence: BimSuggestionConfidence
  /** What in the model produced it — shown to the user, verbatim. */
  evidence: string
}

/**
 * Fluchtniveau bands as the profile vocabulary defines them.
 *
 * The band is picked from the elevation of the highest storey that has
 * elements. Deliberately NOT called the Fluchtniveau itself: the regulation
 * defines it as the floor level of the topmost storey with an escape route, and
 * a storey elevation is a good proxy for that and not the same thing — which is
 * why every suggestion here carries its evidence and stays a proposal.
 */
const FLUCHTNIVEAU_BANDS: Array<{ limit: number; band: string }> = [
  { limit: 7, band: '<=7m' },
  { limit: 11, band: '7-11m' },
  { limit: 22, band: '11-22m' },
  { limit: Number.POSITIVE_INFINITY, band: '>22m' },
]

/**
 * IFC space names, lower-cased, that indicate a main use. Matched as
 * substrings because room naming is free text and every office has its own
 * convention ("WE 03 Wohnzimmer", "Büro 2.14").
 */
const USE_MARKERS: Array<{ use: string; markers: string[] }> = [
  { use: 'wohnen', markers: ['wohn', 'schlafzimmer', 'kinderzimmer', 'küche', 'kueche', 'bad', 'wc '] },
  { use: 'buero', markers: ['büro', 'buero', 'besprechung', 'office'] },
  { use: 'beherbergung', markers: ['hotel', 'gästezimmer', 'gaestezimmer', 'zimmer '] },
  { use: 'versammlung', markers: ['saal', 'versammlung', 'foyer', 'aula'] },
  { use: 'gesundheit', markers: ['patienten', 'behandlung', 'ordination', 'station'] },
  { use: 'produzierend', markers: ['produktion', 'werkstatt', 'fertigung'] },
  { use: 'lager', markers: ['lager', 'archiv', 'abstellraum'] },
]

/** Space names that are circulation or service, never a main use. */
const NON_USE_MARKERS = ['flur', 'gang', 'treppe', 'stiege', 'technik', 'schacht', 'keller', 'garage']

function classifyUse(spaceNames: readonly string[]): { use: string; hits: number } | null {
  const tally = new Map<string, number>()
  for (const raw of spaceNames) {
    const name = raw.toLowerCase()
    if (NON_USE_MARKERS.some((marker) => name.includes(marker))) continue
    for (const { use, markers } of USE_MARKERS) {
      if (markers.some((marker) => name.includes(marker))) {
        tally.set(use, (tally.get(use) ?? 0) + 1)
        break
      }
    }
  }
  const ranked = [...tally.entries()].sort(([, a], [, b]) => b - a)
  const top = ranked[0]
  if (!top) return null
  // A single matching room in a fifty-room building is a coincidence, not a use.
  if (top[1] < 2) return null
  // Two uses within one room of each other is a mixed-use building, and picking
  // one would be a guess dressed as a derivation.
  //
  // `>= top` could only ever be an exact tie — the list is sorted descending —
  // so twelve `wohnen` rooms against eleven `buero` ones was published as a
  // Hauptnutzung of `wohnen`, at `medium` confidence, and a Hauptnutzung
  // decides which rules apply. The comment said "within one room"; now the
  // code does too.
  if (ranked[1] && top[1] - ranked[1][1] <= 1) return null
  return { use: top[0], hits: top[1] }
}

export interface BimProfileInput {
  summary: BimModelSummary
  /** Names of every `IfcSpace`, for the use classification. */
  spaceNames: readonly string[]
}

/**
 * Derive project-profile facts from a model.
 *
 * Returns only what the model actually supports. A model with no storey
 * elevations yields no storey counts — an absent suggestion is correct, and a
 * guessed one would be read as a measurement.
 */
export function deriveProfileSuggestions(input: BimProfileInput): BimProfileSuggestion[] {
  const { summary, spaceNames } = input
  const suggestions: BimProfileSuggestion[] = []

  const placed = summary.storeys.filter((storey) => storey.elevation !== null)
  if (placed.length > 0) {
    // A storey at exactly 0 is the ground floor: above ground, by convention
    // and by every Austrian Bauordnung that counts it.
    const above = placed.filter((storey) => (storey.elevation ?? 0) >= 0)
    const below = placed.filter((storey) => (storey.elevation ?? 0) < 0)

    suggestions.push({
      key: 'geschosse_oberirdisch',
      value: above.length,
      confidence: placed.length === summary.storeys.length ? 'high' : 'medium',
      evidence: `${above.length} Geschoße mit Höhenlage ≥ 0 im Modell: ${above
        .map((storey) => storey.name ?? '—')
        .join(', ')}`,
    })

    if (below.length > 0) {
      suggestions.push({
        key: 'geschosse_unterirdisch',
        value: below.length,
        // The same qualification its sibling above carries. A basement among
        // the storeys with no published elevation is a basement this count
        // does not see, and offering a short count at `high` is offering the
        // label that invites the reader to accept it — into a Gebäudeklasse.
        confidence: placed.length === summary.storeys.length ? 'high' : 'medium',
        evidence: `${below.length} Geschoße mit negativer Höhenlage: ${below
          .map((storey) => `${storey.name ?? '—'} (${storey.elevation} m)`)
          .join(', ')}`,
      })
    }

    // The topmost storey that actually contains something. A model often
    // carries an empty roof-plane storey above the last real one, and counting
    // it would push the Fluchtniveau into the next band.
    const occupied = placed.filter((storey) => storey.elementCount > 0)
    const highest = occupied.reduce<number | null>(
      (max, storey) => (max === null || (storey.elevation ?? 0) > max ? (storey.elevation ?? 0) : max),
      null
    )
    if (highest !== null) {
      const band = FLUCHTNIVEAU_BANDS.find((entry) => highest <= entry.limit)?.band
      if (band) {
        suggestions.push({
          key: 'fluchtniveau',
          value: band,
          // Medium, always: a storey elevation is a proxy for the Fluchtniveau,
          // not the thing itself, and the difference decides a Gebäudeklasse.
          confidence: 'medium',
          evidence: `Oberstes belegtes Geschoß liegt bei ${highest} m (${
            occupied.find((storey) => storey.elevation === highest)?.name ?? '—'
          })`,
        })
      }
    }
  }

  const use = classifyUse(spaceNames)
  if (use) {
    suggestions.push({
      key: 'hauptnutzung',
      value: use.use,
      confidence: use.hits >= 5 ? 'medium' : 'low',
      evidence: `${use.hits} Räume im Modell tragen Namen dieser Nutzung`,
    })
  }

  if (summary.totals.spaces > 0) {
    suggestions.push({
      key: 'anzahl_einheiten',
      value: summary.totals.spaces,
      // Rooms are not units — a flat is several rooms — so this is offered as
      // the room count it is, at the lowest confidence, rather than pretending
      // to a number the model does not contain.
      confidence: 'low',
      evidence: `${summary.totals.spaces} Räume (IfcSpace) im Modell — nicht dasselbe wie Nutzungseinheiten`,
    })
  }

  return suggestions
}

/** One line per suggestion, for the agent to read and the user to check. */
export function renderProfileSuggestions(suggestions: readonly BimProfileSuggestion[]): string {
  if (suggestions.length === 0) {
    return 'Aus dem Modell lassen sich keine Projektangaben ableiten.'
  }
  return suggestions
    .map(
      (suggestion) =>
        `${suggestion.key} = ${suggestion.value} (${suggestion.confidence}) — ${suggestion.evidence}`
    )
    .join('\n')
}
