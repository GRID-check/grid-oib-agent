/** Similar closed projects: the page a person reads for the office's past work (ADR-0094). */
export const references = {
  intro:
    'Closed projects like this one that you may open: what they share with it, the conditions their permits set and the decisions they recorded.',
  empty: {
    title: 'No closed projects like this one yet.',
    description: 'Closed projects appear here once the office closes them.',
  },
  fields: {
    period: 'Period',
    bundesland: 'Bundesland',
    oibEdition: 'OIB edition',
    oibEditionValue: 'OIB guidelines {edition}',
    sharedTraits: 'In common',
    noSharedTraits: 'Nothing in common recorded.',
    notRecorded: 'not recorded',
    unconfirmed: 'from the documents, unconfirmed',
  },
  decisions: {
    title: 'Decisions',
    empty: 'No decisions recorded.',
    kind: {
      decision: 'Decision',
      constraint: 'Constraint',
    },
    origin: {
      person: 'Recorded by a person',
      documents: 'From the documents',
      agent: 'Noted by Piloti',
    },
    source: '{file}, p. {page}',
    sourceWithoutPage: '{file}',
  },
  permits: {
    title: 'Permits and conditions',
    empty: 'No permit records.',
    kind: {
      bewilligung: 'Permit',
      nachforderung: 'Request for information',
      ablehnung: 'Refusal',
      sonstiges: 'Other notice',
    },
    requirementKind: {
      auflage: 'Condition',
      nachforderung: 'Request for information',
      hinweis: 'Note',
    },
    issuedOn: 'Issued {date}',
  },
  summary:
    '{decisions, plural, one {# decision} other {# decisions}} · {permits, plural, one {# permit} other {# permits}}',
}
