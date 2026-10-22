/**
 * Collaboration: sharing a resource, @-mentions with the agent hand-off, and the
 * inbox (ADR-0032…0035).
 *
 * Anything counted here carries explicit `…One` / `…Many` keys and the renderer
 * picks between them. That predates the plural blocks `src/i18n/translate.ts`
 * now understands (`{count, plural, one {…} other {…}}`), and these pairs are
 * left as they are because they are already correct — but a NEW counted string
 * belongs in one key with a plural block rather than in a new pair. What has not
 * changed is the reason both forms have to be written out: German and English
 * disagree about where the noun inflects, so a bare `{count}` in front of a noun
 * is a defect in one locale or both.
 */
export const collaboration = {
  /**
   * A chat shared with someone who can no longer read a folder it drew on
   * (ADR-0088). The title is neutral because the real one is model-written from
   * the chat, restricted content included; nothing here names a folder.
   */
  rightsLost: {
    neutralTitle: 'Shared chat',
    title: 'You no longer have the rights to view this chat',
    description:
      'Access to a folder this chat draws on has changed since it was shared. Ask someone who can read those folders, or your administrator.',
  },
  sharing: {
    title: 'Share',
    /** Button in the chat toolbar. */
    action: 'Share',
    close: 'Close',
    /** The link to the chat: it only opens for people who already have access. */
    link: {
      heading: 'Link',
      share: 'Share link',
      copy: 'Copy link',
      copied: 'Link copied',
      failed: 'The link could not be copied.',
      hint: 'The link opens the chat only for people who have access. Anyone who does not yet is invited above.',
      shareTitle: 'Chat in Piloti',
    },
    visibilityHeading: 'Who can see this',
    /** Screen-reader text while the sharing state is being fetched. */
    loading: 'Loading sharing settings…',
    /** Small label above the access chip inside the mobile thread menu. */
    audienceHeading: 'Audience',
    visibility: {
      private: 'Only me',
      privateHint: 'Just you, plus anyone you invite by name.',
      project: 'Everyone in this project',
      projectHint: 'Every member of this project can read and contribute.',
      organization: 'Everyone in the organization',
      organizationHint: 'Every member of your organization can read and contribute.',
      /** What narrowing away from a blanket rule costs, stated in the confirm. */
      narrowLoss: {
        project: 'Everyone in this project loses access to this conversation.',
        organization: 'Everyone in the organization loses access to this conversation.',
      },
    },
    /** The access chip shown wherever a resource is listed. */
    chip: {
      private: 'Private',
      project: 'Project',
      organization: 'Organization',
      sharedOne: 'Shared with 1 person',
      sharedMany: 'Shared with {count}',
      ariaLabel: 'Access: {label}',
    },
    peopleHeading: 'People with access',
    roles: {
      viewer: 'Can view',
      collaborator: 'Can contribute',
      owner: 'Owner',
    },
    /** Why someone has access — so access is never mysterious. */
    reasons: {
      creator: 'Created this',
      grant: 'Invited by {name}',
      grantUnknown: 'Invited',
      'visibility-project': 'Project member',
      'visibility-organization': 'Organization member',
    },
    invite: {
      label: 'Invite someone',
      placeholder: 'Search by name or email…',
      empty: 'Nobody left to invite.',
      /** A typed search that matched nobody — distinct from an exhausted list. */
      noResults: 'No match for “{query}”',
      submit: 'Invite',
      /** Shown on org members who are not in the project (spec SH-19). */
      needsProjectAccess: 'Not in this project yet',
      needsProjectAccessHint:
        'Add them to the project first. Sharing a chat never grants access to the project itself.',
      /**
       * Disabled row for someone who cannot read every folder the chat drew on
       * (ADR-0088). Never names the folder: the sharer may not be cleared for
       * it either, and the server's refusal stays the authority.
       */
      lacksFolderAccess: 'Has no access to a folder this chat draws on',
      lacksFolderAccessBadge: 'No access',
    },
    /** On the roster: someone still shared with who can no longer read what the chat drew on. */
    lostAccess: 'No longer has access',
    roleHeading: 'Access level',
    manageFor: 'Manage access: {name}',
    remove: 'Remove access',
    removeConfirm: 'Remove {name}?',
    removeConfirmHint: 'They lose access immediately. Anything they wrote stays in the conversation.',
    leave: 'Leave this conversation',
    leaveConfirm: 'Leave this conversation?',
    leaveConfirmHint: 'You lose access. Everyone else keeps theirs.',
    escalate: 'Take ownership',
    escalateConfirm: 'Take ownership?',
    escalateHint:
      'As a project admin you can take ownership of this conversation. This is recorded in the audit trail.',
    errors: {
      lastOwner: 'This conversation must keep at least one owner. Make someone else an owner first.',
      containerAccessRequired:
        'That person is not a member of this project yet. Add them to the project first.',
      organizationMembershipRequired: 'That person is not a member of this organization.',
      rateLimited: 'Too many sharing changes. Please wait a few minutes and try again.',
      rosterFull: 'This conversation already has the maximum number of people. Remove someone before inviting more.',
      restrictedContent:
        '{name} may not read every folder with restricted access this conversation draws on, so it cannot be shared with them.',
      restrictedContentFolders:
        '{name} may not read every folder with restricted access this conversation draws on ({folders}), so it cannot be shared with them.',
      restrictedContentSomeone:
        'This person may not read every folder with restricted access this conversation draws on, so it cannot be shared with them.',
      restrictedContentSelf:
        'You may not read every folder with restricted access this conversation draws on, so you cannot take it over.',
      restrictedContentProject:
        'This conversation draws on a folder with restricted access, so it cannot be made visible to the whole project. Share it with individual people who may read that folder instead.',
      crossProjectContent:
        '{name} may not open every other project this conversation draws on, so it cannot be shared with them.',
      crossProjectContentSomeone:
        'This person may not open every other project this conversation draws on, so it cannot be shared with them.',
      crossProjectContentSelf:
        'You may not open every other project this conversation draws on, so you cannot take it over.',
      crossProjectContentProject:
        'This conversation draws on content from other projects, so it cannot be made visible to the whole project. Share it with individual people who may open those projects instead.',
      loadFailed: 'Sharing settings could not be loaded.',
      saveFailed: 'That change could not be saved.',
      tryAgain: 'Try again',
      /**
       * The failure alert's own dismiss control. Distinct from `sharing.close`
       * (the dialog's): both sit inside the same dialog, and two controls with
       * the accessible name "Close" cannot be told apart by name alone.
       */
      dismiss: 'Dismiss this message',
    },
    resourceTypes: {
      conversation: 'Conversation',
      document: 'File',
    },
    /**
     * The "who can reach this chat" overview — the answer to the question the
     * participant strip raises when you click it.
     */
    overview: {
      title: 'Who has access',
      openLabel: 'View who has access',
      countOne: '1 person',
      countMany: '{count} people',
      ownersHeading: 'Owners',
      collaboratorsHeading: 'Can contribute',
      viewersHeading: 'Can view',
      you: 'you',
      /** Sits under the heading, restating the blanket rule in plain words. */
      viaVisibilityProject: 'Everyone in this project can also read and contribute.',
      viaVisibilityOrganization: 'Everyone in your organization can also read and contribute.',
      viaVisibilityPrivate: 'Only the people listed here.',
      namedHeading: 'Invited by name',
      derivedMore: 'and {count} more',
    },
  },

  mentions: {
    /** The `@` picker inside the composer. */
    picker: {
      label: 'Mention someone',
      placeholder: 'Mention a colleague…',
      empty: 'Nobody to mention here.',
      noResults: 'No match for “{query}”',
      loading: 'Loading people…',
      participantsHeading: 'In this conversation',
      othersHeading: 'Elsewhere in this project',
      /** The agent as a mention target — how you bring it back into a waiting thread. */
      agentName: 'Piloti',
      agentHint: 'Ask the assistant',
      needsInvite: 'Will be invited',
      needsInviteHint: '{name} is not in this conversation yet and will be invited.',
      /**
       * The same fact WITHOUT the name, for the picker row — which prints the
       * person's name on the line directly above, so interpolating it again read
       * "Sabine Gruber / Sabine Gruber ist noch nicht in diesem Chat…". Keep the
       * named variant for surfaces that mention someone out of context.
       */
      needsInviteHintShort: 'Not in this conversation yet — will be invited.',
      cannotInvite: 'Only an owner can bring new people into this conversation.',
      /** Screen-reader + footer affordances for the combobox. */
      resultsAria: 'People you can mention',
      keyboardHint: '↑↓ to choose · ↵ to insert · Esc to close',
      badgeAgent: 'Assistant',
      /** The inserted token in the composer. */
      chipRemove: 'Remove mention of {name}',
    },
    /**
     * The composer's state once a human is tagged. Two keys because this i18n
     * layer has interpolation but NO plural rules: German inflects the verb
     * ("wird gefragt" / "werden gefragt"), so joining names into the singular
     * string produced "Anna Berger, Tobias Kern wird gefragt" — wrong grammar in
     * the primary product language.
     */
    composerHint: 'Piloti will stay quiet — {name} is being asked.',
    composerHintMany: 'Piloti will stay quiet — {names} are being asked.',
    /**
     * The composer's always-visible statement of WHO receives this message.
     *
     * This exists because the routing was not guessable from the UI: after a
     * colleague answers, is the next message a question for Piloti or a remark to
     * them? Rather than teach a rule, the composer says it. Present in every
     * state, so "Piloti is next" is never an inference.
     */
    addressee: {
      /** Default, and where a thread always returns. */
      /** One or more humans tagged in the message being written. */
      toPerson: 'Goes to {name}',
      toPeople: 'Goes to {names}',
      /**
       * While the thread is waiting on a named person, a plain message is a
       * remark to the people in it — not a question for the agent.
       */
      toThread: 'Goes to everyone in the chat',
      /** How to get back to the agent from the waiting state. */
      agentHint: 'Type @Piloti to ask Piloti',
      /**
       * The only thing that teaches `@` exists. Sits on the line that already
       * states the routing, because "this goes to Piloti" is exactly when somebody
       * might want it to go to a colleague instead.
       */
      mentionSomeone: 'mention a colleague',
      ariaLabel: 'Recipient of this message: {label}',
    },
    /**
     * The panel behind a mention pill in message text. A tag is a reference to a
     * person, and in a project of forty a name often does not place them — so the
     * reference answers "who is that?" where it is asked, like a citation does.
     */
    peek: {
      agentRole: 'Assistant in this project',
      inConversation: 'Can read this conversation',
      /** The one that matters: a tag that reaches nobody looks identical otherwise. */
      notInConversation: 'Not in this conversation',
    },
    notePlaceholder: 'What would you like them to look at? (optional)',
    /**
     * When the agent answers a message that tags nobody (ADR-0036).
     *
     * This is a permanent one-liner rather than a dismissible notice, because it
     * is simultaneously the explanation ("why didn't Piloti answer that?") and the
     * control. A routing rule the reader cannot see is a rule they will be
     * surprised by, and the surprise arrives long after any banner was dismissed.
     */
    engagement: {
      mentionLabel: 'Piloti answers when mentioned',
      mentionHint:
        'Several of you are talking here, so a plain message goes to everyone in the chat.',
      switchToAsk: 'Let Piloti answer everything',
      /**
       * The OFFER, shown while the thread is still in `ask`. Phrased as a
       * question about the future, never as a report of a change — because no
       * change happened, and `ask` remains the default however many people are
       * here.
       */
      offerHint: 'Several of you are talking here. Should Piloti wait to be mentioned?',
      switchToMention: 'Answer only when mentioned',
      failed: 'That could not be changed.',
    },
    /** The banner every participant sees while the thread waits (spec MN-8). */
    awaiting: {
      one: 'Waiting for {name}',
      many: 'Waiting for {names}',
      /** Explains the silence, so it never reads as a bug. */
      hint: 'Piloti is holding off until someone answers.',
      askedBy: 'Asked by {name}',
      since: 'since {time}',
      awaitingYou: 'Your input was requested',
      awaitingYouHint: 'Answer in the conversation, or release the wait.',
      release: 'Continue without waiting',
      releaseOne: 'Continue without {name}',
      /**
       * The accessible name of a per-person release button whose name is not
       * unique in the list — the same colleague can be waited on twice. Only the
       * start of the wait tells the two apart, so only it is added.
       */
      releaseOneSince: 'Continue without {name} — waiting since {time}',
      released: 'The wait was released.',
      askAgent: 'Ask Piloti instead',
      /**
       * Shown only to the person who was asked. Being asked something you cannot
       * answer without more information is the most common outcome, and typing a
       * plain reply is the one move that goes wrong: it reads as an answer, ends
       * the wait, and hands the thread back to Piloti mid-conversation. This
       * pre-fills `@{asker}` so the question travels back to the person who can
       * answer it and the thread keeps waiting — on them, correctly.
       */
      askBack: 'Ask {name} back',
    },
    /**
     * The hand-BACK offer, shown in the thread at the moment a wait resolves.
     *
     * `awaiting.askAgent` above lives inside the banner, which vanishes the instant
     * the colleague answers — so exactly when the thread holds its most valuable
     * context there was no affordance at all, and the user had to already know that
     * typing `@Piloti` is the way on. This is that affordance, and it PRE-FILLS the
     * composer rather than firing a turn: every message in a shared thread stays
     * honestly authored, and a turn with no question of its own produces mush.
     */
    handback: {
      offer: '{name} replied — let Piloti carry on?',
      offerMany: '{names} replied — let Piloti carry on?',
      action: 'Let Piloti carry on',
      dismiss: 'Not now',
      /** Inserted after `@Piloti ` into the composer, for the user to edit or send. */
      prefill: '— please carry on from here.',
    },
    errors: {
      inviteRequiresOwner:
        'You can only mention people who are already in this conversation. Ask an owner to invite {name}.',
      containerAccessRequired: '{name} is not a member of this project.',
      rateLimited: 'Too many mentions. Please wait a few minutes.',
      releaseFailed: 'The wait could not be released.',
    },
  },

  inbox: {
    title: 'Inbox',
    /** Nav entry + the count badge. */
    navLabel: 'Inbox',
    badgeAria:
      '{count, plural, one {# item needs} other {# items need}} your attention',
    badgeAriaOne: '1 item needs your attention',
    subtitle: 'Requests and updates from your team.',
    /** "Needs me" is what waits on you (an open request); "Unread" what you have not opened. */
    filters: {
      needsMe: 'Needs me',
      unread: 'Unread',
      all: 'All',
      archived: 'Archived',
      ariaLabel: 'Filter inbox',
    },
    markAllRead: 'Mark all as read',
    archive: 'Archive',
    undo: 'Undo',
    /** The short form for a phone, where the long one breaks the row. */
    markAllReadShort: 'All read',
    archived: 'Archived',
    unarchive: 'Restore',
    unarchived: 'Restored',
    markRead: 'Mark as read',
    markUnread: 'Mark as unread',
    moreActions: 'More actions',
    loadMore: 'Load older items',
    loadingMore: 'Loading older items …',
    loadMoreFailed: 'Older items could not be loaded.',
    /** A row about an annotation: go there, and for a request answer or resolve it right here. */
    mark: {
      open: 'Go to annotation',
      /** A row about new marks („Anna set 15 annotations“): it opens the review at the newest. */
      openMany: 'To the annotations',
      answerInReview: 'Answer in the review',
      reply: 'Reply',
      replyLabel: 'Your reply to annotation {related}',
      replyLabelNoNumber: 'Your reply to the annotation',
      send: 'Send',
      cancel: 'Cancel',
      sent: 'Reply sent.',
      sentPilotiNotAsked: 'Reply sent. Piloti reads it only once you ask it with @Piloti in the review.',
      resolve: 'Resolve',
      resolved: 'Marked as resolved.',
      conflict: 'Someone changed the annotation first. Open it to see where it stands.',
      failed: 'That did not work. Nothing has changed.',
    },
    /** Item states. */
    resolved: 'Answered',
    /** An item whose target the recipient can no longer reach (spec IB-13). */
    inert: 'No longer available',
    /**
     * The BODY of a redacted row — a complete sentence, because the templated
     * "in {subject}" needs a real title and the placeholder read as nonsense inside
     * it. Says the same thing the chip does, in the position the body occupies,
     * for whatever the row points at: a chat, a document, a mark.
     */
    bodyUnavailable: 'This is no longer available to you.',
    /**
     * The next move on a new revision filed under another name: see the two side
     * by side. Opens the file preview with the comparison open.
     */
    compareRevisions: 'Compare revisions',
    compareRevisionsLabel: 'Compare the new and the older revision of “{subject}”',
    empty: {
      needsMeTitle: 'Nothing needs you',
      needsMeDescription:
        'When someone mentions you, assigns you an annotation or Piloti asks you something, it appears here.',
      unreadTitle: 'All caught up',
      unreadDescription: 'What is new stays here until you open it.',
      allTitle: 'Your inbox is empty',
      allDescription: 'News from your team and from Piloti appears here.',
      archivedTitle: 'Nothing archived',
      archivedDescription: 'What you archive, you find here again.',
    },
    errors: {
      loadFailed: 'Your inbox could not be loaded.',
      /**
       * A refused ACTION, which is a different fact from a failed load — and the
       * commonest cause is benign (a row a second tab already archived). Kept
       * separate so a working list is never replaced by a load-failure sentence.
       *
       * "Unchanged", not "up to date": the refusal path deliberately does not
       * re-read the list, so the rows on screen are exactly the ones that were
       * there before — which in the commonest case (a row another tab already
       * archived) is precisely NOT up to date.
       */
      actionFailed: 'That action could not be completed. Your inbox is unchanged.',
    },
    /**
     * One entry per registered item type. Adding a type means adding a `title`
     * and `body` here — that plus a registry entry is the whole cost (spec IB-6).
     */
    types: {
      /** `titleResolved` once the question is answered: the row is history then. */
      mentionRequested: {
        title: '{actor} asked for your input',
        titleResolved: '{actor}’s question has been answered',
        titleResolvedNoActor: 'The question has been answered',
        body: 'in {subject}',
      },
      /**
       * "Replied", not "answered". Even with `asked_back` split out, a
       * contribution can be "I'll look at it tomorrow" — true of every one of
       * them is that the person replied. German already says exactly this
       * ("hat geantwortet"); English "answered" was the one over-claim.
       */
      mentionAnswered: {
        title: '{actor} replied',
        titleNoActor: 'Your question was answered',
        body: 'in {subject}',
      },
      conversationShared: {
        title: '{actor} shared a conversation with you',
        body: '{subject}',
      },
      /** Who wrote is in the title, and the chat too, so there is no second line. */
      conversationActivity: {
        titleOne: '{actor} wrote in “{subject}”',
        titleOneNoActor: 'New message in “{subject}”',
        titleMany: '{count} new messages in “{subject}”, latest from {actor}',
        titleManyNoActor: '{count} new messages in “{subject}”',
        /**
         * Read, with nothing new since — the counter has been spent. So it must
         * not say "new": this row is history, and a group of twenty the reader
         * has just been through was announcing fresh mail at them.
         */
        titleNone: 'Messages in “{subject}”',
        /** The chat is no longer available to the reader: no name to put in quotes. */
        titleRedacted: 'Messages in a chat',
      },
      /**
       * The operational alert (ADR-0042). No `{actor}`: it is system-generated,
       * and the row's actor fallback ("Someone") would put an imaginary
       * colleague's name on a message from the platform.
       *
       * The numbers live in the BODY and the title states the condition, so the
       * title still reads correctly for a row whose target was redacted (the
       * body is replaced wholesale in that state). `{subject}` is the share of
       * quota in use — a locale-neutral token like `82%`, formatted server-side,
       * so this sentence is the only thing that needs translating.
       *
       * "ask whoever runs Piloti for you" rather than "your administrator": the
       * quota is set by the PLATFORM operator and deliberately cannot be raised
       * from inside the tenant (ADR-0042), so pointing an org admin at their own
       * settings would send them looking for a control that is not there.
       */
      // Platform tier: a member sent product feedback. {subject} is the
      // organization it came from; the excerpt below the title is the message.
      feedbackSubmitted: {
        title: '{actor} sent feedback',
        body: 'from {subject} — open it to triage.',
      },
      // The team answered the reader's own report in PostHog. {subject} is the
      // start of the report, {related} whoever answered last.
      feedbackReplied: {
        title: 'The Piloti team answered your feedback',
        titleMany: '{count} new replies to your feedback',
        titleRelated: '{related} from the Piloti team answered your feedback',
        titleRelatedMany: '{count} new replies to your feedback, latest from {related}',
        body: 'On “{subject}” — read and reply in My feedback.',
        bodyNoSubject: 'Read and reply in My feedback.',
      },
      storageQuotaWarning: {
        title: 'Your organization is running out of storage',
        body: '{subject} of the storage quota is in use. Once it is full, uploads will start failing — delete documents you no longer need, or ask whoever runs Piloti for you to raise the quota.',
      },
      /**
       * A row whose type this build does not know — written by a newer deploy, or
       * read across a rollback. Deliberately vague: claiming more than "something
       * happened" would be inventing a meaning nobody here has.
       */
      documentAssigned: {
        title: '{actor} assigned {subject} to you',
        body: 'You are responsible for this file.',
      },
      // ADR-0086: everything an upload brought in has been read. {subject}
      // is where it went (a project name, "Büroablage" or "Chat").
      uploadCompleted: {
        title: 'Your upload has been read',
        body: '{subject}: open the summary to see what arrived.',
        bodyNoSubject: 'Open the summary to see what arrived.',
      },
      // ADR-0086: the content check held files back.
      // {subject} is the newest held file; the variant says what it was held
      // for (never the value found). `transcript`: a vision model read the
      // scanned pages it was found in, so no "no model" claim there.
      documentQuarantined: {
        titleOne: '1 file is waiting in quarantine',
        titleMany: '{count} files are waiting in quarantine',
        titleNone: 'Files in quarantine',
        body: '“{subject}”: no model has read it. Review it: allow or delete.',
        bodyMany: 'Latest: “{subject}”. Review them in quarantine: allow or delete.',
        bodyNoSubject: 'No model has read them. Review them: allow or delete.',
        variants: {
          term: {
            body: '“{subject}” contains a term from your office’s list of sensitive data. No model has read it. Allow or delete?',
            bodyMany: 'Latest: “{subject}”, with a term from the list of sensitive data. Review them: allow or delete.',
          },
          iban: {
            body: '“{subject}” contains an IBAN. No model has read it. Allow or delete?',
            bodyMany: 'Latest: “{subject}”, with an IBAN. Review them: allow or delete.',
          },
          at_svnr: {
            body: '“{subject}” contains a social security number. No model has read it. Allow or delete?',
            bodyMany: 'Latest: “{subject}”, with a social security number. Review them: allow or delete.',
          },
          credit_card: {
            body: '“{subject}” contains a card number. No model has read it. Allow or delete?',
            bodyMany: 'Latest: “{subject}”, with a card number. Review them: allow or delete.',
          },
          transcript: {
            body: '“{subject}”: found in the text of scanned pages a vision model read; no other model saw them. Allow or delete?',
            bodyMany: 'Latest: “{subject}”, found in the text of scanned pages. Review them: allow or delete.',
          },
        },
      },
      documentReleaseRequested: {
        title: '{actor} asks you to review “{subject}”',
        body: 'The file is in quarantine. Look at it, then allow or delete it.',
        // What the file was held for, as for documentQuarantined.
        variants: {
          term: { body: 'It contains a term from the list of sensitive data. Look at it, then allow or delete it.' },
          iban: { body: 'It contains an IBAN. Look at it, then allow or delete it.' },
          at_svnr: { body: 'It contains a social security number. Look at it, then allow or delete it.' },
          credit_card: { body: 'It contains a card number. Look at it, then allow or delete it.' },
          transcript: { body: 'Found in the text of scanned pages a vision model read. Look at it, then allow or delete it.' },
        },
      },
      // The row lands on the run itself (its block in the thread, else the
      // task), where the result and the reason are.
      taskRunCompleted: {
        title: 'Piloti finished “{subject}”',
        body: 'Open it to see the result.',
      },
      // An Outlook archive was imported. {subject} is the archive's file name.
      mailImportCompleted: {
        title: '“{subject}” has been imported',
        body: 'Piloti filed the emails and their attachments in the project under E-Mail-Import.',
      },
      mailImportFailed: {
        title: 'The import of “{subject}” stopped',
        body: 'What was imported until then stays in the project. The import list under Files gives the reason.',
      },
      taskRunFailed: {
        title: 'Piloti could not finish “{subject}”',
        body: 'Open it to see what went wrong.',
      },
      // A run stopped to ask its requester something (ADR-0062, `wartet`). The
      // body says where the answer goes, because the run resumes nowhere else.
      taskRunWaiting: {
        title: 'Piloti has a question about “{subject}”',
        body: 'Answer it in the thread and Piloti carries on.',
      },
      // A revision of a document is waiting for a decision (ADR-0054).
      // {subject} is the document, {actor} whoever submitted it.
      documentReviewRequested: {
        title: '{actor} asked you to review {subject}',
        body: 'A new revision is waiting for your approval.',
      },
      // A newer revision (Fassung) of a document you follow, as a sentence about
      // the person who uploaded it. {actor} is that person, {subject} the
      // document you follow (without its extension). What changed is the
      // excerpt below; only without one does `bodyNoExcerpt` say where to look.
      // `titleNoActor` when nobody in particular did it.
      documentNewRevision: {
        title: '{actor} uploaded a new revision of “{subject}”',
        titleNoActor: 'New revision of “{subject}”',
        bodyNoExcerpt: 'Open the revision to see what changed.',
        // Open annotations the new revision leaves behind: {marks} how many,
        // {revision} which revision of the same document; `…_earlier` when they
        // sit on several, or another document was replaced.
        variants: {
          mark: { body: 'Check 1 open annotation from revision {revision}' },
          marks: { body: 'Check {marks} open annotations from revision {revision}' },
          mark_earlier: { body: 'Check 1 open annotation from the previous revision' },
          marks_earlier: { body: 'Check {marks} open annotations from the previous revision' },
        },
      },
      // What Piloti did on an Anmerkung, told to the person whose act woke it:
      // who delegated the mark, mentioned Piloti in it, or answered Piloti's
      // Rückfrage (ADR-0106). {related} is the mark's running number,
      // {subject} the document; the excerpt below is what the mark says. No
      // {actor}: that was Piloti. `titleRelatedNoSubject` when the document
      // could not be named. Same words as the review view: annotation, thread,
      // delegate.
      // Piloti compared a new revision with the previous one on its own
      // (ADR-0130) and proposed marks. {subject} the new revision, {related}
      // the one compared, {marks} how many proposals. No {actor}: Piloti did it.
      pilotiRevisionChecked: {
        title: 'Piloti compared the new revision “{subject}”',
        titleRelated: 'Piloti compared “{subject}” with “{related}”',
        body: 'Proposals on the document, not yet accepted.',
        variants: {
          one: { body: '1 place marked as a proposal, not yet accepted.' },
          many: { body: '{marks} places marked as proposals, not yet accepted.' },
          // The check of a new document against the project's others, not a comparison with a previous revision.
          check_one: {
            title: 'Piloti checked the new document “{subject}” against your other documents',
            body: '1 place marked as a proposal, not yet accepted.',
          },
          check_many: {
            title: 'Piloti checked the new document “{subject}” against your other documents',
            body: '{marks} places marked as proposals, not yet accepted.',
          },
        },
      },
      pilotiWorkDone: {
        title: 'Piloti worked on an annotation for you',
        titleRelated: 'Piloti worked on annotation {related} in “{subject}” for you',
        titleRelatedNoSubject: 'Piloti worked on annotation {related} for you',
        body: 'Read the answer in the annotation’s thread.',
        // The delegation ended: Piloti handed the annotation back.
        variants: {
          assigned: { body: 'The annotation is back with you.' },
        },
      },
      // Piloti could not. `variants` say why, by the class of the wake's
      // stored reason (`lib/annotations/wake-end-reason.ts`), and what the
      // person can do about it; `body` is for a row stored before the reason
      // was kept.
      pilotiWorkFailed: {
        title: 'Piloti could not work on an annotation',
        titleRelated: 'Piloti could not work on annotation {related} in “{subject}”',
        titleRelatedNoSubject: 'Piloti could not work on annotation {related}',
        body: 'Open the annotation: ask Piloti again or work on it yourself.',
        variants: {
          budget: {
            body: 'The usage budget is used up. Whoever manages your organization can raise it under Organization → Usage & budgets; then ask Piloti again.',
          },
          busy: {
            body: 'Piloti did not get to it in time because too much was going on. Ask Piloti again later.',
          },
          access: {
            body: 'Piloti could not sign in on your behalf. Ask Piloti again, or work on the annotation yourself.',
          },
          error: {
            body: 'The work broke off before there was an answer. Ask Piloti again, or work on the annotation yourself.',
          },
        },
      },
      // Piloti asked a question and waits for a person: the mark's assignee,
      // or the person it worked for. The question is the excerpt below.
      pilotiAsksYou: {
        title: 'Piloti has a question for you on an annotation',
        titleRelated: 'Piloti has a question for you on annotation {related} in “{subject}”',
        titleRelatedNoSubject: 'Piloti has a question for you on annotation {related}',
        body: 'Piloti is waiting for your answer. Reply in the annotation’s thread.',
        // `answerIn: 'review'`: nothing wakes Piloti on its own; the review
        // asks it with the answer, so nobody is waiting here.
        bodyInReview: 'Answer in the review. From there your answer reaches Piloti.',
      },
      // A proposal the server holds (ADR-0105), for the person Piloti made it
      // for. `variants` name what it changes (a file operation by its verb,
      // the rest by kind: `PROPOSAL_NOTICE_VARIANTS`); the excerpt below names
      // the files, the note or the change. Words as on the card.
      pilotiProposalWaiting: {
        title: 'Piloti has a proposal for you',
        // Where the proposal waits, by what the row points at: the chat it came
        // from, else the file under Files (`bodyProject`) or in the office
        // filing (`bodyOrganization`).
        body: 'The proposal is in the chat. Apply or dismiss it there; nothing changes until then.',
        bodyProject: 'The proposal waits on the file under Files. Apply or dismiss it there; nothing changes until then.',
        bodyOrganization: 'The proposal waits on the file in the office filing. Apply or dismiss it there; nothing changes until then.',
        variants: {
          move: { title: 'Piloti suggests a new place for files' },
          rename: { title: 'Piloti suggests a rename' },
          create_folder: { title: 'Piloti suggests a new folder' },
          assign: { title: 'Piloti suggests an assignment' },
          memory: { title: 'Piloti would like to remember a note' },
          project_profile: { title: 'Piloti suggests a change to the project context' },
          operation: { title: 'Piloti suggests an action' },
        },
      },
      // Piloti read a project's documents and suggested values for its profile
      // (ADR-0111). {subject} is the project's name, {related} the number of
      // questions that decide the building class; absent when there are none,
      // and `title` is read. Piloti's summary is the excerpt below.
      pilotiIntakeReady: {
        title: 'Piloti has read the documents of “{subject}”',
        titleRelated: 'Piloti has read the documents of “{subject}” – questions: {related}',
        body: 'Review the suggestions and confirm what is right.',
        // The reading did not finish (stopped, never started, no answer for
        // too long). Whoever left the page learns it here.
        variants: {
          failed: {
            title: 'Piloti could not finish reading the documents of “{subject}”',
            body: 'What Piloti found until then stays. Open the setup and start the reading again.',
          },
        },
      },
      // A colleague made you responsible for an annotation, or Piloti did on
      // their behalf (`variants.piloti`, where {actor} is the person Piloti
      // worked for). {related} is the annotation's number, {subject} the
      // document; the excerpt is what the annotation says.
      annotationAssigned: {
        // One notification for many rows at once (the morning's reminders, a
        // hand-over in one go): the count in the title, how many of what
        // under it, the most pressing first.
        pushFold: {
          title: '{count, plural, one {# annotation} other {# annotations}} for you',
          parts: {
            overdue: '{count} overdue',
            due_soon: '{count} due today or tomorrow',
            assigned: '{count} assigned',
            redated: '{count, plural, one {# with a new due date} other {# with new due dates}}',
            other: '{count} more',
          },
        },
        title: '{actor} assigned you an annotation',
        titleRelated: '{actor} assigned you annotation {related} in “{subject}”',
        titleRelatedNoSubject: '{actor} assigned you annotation {related}',
        body: 'You are responsible for it. Answer in the thread or resolve the annotation.',
        // With a date: {due} is the annotation's date.
        bodyDue: 'You are responsible for it, by {due}. Answer in the thread or resolve the annotation.',
        // `due…`: someone set, moved or removed the date (`…_piloti`: Piloti for
        // {actor}). `due_soon` / `overdue`: the daily reminder, without {actor},
        // in the annotation's same row.
        variants: {
          piloti: {
            title: 'Piloti assigned you an annotation for {actor}',
            titleRelated: 'Piloti assigned you annotation {related} in “{subject}” for {actor}',
            titleRelatedNoSubject: 'Piloti assigned you annotation {related} for {actor}',
          },
          due: {
            title: '{actor} set the date of an annotation to {due}',
            titleRelated: '{actor} set the date of annotation {related} in “{subject}” to {due}',
            titleRelatedNoSubject: '{actor} set the date of annotation {related} to {due}',
          },
          due_cleared: {
            title: '{actor} removed the date of an annotation',
            titleRelated: '{actor} removed the date of annotation {related} in “{subject}”',
            titleRelatedNoSubject: '{actor} removed the date of annotation {related}',
          },
          due_piloti: {
            title: 'Piloti set the date of an annotation to {due} for {actor}',
            titleRelated: 'Piloti set the date of annotation {related} in “{subject}” to {due} for {actor}',
            titleRelatedNoSubject: 'Piloti set the date of annotation {related} to {due} for {actor}',
          },
          due_cleared_piloti: {
            title: 'Piloti removed the date of an annotation for {actor}',
            titleRelated: 'Piloti removed the date of annotation {related} in “{subject}” for {actor}',
            titleRelatedNoSubject: 'Piloti removed the date of annotation {related} for {actor}',
          },
          due_soon: {
            title: 'An annotation is due on {due}',
            titleRelated: 'Annotation {related} in “{subject}” is due on {due}',
            titleRelatedNoSubject: 'Annotation {related} is due on {due}',
          },
          overdue: {
            title: 'An annotation was due on {due}',
            titleRelated: 'Annotation {related} in “{subject}” was due on {due}',
            titleRelatedNoSubject: 'Annotation {related} was due on {due}',
            bodyDue: 'You are responsible for it, and the date has passed. Answer in the thread, resolve the annotation or agree on a new date.',
          },
        },
      },
      // News on an annotation you take part in: one counted row per annotation,
      // the newest reply as the excerpt. `variants` for your annotation that
      // someone else resolved, dismissed or reopened; then the excerpt is what
      // it says.
      // Who replied is in the title; `…NoActor` when it was Piloti or nobody in particular.
      annotationActivity: {
        // One notification for many rows at once (someone resolves 15 of your
        // annotations): counted per row, so per annotation, new annotations per document.
        pushFold: {
          title: '{count, plural, one {# update} other {# updates}} on annotations',
          parts: {
            reply: '{count, plural, one {# with a new reply} other {# with new replies}}',
            resolved: '{count} resolved',
            dismissed: '{count} dismissed',
            reopened: '{count} reopened',
            created: '{count, plural, one {# document with new annotations} other {# documents with new annotations}}',
            other: '{count} more',
          },
        },
        title: '{actor} replied on an annotation',
        titleNoActor: 'New reply on an annotation',
        titleRelated: '{actor} replied on annotation {related} in “{subject}”',
        titleRelatedNoActor: 'New reply on annotation {related} in “{subject}”',
        titleRelatedMany: '{count} new replies on annotation {related} in “{subject}”, latest from {actor}',
        titleRelatedManyNoActor: '{count} new replies on annotation {related} in “{subject}”',
        titleRelatedNone: 'Replies on annotation {related} in “{subject}”',
        titleRelatedNoSubject: '{actor} replied on annotation {related}',
        titleRelatedNoSubjectNoActor: 'New reply on annotation {related}',
        titleRelatedNoSubjectMany: '{count} new replies on annotation {related}, latest from {actor}',
        titleRelatedNoSubjectManyNoActor: '{count} new replies on annotation {related}',
        titleRelatedNoSubjectNone: 'Replies on annotation {related}',
        variants: {
          resolved: {
            title: '{actor} resolved an annotation',
            titleRelated: '{actor} resolved annotation {related} in “{subject}”',
            titleRelatedNoSubject: '{actor} resolved annotation {related}',
          },
          dismissed: {
            title: '{actor} dismissed an annotation',
            titleRelated: '{actor} dismissed annotation {related} in “{subject}”',
            titleRelatedNoSubject: '{actor} dismissed annotation {related}',
          },
          reopened: {
            title: '{actor} reopened an annotation',
            titleRelated: '{actor} reopened annotation {related} in “{subject}”',
            titleRelatedNoSubject: '{actor} reopened annotation {related}',
          },
          // New annotations on a document you are responsible for or uploaded:
          // one counted row per document and per person. {related} is the
          // newest, the excerpt what it says. Without {related} and excerpt:
          // the newest was deleted, and the row counts the rest. "NoActor":
          // the person is no longer in the directory.
          created: {
            title: '{actor} added an annotation',
            titleNoActor: 'An annotation was added',
            titleOne: '{actor} added an annotation in “{subject}”',
            titleOneNoActor: 'An annotation was added in “{subject}”',
            titleMany: '{actor} added {count} annotations in “{subject}”',
            titleManyNoActor: '{count} new annotations in “{subject}”',
            titleNone: '{actor} added annotations in “{subject}”',
            titleNoneNoActor: 'New annotations in “{subject}”',
            titleRelated: '{actor} added annotation {related} in “{subject}”',
            titleRelatedNoActor: 'Annotation {related} was added in “{subject}”',
            titleRelatedMany: '{actor} added {count} annotations in “{subject}”',
            titleRelatedManyNoActor: '{count} new annotations in “{subject}”',
            titleRelatedNone: '{actor} added annotations in “{subject}”',
            titleRelatedNoneNoActor: 'New annotations in “{subject}”',
            titleRelatedNoSubject: '{actor} added annotation {related}',
            titleRelatedNoSubjectNoActor: 'Annotation {related} was added',
            titleRelatedNoSubjectMany: '{actor} added {count} annotations',
            titleRelatedNoSubjectManyNoActor: '{count} new annotations',
            titleRelatedNoSubjectNone: '{actor} added annotations',
            titleRelatedNoSubjectNoneNoActor: 'New annotations',
            bodyMany: 'The newest is annotation {related}.',
            bodyNoExcerpt: 'One of these annotations has since been deleted.',
          },
          // Piloti added them for {actor}: {actor} asked, or took over
          // Piloti's proposal. A proposal nobody took over tells nobody.
          created_piloti: {
            title: 'Piloti added an annotation for {actor}',
            titleNoActor: 'Piloti added an annotation',
            titleOne: 'Piloti added an annotation in “{subject}” for {actor}',
            titleOneNoActor: 'Piloti added an annotation in “{subject}”',
            titleMany: 'Piloti added {count} annotations in “{subject}” for {actor}',
            titleManyNoActor: 'Piloti added {count} annotations in “{subject}”',
            titleNone: 'Piloti added annotations in “{subject}” for {actor}',
            titleNoneNoActor: 'Piloti added annotations in “{subject}”',
            titleRelated: 'Piloti added annotation {related} in “{subject}” for {actor}',
            titleRelatedNoActor: 'Piloti added annotation {related} in “{subject}”',
            titleRelatedMany: 'Piloti added {count} annotations in “{subject}” for {actor}',
            titleRelatedManyNoActor: 'Piloti added {count} annotations in “{subject}”',
            titleRelatedNone: 'Piloti added annotations in “{subject}” for {actor}',
            titleRelatedNoneNoActor: 'Piloti added annotations in “{subject}”',
            titleRelatedNoSubject: 'Piloti added annotation {related} for {actor}',
            titleRelatedNoSubjectNoActor: 'Piloti added annotation {related}',
            titleRelatedNoSubjectMany: 'Piloti added {count} annotations for {actor}',
            titleRelatedNoSubjectManyNoActor: 'Piloti added {count} annotations',
            titleRelatedNoSubjectNone: 'Piloti added annotations for {actor}',
            titleRelatedNoSubjectNoneNoActor: 'Piloti added annotations',
            bodyMany: 'The newest is annotation {related}.',
            bodyNoExcerpt: 'One of these annotations has since been deleted.',
          },
        },
      },
      // A colleague @mentioned you on an annotation or in its thread, as in
      // the chat. {actor} is them, {related} the annotation's number,
      // {subject} the document; the excerpt is the text that mentions you.
      annotationMentioned: {
        title: '{actor} mentioned you in an annotation',
        titleRelated: '{actor} mentioned you in annotation {related} in “{subject}”',
        titleRelatedNoSubject: '{actor} mentioned you in annotation {related}',
        body: 'Answer in the annotation’s thread.',
      },
      // A sort of a shelf's root (ADR-0121) has proposed where its files go.
      // {subject} is the project; the office filing names no place, so its
      // variant says it. {count} is the files it proposes to move.
      rootSortReady: {
        titleOne: 'The sort of “{subject}” is ready to review: 1 file',
        titleMany: 'The sort of “{subject}” is ready to review: {count} files',
        titleNone: 'The sort of “{subject}” is ready to review',
        title: 'The sort of “{subject}” is ready to review',
        body: 'Look at where each file should go. Nothing moves until you apply it.',
        variants: {
          office: {
            titleOne: 'The sort of the office filing is ready to review: 1 file',
            titleMany: 'The sort of the office filing is ready to review: {count} files',
            titleNone: 'The sort of the office filing is ready to review',
            title: 'The sort of the office filing is ready to review',
          },
        },
      },
      inboundMailWaiting: {
        titleOne: 'A mail to “{subject}” is waiting to be filed',
        titleMany: '{count} mails to “{subject}” are waiting to be filed',
        title: 'Mails to “{subject}” are waiting to be filed',
        body: 'None of it is in the project until someone files it.',
        variants: {
          // Domain not verified, or sent automatically (a newsletter, a list).
          unconfirmed: {
            body: 'Some of them come from a domain that is not verified, or were sent automatically.',
          },
        },
      },
      rootSortFailed: {
        title: 'The sort of “{subject}” stopped',
        body: 'What was moved until then stays. Open the files to see the reason.',
        variants: {
          office: { title: 'The sort of the office filing stopped' },
        },
      },
      unknown: {
        title: 'Something happened',
        body: 'in {subject}',
      },
    },
    /** Fallback when the actor cannot be resolved (deactivated user, etc.). */
    unknownActor: 'Someone',
    untitledConversation: 'Untitled conversation',
    /**
     * Triage of a revision waiting for a decision, inline on the row: the three
     * decisions without leaving the inbox. Approving carries the same minimum
     * ceremony as on the file (explicit confirmation, never one click); the
     * two refusals carry their words, as the transition table requires.
     */
    review: {
      approve: 'Approve',
      requestChanges: 'Request changes',
      reject: 'Reject',
      changesLabel: 'What needs to change',
      reasonLabel: 'Reason for rejection',
      approveConfirm: 'I approve this revision',
      // The signature mirrors the file pane: which revision is approved (the row
      // names the document, the revision number and when the round opened — the
      // number is required, nothing is approved without it) and who acts when.
      // No viewer name is known here, so the acting line is always the
      // date-only form; who asked is already in the title.
      approveSummary: '{subject} · revision {number} · as of {date}',
      approveActing: 'Acting: {date}',
      revisionUnreadable: 'The current revision could not be read — approval is blocked until it is.',
      retry: 'Try again',
      send: 'Send',
      cancel: 'Cancel',
      open: 'Open file',
      decided: 'Decision sent — refreshing.',
      failed: 'That did not go through. Nothing has changed.',
      stale: 'Someone decided first. The current revision is in the file.',
      reload: 'Open current revision',
    },
  },

  /** Chat-thread additions that only appear once a conversation is shared. */
  thread: {
    participantsAria: 'People in this conversation',
    /** A mention rendered inside message text. */
    mentionAria: 'Mention of {name}',
    mentionedYouAria: 'You were mentioned',
    /** Consecutive messages from one author collapse under a single header. */
    groupedAria: 'Continued from {name}',
    /** Observers see who the agent is working for (spec CC-13). */
    turnInFlight: 'Piloti is answering {name}’s question…',
    turnInFlightYou: 'Piloti is answering…',
    /** A colleague is composing. Human vocabulary, not the agent's (TypingPresence). */
    typing: '{names} is writing…',
    /**
     * Exactly two named typists. Without this the renderer picked `typing` — the
     * commonest multi-typist case read "Anna Berger, Tobias Kern is writing…" in
     * English and "… schreibt…" in German.
     */
    typingPair: '{names} are writing…',
    typingMany: '{names} and {count} others are writing…',
    /** `typingMany` with an overflow of exactly one — reachable at three typists. */
    typingManyOne: '{names} and 1 other are writing…',
    /**
     * Joins the named typists when a count follows them ("Anna, Tobias and 2
     * others"), where the conjunction is already spoken by `typingMany`.
     */
    typingNameSeparator: ', ',
    /**
     * The two named typists when nobody follows them. A list separator is not a
     * conjunction: German reads "Anna und Tobias schreiben", never "Anna, Tobias
     * schreiben", and English is no different.
     */
    typingNamePair: '{first} and {second}',
    /** The agent put a question to the asker; an observer is told, not offered it. */
    spectatorPrompt: 'Piloti asked a question and is waiting for an answer: “{question}”',
    spectatorFailed: 'This turn ended with an error.',
    composerBusy: 'Piloti is answering {name}’s question — you can send once it finishes.',
    /** Access was revoked while the reader had the thread open. */
    /**
     * Deliberately says "no longer available" rather than "you no longer have
     * access": the server refuses a revoked thread and a DELETED one with the
     * same answer, on purpose (spec SH-6, denial indistinguishable from
     * non-existence), so this string has to be true of both. It used to tell
     * somebody they had been shut out of a conversation that no longer existed.
     */
    accessLost:
      'This conversation is no longer available to you. What you see is a local copy and will not update.',
    /** Read-only role in a shared thread. */
    viewerNotice: 'You can read along here. An owner can give you write access from the sharing dialog.',
    unreadDivider: 'New',
    authorYou: 'You',
    /** Marks a message written by a colleague rather than by the agent. */
    authorAria: 'Message from {name}',
  },
}
