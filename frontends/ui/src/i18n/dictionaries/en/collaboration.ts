/**
 * Collaboration: sharing a resource, @-mentions with the agent hand-off, and the
 * inbox (ADR-0032…0035).
 *
 * Note there is no pluralization machinery in this i18n layer (see
 * `src/i18n/translate.ts` — interpolation only), so anything counted carries
 * explicit `…One` / `…Many` keys and the renderer picks. Do not "simplify" those
 * into a single string with `{count}`; German and English disagree about where
 * the noun inflects.
 */
export const collaboration = {
  sharing: {
    title: 'Share',
    /** Button in the chat toolbar. */
    action: 'Share',
    close: 'Close',
    visibilityHeading: 'Who can see this',
    visibility: {
      private: 'Only me',
      privateHint: 'Just you, plus anyone you invite by name.',
      project: 'Everyone in this project',
      projectHint: 'Every member of this project can read and contribute.',
      organization: 'Everyone in the organization',
      organizationHint: 'Every member of your organization can read and contribute.',
    },
    /** The access chip shown wherever a resource is listed. */
    chip: {
      private: 'Private',
      project: 'Project',
      organization: 'Organization',
      sharedOne: 'Shared with 1',
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
      submit: 'Invite',
      /** Shown on org members who are not in the project (spec SH-19). */
      needsProjectAccess: 'Not in this project yet',
      needsProjectAccessHint:
        'Add them to the project first. Sharing a chat never grants access to the project itself.',
    },
    remove: 'Remove access',
    removeConfirm: 'Remove {name}?',
    removeConfirmHint: 'They lose access immediately. Anything they wrote stays in the conversation.',
    leave: 'Leave this conversation',
    leaveConfirm: 'Leave this conversation?',
    leaveConfirmHint: 'You lose access. Everyone else keeps theirs.',
    escalate: 'Take ownership',
    escalateHint:
      'As a project admin you can take ownership of this conversation. This is recorded in the audit trail.',
    errors: {
      lastOwner: 'This conversation must keep at least one owner. Make someone else an owner first.',
      containerAccessRequired:
        'That person is not a member of this project yet. Add them to the project first.',
      organizationMembershipRequired: 'That person is not a member of this organization.',
      rateLimited: 'Too many sharing changes. Please wait a few minutes and try again.',
      loadFailed: 'Sharing settings could not be loaded.',
      saveFailed: 'That change could not be saved.',
      tryAgain: 'Try again',
    },
    resourceTypes: {
      conversation: 'Conversation',
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
      keyboardHint: '↑↓ to choose · ↵ to insert · esc to close',
      badgeInChat: 'In this chat',
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
      toAgent: 'Goes to Piloti',
      /** One or more humans tagged in the message being written. */
      toPerson: 'Goes to {name}',
      toPeople: 'Goes to {names}',
      /**
       * While the thread is waiting on a named person, a plain message is a
       * remark to the people in it — not a question for the agent.
       */
      toThread: 'Goes to the chat',
      /** How to get back to the agent from the waiting state. */
      agentHint: 'Type @Piloti to ask Piloti',
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
      mentionHint: 'Two of you are talking here, so a plain message goes to the chat.',
      switchToAsk: 'Let Piloti answer everything',
      /**
       * The OFFER, shown while the thread is still in `ask`. Phrased as a
       * question about the future, never as a report of a change — because no
       * change happened, and `ask` remains the default however many people are
       * here.
       */
      offerHint: 'Several of you are talking here. Should Piloti wait to be mentioned?',
      switchToMention: 'Only when mentioned',
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
      prefill: 'please carry on from here.',
    },
    errors: {
      inviteRequiresOwner:
        'You can only mention people who are already in this conversation. Ask an owner to invite {name}.',
      containerAccessRequired: '{name} is not a member of this project.',
      rateLimited: 'Too many mentions. Please wait a few minutes.',
      tooMany: 'You can mention at most {count} people in one message.',
      releaseFailed: 'The wait could not be released.',
    },
  },

  inbox: {
    title: 'Inbox',
    /** Nav entry + the count badge. */
    navLabel: 'Inbox',
    badgeAria: '{count} items need your attention',
    badgeAriaOne: '1 item needs your attention',
    subtitle: 'Requests and updates from your team.',
    filters: {
      needsMe: 'Needs me',
      all: 'All',
      ariaLabel: 'Filter inbox',
    },
    markAllRead: 'Mark all as read',
    archive: 'Archive',
    archived: 'Archived',
    /** Item states. */
    resolved: 'Answered',
    /** An item whose target the recipient can no longer reach (spec IB-13). */
    inert: 'No longer available',
    inertHint: 'You no longer have access to this.',
    empty: {
      needsMeTitle: 'Nothing needs you',
      needsMeDescription: 'When a colleague asks for your input, it shows up here.',
      allTitle: 'Your inbox is empty',
      allDescription: 'Requests, answers and shared conversations appear here.',
    },
    errors: {
      loadFailed: 'Your inbox could not be loaded.',
      tryAgain: 'Try again',
    },
    /**
     * One entry per registered item type. Adding a type means adding a `title`
     * and `body` here — that plus a registry entry is the whole cost (spec IB-6).
     */
    types: {
      mentionRequested: {
        title: '{actor} asked for your input',
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
        body: 'in {subject}',
      },
      conversationShared: {
        title: '{actor} shared a conversation with you',
        body: '{subject}',
      },
      conversationActivity: {
        titleOne: '1 new message',
        titleMany: '{count} new messages',
        body: 'in {subject}',
      },
    },
    /** Fallback when the actor cannot be resolved (deactivated user, etc.). */
    unknownActor: 'Someone',
    untitledConversation: 'Untitled conversation',
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
    composerBusy: 'Piloti is answering {name}’s question — you can send once it finishes.',
    unreadDivider: 'New',
    authorYou: 'You',
    /** Marks a message written by a colleague rather than by the agent. */
    authorAria: 'Message from {name}',
  },
}
