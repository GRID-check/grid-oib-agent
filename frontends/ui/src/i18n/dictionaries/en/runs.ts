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
  /**
   * The second clause of the status line — the one fact the state owes the
   * reader after its own word. The word itself is `status.*`, said once.
   */
  line: {
    /** angelegt, inside a project: where the result will end up. */
    filing: 'result goes to the project',
    wartet: 'answer below in the thread',
    fertigFiled: 'report filed in Project › Reports',
    fertigInline: 'the report is here in the thread',
    /** Leads with the word itself, because the reason has to follow it. */
    fehlgeschlagen: 'Failed: {reason}',
    abgebrochen: 'stopped at your request',
    unterbrochen: 'report written from what was there',
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
    findings: 'Established so far',
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
    findings: '{count, plural, one {# finding} other {# findings}}',
  },
  /** The one action that fits the state, at the right end of the header. */
  action: {
    answer: 'Answer',
    review: 'Review',
    openReport: 'Open report',
    openInProject: 'Show in project',
    retry: 'Start again',
    openInThread: 'Open in thread',
    /** The quiet way out of a run still going. Never the loud one: see `cancel`. */
    cancel: 'Stop',
    writeNow: 'Write now',
    continue: 'Update report',
  },
  /**
   * Stopping a run. The confirmation says what survives, because the fear that
   * stops a hand on this button is losing the two rounds already researched —
   * and they are kept.
   */
  /**
   * The Unterlagen: the documents the reader named for the run. The receipt
   * says which were read and where; the picker over the thread names more.
   */
  plan: {
    heading: 'Research plan',
    headingOwn: 'Your research plan',
    summary: '{genre} · {depth} · {count, plural, one {# section} other {# sections}}',
    startsIn: 'Starts on its own in {seconds} s. Adjust it first if you like.',
    startsNow: 'Starting …',
    held: 'Waiting for you. The research starts when you start it.',
    approved: 'Approved. The research starts in a moment.',
    started: 'The research runs on this plan.',
    adjust: 'Adjust',
    startNow: 'Start now',
    start: 'Start',
    sections: '{count, plural, one {# section} other {# sections}}',
    documents: '{count, plural, one {# focus} other {# focus documents}}',
    documentsOnly: 'only {count, plural, one {# document} other {# documents}}',
    excluded: '{count} excluded',
    stage: { proposed: 'Proposed', held: 'Paused', approved: 'Approved', started: 'Running' },
    saving: 'Saving …',
    saved: 'Every change is saved at once.',
    more: '+ {count} more',
    dialogTitle: 'Plan a research',
    dialogDescription:
      'A question, an outline, a kind — that is all it takes. Documents are optional. The research starts as soon as you create the plan.',
    question: 'Your question',
    questionHint: 'What the research should answer. It becomes the report’s title.',
    questionPlaceholder: 'What should the research find out?',
    create: 'Create plan and start',
    cancel: 'Cancel',
    createFailed: 'The plan could not be created. Try again.',
    preview: 'Preview',
    previewQuestion: 'Your question appears here.',
    previewSections: 'No sections yet.',
    previewNext:
      'Once created, the task appears in the thread. There you see what the research reads, and you can cancel it at any time.',
    needQuestion: 'Question',
    needSection: 'at least one section',
    openDialog: 'Plan a research',
  },
  unterlagen: {
    receiptLabel: 'Documents named for this task',
    receipt: '{read} of {total} named documents read',
    unread: 'not read',
    open: 'Open {name}',
    addAction: 'Add document',
    addTitle: 'Add a document',
    addDescription:
      'Piloti reads it in full in the next research round and lists it with the other documents named for this task.',
    add: 'Add',
    apply: 'Apply',
    isFocus: 'Focus',
    isExcluded: 'Excluded',
    alreadyNamed: 'named',
  },
  cancel: {
    confirmTitle: 'Stop this task?',
    confirmBody:
      'Piloti stops where it is. What has been researched so far stays in the block; the report is not written.',
    confirm: 'Stop task',
    keep: 'Keep running',
  },
  /** What a reviewer said, under the result. The reason is theirs, verbatim. */
  review: {
    accepted: 'Accepted by {name}',
    acceptedAnon: 'Accepted',
    rejected: 'Sent back: {reason}',
    rejectedAnon: 'Sent back',
  },
  /**
   * The live view's own state, never the run's. Both sentences say the same
   * thing first, because it is the thing a reader fears: the work is still
   * going. Only the line into it broke.
   */
  connection: {
    reconnecting:
      'The live view lost its connection and is reconnecting. The task is still running.',
    lost: 'The live view is disconnected. The task is still running — reload to follow it again.',
  },
  block: {
    aria: 'Task {title}: {status}',
    toggle: 'Show or hide the task’s progress',
    untitled: 'Task',
    elapsedAria: 'Running for {elapsed}',
  },
}
