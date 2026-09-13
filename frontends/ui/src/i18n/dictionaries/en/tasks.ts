/**
 * Aufgaben — the project's delegated work (ADR-0051).
 *
 * A task is work somebody handed to Piloti and walked away from: a chat handoff
 * („@Piloti prüf das bis Freitag"), a reviewer's „Piloti überarbeiten lassen",
 * or a job firing on its timer. The words here are about WORK, never about a
 * run: „läuft" and „fehlgeschlagen" are what a person asks about the thing they
 * asked for, and the technical detail lives with the job run.
 */
export const tasks = {
  panel: {
    description:
      'Work handed to Piloti — from a chat, from a review, or from a job on its schedule. Recurring schedules sit on top; every single run lands below.',
  },
  groups: {
    /** Recurring schedules (templates): jobs with a cron, shown with their cadence. */
    templates: 'Schedules',
    templatesEmpty: 'No recurring schedules. A schedule has Piloti work on a timer.',
    templatesError: 'The schedules could not be loaded.',
    /** Single runs (instances): every task row, each of which happened once. */
    instances: 'Runs',
  },
  /** The cadence inline on every row: templates name theirs, instances ran once. */
  cadence: {
    once: 'One-off',
  },
  create: {
    /** One-shot delegation happens in chat — this only links there. */
    delegate: 'Delegate',
    delegateHint: 'Delegation happens in chat: ask Piloti to take something on.',
    /** The schedule flow (the job builder), gated on project:skills:manage. */
    schedule: 'New schedule',
    back: 'Back to tasks',
  },
  detail: {
    close: 'Close details',
    /** Where the result IS — the filed document first, the chat second. */
    result: 'Result',
    openDocument: 'Open document',
    /** A `chat` run landed in a conversation: reopen it there and keep typing. */
    continueChat: 'Continue in chat',
    /** The frozen ask: the requester's own sentence, as the run received it. */
    request: 'Request',
    schedule: 'Schedule',
    prompt: 'Prompt',
    runs: 'Runs',
    /** A deep link whose row is gone — deleted, or never visible to this reader. */
    gone: 'This no longer exists. It may have been deleted.',
    /** The title over the gone body — never the close label over gone content. */
    goneTitle: 'Not found',
  },
  list: {
    emptyTitle: 'Nothing delegated yet',
    emptyDescription:
      'Ask Piloti to take something on in a chat, or send a draft back for revision — it turns up here.',
    errorTitle: 'The task list could not be loaded',
    errorDescription: 'The rest of the project is unaffected. Try again in a moment.',
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
    /** Stopped — by a person or by a budget. Not an error to look into. */
    interrupted: 'Stopped',
  },
  review: {
    accepted: 'Accepted',
    rejected: 'Sent back',
  },
  meta: {
    byOn: '{name} · {when}',
    on: '{when}',
    /** The result. The row links to it rather than trying to summarise it. */
    document: 'Document',
    conversation: 'Chat',
  },
}
