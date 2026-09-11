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
      'Work handed to Piloti — from a chat, from a review, or from a job on its schedule.',
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
