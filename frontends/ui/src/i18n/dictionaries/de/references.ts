import type { en } from '../en'

/** Ähnliche abgeschlossene Projekte: was das Büro früher gebaut hat, soweit die Person es einsehen darf. */
export const references: typeof en.references = {
  intro:
    'Abgeschlossene Projekte wie dieses, die Sie einsehen dürfen: was sie mit ihm gemeinsam haben, welche Auflagen ihre Bescheide enthalten und welche Entscheidungen sie festgehalten haben.',
  empty: {
    title: 'Noch keine abgeschlossenen Projekte, die diesem ähneln.',
    description: 'Abgeschlossene Projekte erscheinen hier, sobald sie im Büro geschlossen werden.',
  },
  fields: {
    period: 'Zeitraum',
    bundesland: 'Bundesland',
    oibEdition: 'OIB-Ausgabe',
    oibEditionValue: 'OIB-Richtlinien {edition}',
    sharedTraits: 'Gemeinsam',
    noSharedTraits: 'Keine gemeinsamen Merkmale erfasst.',
    notRecorded: 'nicht erfasst',
    unconfirmed: 'aus den Unterlagen, unbestätigt',
  },
  decisions: {
    title: 'Entscheidungen',
    empty: 'Keine Entscheidungen festgehalten.',
    kind: {
      decision: 'Entscheidung',
      constraint: 'Einschränkung',
    },
    origin: {
      person: 'von einer Person festgehalten',
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
