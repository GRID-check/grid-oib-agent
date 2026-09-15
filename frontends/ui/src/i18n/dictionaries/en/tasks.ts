/**
 * Tasks — the project's delegated work (ADR-0051).
 *
 * A task is work somebody handed to Piloti and walked away from: a chat handoff
 * („@Piloti prüf das bis Freitag"), a reviewer's „Piloti überarbeiten lassen",
 * or a schedule firing on its timer. The words here are about WORK, never about
 * a run — which is why the surface calls them Tasks in both languages now. It
 * used to say „Läufe" for the very same rows, and a person who asked for
 * something does not think of the answer as a run of anything.
 */
export const tasks = {
  /** The cadence inline on a detail: a task happened once. */
  cadence: {
    once: 'One-off',
  },
  create: {
    /** One-shot delegation happens in chat — this only links there. */
    delegate: 'Delegate',
    delegateHint: 'Delegation happens in chat: ask Piloti to take something on.',
  },
  /** The filter row above the list. `unreviewed` is the one that matters. */
  filters: {
    label: 'Filter tasks',
    all: 'All',
    active: 'Running',
    /** Finished, and nobody has said whether it was any good. An open loop. */
    unreviewed: 'Unreviewed',
    failed: 'Failed',
    showAll: 'Show all tasks',
  },
  /** Recency headings, so a long list reads as a timeline. */
  buckets: {
    today: 'Today',
    yesterday: 'Yesterday',
    week: 'This week',
    earlier: 'Earlier',
  },
  card: {
    openAria: 'Open “{title}”',
    unreviewed: 'Not reviewed yet',
  },
  /** Where a result lives — one word per destination, on the card and in the drawer. */
  result: {
    document: 'Open document',
    conversation: 'Continue in chat',
    report: 'Open report',
    /** A failure has no report; what a person wants is what it tried. */
    thinking: 'View thinking',
  },
  detail: {
    close: 'Close details',
    /** Opens the wizard on this schedule. */
    edit: 'Edit',
    result: 'Result',
    /** The frozen ask: the requester's own sentence, as the run received it. */
    request: 'Request',
    schedule: 'Schedule',
    prompt: 'Prompt',
    /** The schedule's own runs — each of which is a task, so it says so. */
    runs: 'Tasks',
    /** Turns a one-off into a standing instruction, pre-filled. */
    promote: 'Save as a schedule',
    promoteHint: 'Opens the schedule wizard with this request already written in.',
    /** A deep link whose row is gone — deleted, or never visible to this reader. */
    gone: 'This no longer exists. It may have been deleted.',
    /**
     * A deep link that never matched a row in this project. The link may target
     * another project, or the item was deleted before this list loaded. Said as
     * "not here" rather than "gone": the drawer never saw it, so it cannot claim
     * it left.
     */
    goneUnresolved:
      'This could not be found here. The link may point to another project, or the item was deleted.',
    /** The title over the gone body — never the close label over gone content. */
    goneTitle: 'Not found',
    /** The title while a deep link is still being checked — no finding yet. */
    loadingTitle: 'Loading',
  },
  list: {
    emptyTitle: 'Nothing delegated yet',
    emptyDescription:
      'Ask Piloti to take something on in a chat, or send a draft back for revision — it turns up here.',
    /** Nothing under a narrower filter, which is a different claim from nothing at all. */
    emptyFiltered: {
      active: 'Nothing is running right now',
      unreviewed: 'Everything finished has been reviewed',
      failed: 'Nothing has failed',
    },
    errorTitle: 'The task list could not be loaded',
    errorDescription: 'The rest of the project is unaffected. Try again in a moment.',
    retry: 'Try again',
  },
  /** One noun per kind, in the vocabulary the rest of the product uses. */
  kind: {
    'deep-research': 'Research',
    chat: 'Chat',
    compliance_check: 'Compliance check',
    einreichcheck: 'Submission check',
    document: 'Document',
    revision: 'Revision',
  },
  status: {
    queued: 'Queued',
    running: 'Running',
    succeeded: 'Done',
    failed: 'Failed',
    /** Stopped - by a person or by a budget. Not an error to look into. */
    interrupted: 'Stopped',
    /** A fire that never reached the agent (a cap, a switched-off feature). */
    skipped: 'Skipped',
    /** A fire whose submission broke - the visible failure the collapse added. */
    error: 'Submission failed',
  },
  review: {
    accepted: 'Accepted',
    rejected: 'Sent back',
  },
  meta: {
    byOn: '{name} · {when}',
    on: '{when}',
  },
}
