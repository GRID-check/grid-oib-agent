/** Similar closed projects: the page a person reads for the office's past work (ADR-0094). */
export const references = {
  intro:
    'The office’s closed projects most like this one that you may open: what they share, the decisions made there and the conditions the authority set. Piloti draws on the same projects as precedent in chat.',
  basis: {
    title: 'Compared by',
    fact: '{label}: {value}',
    open: '{label}: open',
    missing:
      '{count, plural, one {# fact is} other {# facts are}} missing from the brief; adding {count, plural, one {it} other {them}} sharpens the comparison.',
  },
  empty: {
    title: 'No closed projects in the office yet.',
    description: 'Once a project is closed it appears here, with what it shares with this one.',
  },
  noneAlike: 'No closed project shares a trait with this one yet.',
  others: {
    title: 'Other closed projects',
    description: 'Nothing in common with this project recorded, newest first.',
  },
  more: '… and {count, plural, one {# more closed project} other {# more closed projects}}, which Piloti also searches in chat.',
  ask: {
    action: 'Ask Piloti',
    question: 'What can we take from the project “{name}” for this project?',
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
      person: 'Confirmed by a person',
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
