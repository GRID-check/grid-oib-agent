/**
 * Runs — how a run reads in the thread that commissioned it (the Laufblock).
 *
 * A run's ledger (`lib/runs/run-ledger-types.ts`) carries ASCII keys: `planen`,
 * `laeuft`. These are the words the reader sees for them, and the sentences
 * each status owes the reader. The vocabulary rule is the one `workflow-names`
 * set: no identifier reaches the reader, every phase is a word, every status a
 * word plus a sentence, and a number appears only where it changes what the
 * reader does next.
 *
 * `runs.completedBefore` is the difference between „failed" and something a
 * person can act on: which phases were done when the run stopped, so what is
 * already there is not re-commissioned.
 */
export const runs = {
  /** The five phases, as the rail and the phase list name them. */
  phase: {
    planen: 'Planning',
    recherchieren: 'Researching',
    pruefen: 'Checking',
    schreiben: 'Writing',
    abgelegt: 'Filed',
  },
  /** The seven display states — the bold word in the header. */
  status: {
    angelegt: 'Starting',
    laeuft: 'Running',
    wartet: 'Waiting for you',
    fertig: 'Done',
    fehlgeschlagen: 'Failed',
    abgebrochen: 'Cancelled',
    unterbrochen: 'Interrupted',
  },
  /** The sentence each status owes the reader, under the phase list. */
  sentence: {
    angelegt: 'Piloti is taking on the task.',
    angelegtFiling:
      'Piloti is taking on the task. The result will be filed in the project under “Reports”.',
    wartet: 'Piloti has a question. Answer below in the thread.',
    fertigFiled: 'Report filed in Project › Reports.',
    fertigInline: 'The report is here in the thread.',
    fehlgeschlagen: 'Failed: {reason}',
    abgebrochen: 'Stopped at your request.',
    unterbrochen: 'The research was cut short; the report is written from what was there.',
  },
  /** What was already done when the run stopped. */
  completedBefore: 'Done so far: {phases}',
  /** The research phase with its tallies inside the list above. */
  completedBeforeTallies: '{phase} ({rounds}, {docs})',
  step: {
    /** A step whose runner stated no intent. */
    fallback: 'Research round {n}',
    round: 'Round {n}',
    /** A document a step reached a second time. */
    repeat: 'already read',
    openPoints: 'Open:',
  },
  /** The one line a finished phase folds to, and the live line of an active one. */
  phaseLine: {
    planen: 'Research plan drawn up',
    pruefen: 'Citations checked against the sources',
    pruefenLive: 'Checking citations against the sources',
    schreiben: 'Report written',
    schreibenLive: 'Writing the report',
  },
  tallies: {
    rounds: '{count, plural, one {# round} other {# rounds}}',
    docs: '{count, plural, one {# document} other {# documents}}',
  },
  /** The header summary while live; the tallies drop out when they are zero. */
  summary: '{phase} · {rounds} · {docs}',
  /** The one action that fits the state, at the right end of the header. */
  action: {
    answer: 'Answer',
    review: 'Review',
    openReport: 'Open report',
    openInProject: 'Show in project',
    retry: 'Start again',
    openInThread: 'Open in thread',
  },
  /** What a reviewer said, under the result. The reason is theirs, verbatim. */
  review: {
    accepted: 'Accepted by {name}',
    acceptedAnon: 'Accepted',
    rejected: 'Sent back: {reason}',
    rejectedAnon: 'Sent back',
  },
  rail: {
    label: 'Phases',
    /** Spoken state of a rail step, for readers who cannot see the swatch. */
    done: 'done',
    active: 'in progress',
    pending: 'pending',
  },
  block: {
    aria: 'Task {title}: {status}',
    toggle: 'Show or hide the task’s progress',
    untitled: 'Task',
    elapsedAria: 'Running for {elapsed}',
  },
}
