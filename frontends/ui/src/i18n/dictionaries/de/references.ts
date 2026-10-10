import type { en } from '../en'

/** Ähnliche abgeschlossene Projekte: was das Büro früher gebaut hat, soweit die Person es einsehen darf. */
export const references: typeof en.references = {
  intro:
    'Abgeschlossene Projekte des Büros, die diesem am ähnlichsten sind und die Sie einsehen dürfen: was sie gemeinsam haben, welche Entscheidungen dort fielen und welche Auflagen die Behörde stellte. Dieselben Projekte zieht Piloti im Chat als Präzedenzfälle heran.',
  basis: {
    title: 'Verglichen nach',
    fact: '{label}: {value}',
    open: '{label}: offen',
    missing:
      '{count, plural, one {# Angabe fehlt} other {# Angaben fehlen}} im Briefing; mit {count, plural, one {ihr} other {ihnen}} wird der Vergleich genauer.',
  },
  empty: {
    title: 'Noch keine abgeschlossenen Projekte im Büro.',
    description: 'Sobald ein Projekt abgeschlossen ist, erscheint es hier, mit dem, was es mit diesem gemeinsam hat.',
  },
  noneAlike: 'Kein abgeschlossenes Projekt teilt bisher ein Merkmal mit diesem.',
  others: {
    title: 'Weitere abgeschlossene Projekte',
    description: 'Ohne erfasste Gemeinsamkeit mit diesem Projekt, die neuesten zuerst.',
  },
  more: '… und {count, plural, one {# weiteres abgeschlossenes Projekt} other {# weitere abgeschlossene Projekte}}, die Piloti im Chat ebenfalls durchsucht.',
  ask: {
    action: 'Piloti fragen',
    question: 'Was können wir aus dem Projekt „{name}“ für dieses Projekt übernehmen?',
  },
  fields: {
    period: 'Zeitraum',
    bundesland: 'Bundesland',
    oibEdition: 'OIB-Ausgabe',
    oibEditionValue: 'OIB-Richtlinien {edition}',
    sharedTraits: 'Gemeinsam',
    noSharedTraits: 'Nichts gemeinsam erfasst.',
    notRecorded: 'nicht erfasst',
    unconfirmed: 'aus den Unterlagen, unbestätigt',
  },
  decisions: {
    title: 'Entscheidungen',
    empty: 'Keine Entscheidungen festgehalten.',
    kind: {
      decision: 'Entscheidung',
      constraint: 'Vorgabe',
    },
    origin: {
      person: 'von einer Person bestätigt',
      documents: 'aus den Unterlagen erschlossen',
      agent: 'von Piloti notiert',
    },
    source: '{file}, S. {page}',
    sourceWithoutPage: '{file}',
  },
  permits: {
    title: 'Bescheide und Auflagen',
    empty: 'Keine Bescheide erfasst.',
    kind: {
      bewilligung: 'Bewilligung',
      nachforderung: 'Nachforderung',
      ablehnung: 'Ablehnung',
      sonstiges: 'Sonstiges',
    },
    requirementKind: {
      auflage: 'Auflage',
      nachforderung: 'Nachforderung',
      hinweis: 'Hinweis',
    },
    issuedOn: 'Ausgestellt am {date}',
  },
  summary:
    '{decisions, plural, one {# Entscheidung} other {# Entscheidungen}} · {permits, plural, one {# Bescheid} other {# Bescheide}}',
}
