/**
 * GENERATED FILE — DO NOT EDIT.
 * Source: configs/norms/<country>/registry.yml (`applicability:` blocks, ADR-0025 Phase 4).
 * Regenerate: uv run --frozen python scripts/build_applicability_rules.py
 */

export type ApplicabilityOp = 'eq' | 'in' | 'defined' | 'undefined' | 'gt' | 'gte' | 'lt' | 'lte'

export interface ApplicabilityCondition {
  fact: string
  op: ApplicabilityOp
  value?: string | number | Array<string | number>
}

export interface ApplicabilityWhen {
  all?: ApplicabilityCondition[]
  any?: ApplicabilityCondition[]
}

export type ApplicabilityVerdictStatus = 'required' | 'likely' | 'check'

export interface ApplicabilityRule {
  when?: ApplicabilityWhen
  verdict: ApplicabilityVerdictStatus
  reasonDe: string
  reasonEn: string
}

export interface NormApplicability {
  normId: string
  short: string
  titleDe: string
  rules: ApplicabilityRule[]
}

export const APPLICABILITY_RULES: NormApplicability[] = [
  {
    "normId": "garagengesetz-wien",
    "short": "Garagengesetz Wien",
    "titleDe": "Wiener Garagengesetz 2008",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Stellplatzpflicht in Wien: Wiener Garagengesetz prüfen.",
        "reasonEn": "Parking-space obligation in Vienna: check the Wiener Garagengesetz.",
        "when": {
          "all": [
            {
              "fact": "stellplatz_relevant",
              "op": "eq",
              "value": true
            },
            {
              "fact": "bundesland",
              "op": "eq",
              "value": "wien"
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "oib-rl-1",
    "short": "OIB-RL 1",
    "titleDe": "OIB-Richtlinie 1 — Mechanische Festigkeit und Standsicherheit",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Gilt für jedes Bauvorhaben (mechanische Festigkeit und Standsicherheit).",
        "reasonEn": "Applies to every building project (mechanical strength and stability)."
      }
    ]
  },
  {
    "normId": "oib-rl-2",
    "short": "OIB-RL 2",
    "titleDe": "OIB-Richtlinie 2 — Brandschutz",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Brandschutz ist für jedes Bauwerk verbindlich.",
        "reasonEn": "Fire safety is mandatory for every structure."
      }
    ]
  },
  {
    "normId": "oib-rl-2.1",
    "short": "OIB-RL 2.1",
    "titleDe": "OIB-Richtlinie 2.1 — Brandschutz bei Betriebsbauten",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Betriebsbauten (Produktion/Lager) fallen in den Geltungsbereich.",
        "reasonEn": "Industrial and storage buildings are in scope.",
        "when": {
          "all": [
            {
              "fact": "hauptnutzung",
              "op": "in",
              "value": [
                "produzierend",
                "lager"
              ]
            }
          ]
        }
      },
      {
        "verdict": "check",
        "reasonDe": "Bei landwirtschaftlichen/sonstigen Nutzungen oder fehlender Angabe prüfen.",
        "reasonEn": "Check for agricultural/other uses or missing information.",
        "when": {
          "any": [
            {
              "fact": "hauptnutzung",
              "op": "in",
              "value": [
                "landwirtschaft",
                "sonstiges"
              ]
            },
            {
              "fact": "hauptnutzung",
              "op": "undefined"
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "oib-rl-2.2",
    "short": "OIB-RL 2.2",
    "titleDe": "OIB-Richtlinie 2.2 — Brandschutz bei Garagen, überdachten Stellplätzen und Parkdecks",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Unterirdische Garagen oder Stellplätze können in den Geltungsbereich fallen.",
        "reasonEn": "Underground garages or parking decks may be in scope.",
        "when": {
          "all": [
            {
              "fact": "geschosse_unterirdisch",
              "op": "gte",
              "value": 1
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "oib-rl-2.3",
    "short": "OIB-RL 2.3",
    "titleDe": "OIB-Richtlinie 2.3 — Brandschutz bei Gebäuden mit einem Fluchtniveau von mehr als 22 m",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Fluchtniveau über 22 m (Hochhaus): RL 2.3 ist verbindlich.",
        "reasonEn": "Escape level above 22 m (high-rise): RL 2.3 is mandatory.",
        "when": {
          "all": [
            {
              "fact": "fluchtniveau",
              "op": "eq",
              "value": ">22m"
            }
          ]
        }
      },
      {
        "verdict": "check",
        "reasonDe": "Gebäudeklasse 5 ohne Fluchtniveau-Angabe: Hochhaus-Prüfung erforderlich.",
        "reasonEn": "Building class 5 with unknown escape level: high-rise check required.",
        "when": {
          "all": [
            {
              "fact": "gebaeudeklasse",
              "op": "eq",
              "value": "GK5"
            },
            {
              "fact": "fluchtniveau",
              "op": "undefined"
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "oib-rl-3",
    "short": "OIB-RL 3",
    "titleDe": "OIB-Richtlinie 3 — Hygiene, Gesundheit und Umweltschutz",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Hygiene, Gesundheit und Umweltschutz gelten für jedes Bauwerk.",
        "reasonEn": "Hygiene, health and environmental protection apply to every structure."
      }
    ]
  },
  {
    "normId": "oib-rl-4",
    "short": "OIB-RL 4",
    "titleDe": "OIB-Richtlinie 4 — Nutzungssicherheit und Barrierefreiheit",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Öffentlich genutzte Gebäude: barrierefreier Zugang und barrierefreie Nutzung sind verbindlich.",
        "reasonEn": "Publicly used buildings: barrier-free access and use are mandatory.",
        "when": {
          "all": [
            {
              "fact": "hauptnutzung",
              "op": "in",
              "value": [
                "beherbergung",
                "gesundheit",
                "versammlung",
                "buero"
              ]
            }
          ]
        }
      },
      {
        "verdict": "required",
        "reasonDe": "Grundanforderungen der Barrierefreiheit gelten allgemein.",
        "reasonEn": "Baseline accessibility requirements apply generally."
      }
    ]
  },
  {
    "normId": "oib-rl-5",
    "short": "OIB-RL 5",
    "titleDe": "OIB-Richtlinie 5 — Schallschutz",
    "rules": [
      {
        "verdict": "required",
        "reasonDe": "Schallempfindliche Nutzungseinheiten: Schallschutz ist verbindlich.",
        "reasonEn": "Noise-sensitive usage units: sound insulation is mandatory.",
        "when": {
          "all": [
            {
              "fact": "hauptnutzung",
              "op": "in",
              "value": [
                "wohnen",
                "beherbergung",
                "gesundheit",
                "buero",
                "versammlung"
              ]
            }
          ]
        }
      },
      {
        "verdict": "likely",
        "reasonDe": "Schallschutz-Anforderungen hängen von der Nutzungseinheit ab.",
        "reasonEn": "Sound-insulation requirements depend on the usage unit."
      }
    ]
  },
  {
    "normId": "oib-rl-6",
    "short": "OIB-RL 6",
    "titleDe": "OIB-Richtlinie 6 — Energieeinsparung und Wärmeschutz",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Bei Lager- oder Landwirtschaftsnutzung Anforderungen an Energieeinsparung prüfen.",
        "reasonEn": "Check energy-saving requirements for storage or agricultural use.",
        "when": {
          "all": [
            {
              "fact": "hauptnutzung",
              "op": "in",
              "value": [
                "lager",
                "landwirtschaft"
              ]
            }
          ]
        }
      },
      {
        "verdict": "required",
        "reasonDe": "Energieeinsparung und Wärmeschutz sind grundsätzlich verbindlich.",
        "reasonEn": "Energy saving and thermal insulation are mandatory in principle."
      }
    ]
  },
  {
    "normId": "klgg-wien",
    "short": "KlGG Wien",
    "titleDe": "Wiener Kleingartengesetz 1996",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Vorhaben im Kleingartengebiet: Wiener Kleingartengesetz beachten.",
        "reasonEn": "Project in an allotment-garden zone: observe the Wiener Kleingartengesetz.",
        "when": {
          "all": [
            {
              "fact": "kleingartengebiet",
              "op": "eq",
              "value": true
            },
            {
              "fact": "bundesland",
              "op": "eq",
              "value": "wien"
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "dmsg",
    "short": "DMSG",
    "titleDe": "Denkmalschutzgesetz",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Denkmalschutz: Abstimmung mit dem Bundesdenkmalamt erforderlich.",
        "reasonEn": "Heritage protection: coordination with the Federal Monuments Office required.",
        "when": {
          "all": [
            {
              "fact": "denkmalschutz",
              "op": "eq",
              "value": true
            }
          ]
        }
      }
    ]
  },
  {
    "normId": "gewo",
    "short": "GewO 1994",
    "titleDe": "Gewerbeordnung 1994",
    "rules": [
      {
        "verdict": "check",
        "reasonDe": "Betriebsanlage: Gewerbeordnung §§ 74ff (Nachbarrechte) prüfen.",
        "reasonEn": "Commercial facility: check Trade Code §§ 74ff (neighbour protection).",
        "when": {
          "all": [
            {
              "fact": "betriebsanlage",
              "op": "eq",
              "value": true
            }
          ]
        }
      }
    ]
  }
]
