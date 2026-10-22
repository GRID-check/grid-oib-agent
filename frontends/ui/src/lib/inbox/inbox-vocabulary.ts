/**
 * The inbox item types, free of drizzle.
 *
 * `db/schema/inbox.ts` is where they belong by subject and the wrong place to
 * import them FROM: the inbox's wire schema (`./inbox-wire`) and so the agent
 * catalog must not drag the schema in. The tuple lives here, the schema imports
 * and re-exports it, so no existing caller moves (the
 * `projects/memory-vocabulary.ts` arrangement).
 */

/**
 * Item types. Exhaustive over the registry (`@/lib/inbox/registry`), which
 * fails to type-check if a type here has no entry.
 *
 * Phase 1 deliberately ships four — one actionable and three informational —
 * so the generic frame is proven by more than a single case.
 */
export const INBOX_ITEM_TYPES = [
  /** Actionable: someone tagged you and the agent is holding for your answer. */
  'mention.requested',
  /** Informational: a request you made was answered. */
  'mention.answered',
  /** Informational: you were given access to a resource. */
  'conversation.shared_with_you',
  /** Informational, grouped: new messages in a thread you participate in. */
  'conversation.activity',
  /**
   * Operational: the organization's stored bytes crossed a share of its quota
   * (ADR-0042). Not a collaboration event — it is addressed to whoever can act
   * on it, and it must reach them whether or not the tenant has collaboration
   * (see `gate` in `@/lib/inbox/registry`).
   */
  'storage.quota_warning',
  /** Informational: you were named responsible for a resource (ADR-0047). */
  'document.assigned_to_you',
  /**
   * A background run the reader asked for has ended (ADR-0035 named "a failed
   * workflow run" as the type the frame was built to carry). Operational, not
   * collaboration: nobody is waiting on the reader, but work was done on their
   * behalf while they were away, and until these existed a 03:00 run produced
   * a report that nobody was told about.
   */
  'task_run.completed',
  'task_run.failed',
  /**
   * Actionable: a run the reader asked for has stopped to ask them something
   * (the ledger's `waiting`, ADR-0062). Resolved by the run moving on — the
   * answer lands in the thread, and the ledger's next status settles the row.
   */
  'task_run.waiting',
  /**
   * Actionable: a version of a document is waiting for your Freigabe
   * (ADR-0054). The FIRST actionable type outside mentions, and the reason the
   * frame stayed generic — the row points at the document and anchors on the
   * version, so a deep link lands on the revision being judged rather than on the
   * file's current bytes.
   *
   * Resolved by the decision itself (approve, request changes, reject), for
   * every reviewer who was asked and not only the one who acted: once a decision
   * is taken the question is settled for everybody, and a row nothing can
   * resolve sits in a badge for good.
   */
  'document.review_requested',
  /**
   * Informational, platform tier: a member somewhere in the fleet sent product
   * feedback (a bug, an idea, praise or a question). Addressed to the platform
   * owners and written into the PLATFORM organization, not the reporter's —
   * the reporter's tenant has no business knowing who runs the platform, and
   * the owners read it from whichever organization they are working in (the
   * inbox's platform lane, `@/lib/inbox/service`).
   */
  'feedback.submitted',
  /**
   * Informational, operational tier: the team answered a member's own product
   * feedback in PostHog Support (ADR-0118, second amendment). Addressed to the
   * reporter, in the reporter's organization; one row per report, counting the
   * replies since it was last read. Opens „Mein Feedback" on that thread.
   */
  'feedback.replied',
  /**
   * Operational: everything an upload of yours brought in has been read
   * (ADR-0086, ticket „Was ist angekommen?"). Addressed to the uploader; the
   * row opens the upload's summary.
   */
  'upload.completed',
  /**
   * Operational: the content check held a file back before any model read it
   * (ADR-0086). Addressed to whoever may release or delete it, folded into one
   * counted row per organization, and opening the quarantine queue.
   */
  'document.quarantined',
  /**
   * Operational: the uploader of a quarantined file asks for it to be released
   * (ADR-0086, „Freigabe anfragen"). Addressed to whoever may release it, one
   * row per file, opening the quarantine queue. It names the file: only the
   * file's own reviewers receive it.
   */
  'document.release_requested',
  /**
   * Informational, operational tier: an Outlook archive the recipient started
   * importing has been filed, or the import stopped (ADR-0085). Addressed to the
   * person who started it, pointing at the project and anchored on the folder
   * the import filed under, which is where the row lands.
   */
  'mail_import.completed',
  'mail_import.failed',
  /**
   * Informational, operational tier: a newer Fassung of a document the
   * recipient follows exists (CONTEXT.md „Fassung", ADR-0054, ADR-0099) —
   * either a person confirmed that another document replaces it, or a new
   * version was published under its name. Addressed to the people assigned to
   * the OLDER document and to its uploader, never to the person who made the
   * change, and only to those who may see the newer document. The row points at
   * the NEWER document, so the read-time access check is the one that matters.
   */
  'document.new_revision',
  /**
   * Informational, operational tier: a turn Piloti ran on an Anmerkung ended
   * for the person whose act woke it (ADR-0106): the mark they delegated is
   * done, or Piloti answered where they mentioned it. Anchored on the mark, so
   * the row opens the Prüfansicht at it.
   */
  'piloti.work_done',
  /** Informational, operational tier: Piloti could not finish a woken turn on an Anmerkung (a delegation, a mention or an answer to its question); a stopped turn tells nobody. */
  'piloti.work_failed',
  /**
   * Actionable, operational tier: Piloti asked a question on an Anmerkung and
   * waits for a person (ADR-0106): the mark's responsible person, else the
   * person its turn acted for. Anchored on the mark. Resolved when that person
   * answers in the thread, and for everyone when the mark is closed.
   */
  'piloti.asks_you',
  /**
   * Actionable, operational tier: a stored proposal waits for the person it was
   * made for (ADR-0105). Anchored on the proposal; resolved when it is applied
   * or dismissed, by whoever decides it.
   */
  'piloti.proposal_waiting',
  /**
   * Actionable, operational tier: a reading of the project's documents has
   * finished and its suggestions wait for review (ADR-0111). Addressed to the
   * person whose upload or click started it, pointing at the project and
   * anchored on its intake, so a second reading folds into the same row.
   * Resolved when somebody finishes the review.
   */
  'piloti.intake_ready',
  /**
   * Informational, operational tier: Piloti compared a new Fassung with the one
   * it replaces, on its own (ADR-0130), and proposed marks where something
   * moved. Addressed to the person whose upload or link made the Fassung, in
   * whose name it ran; pointing at the new document and anchored on the first
   * mark, so the row opens the Prüfansicht there. A notice that found nothing
   * writes no row.
   */
  'piloti.revision_checked',
  /**
   * Actionable, operational tier: a colleague made the recipient the
   * Zuständige of an Anmerkung, or Piloti did in a colleague's name (ADR-0106).
   * Anchored on the mark. Resolved when someone else becomes responsible, and
   * for everyone when the mark is closed; made inert when it is deleted.
   */
  'annotation.assigned_to_you',
  /**
   * Informational, operational tier: news on an Anmerkung the recipient takes
   * part in (wrote, is responsible for, delegated or answered in): a reply, or
   * their own mark closed or reopened by someone else. One counted row per
   * mark; the people are derived when it happens, never stored.
   */
  'annotation.activity',
  /**
   * Actionable, operational tier: a colleague @mentioned the recipient in an
   * Anmerkung's text or in its thread, with the chat's own „@" picker. Anchored
   * on the mark. Resolved when the recipient answers in the thread, and for
   * everyone when the mark is closed; made inert when it is deleted.
   */
  'annotation.mentioned',
  /**
   * Informational, operational tier: a sort of a shelf's root (ADR-0121) has
   * read every file and proposed where each goes, and waits for its requester
   * to review it. Addressed to the requester only, anchored on the run, and
   * opens the shelf's files with the sort dialog. Informational: the dialog is
   * where the decision is made, and an unread row already counts in the badge.
   */
  'root_sort.ready',
  /**
   * Informational, operational tier: a sort of a shelf's root stopped on an
   * error (ADR-0121). Addressed to the requester only, anchored on the run,
   * and opens the shelf's files with the sort dialog, which holds the reason.
   */
  'root_sort.failed',
  /**
   * Actionable, operational tier: mail sent to a project's address waits for a
   * person to file it (ADR-0134). Every held mail is announced, whoever sent
   * it (RT-X1): to its sender when that is a verified member who may read the
   * project, otherwise to the project's managers. One row per recipient and
   * project, counted; it names the project and never the mail (no sender, no
   * subject), so a stranger's words never reach a push or a lock screen.
   * Resolved when the mails are decided or expire.
   */
  'inbound_mail.waiting',
] as const
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number]
