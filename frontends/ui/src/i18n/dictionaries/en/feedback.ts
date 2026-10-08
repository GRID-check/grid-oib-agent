/**
 * Product feedback: the form any member opens from the shell, and Platform →
 * Feedback where the platform owners triage what arrives. Not the thumbs on an
 * answer — those live under `chat`.
 */
export const feedback = {
  open: 'Send feedback',
  openHint: 'Report a bug or share an idea',
  dialog: {
    title: 'Tell us what you think',
    description:
      'Your message goes straight to the people who build Piloti. Every report is read.',
    kindLabel: 'What is it about?',
    messageLabel: 'Your message',
    counter: '{count} / {max}',
    tooShort: 'A few more words, please — at least {min} characters.',
    context: {
      summary: 'Sent along automatically',
      page: 'Page',
      browser: 'Browser',
      screen: 'Screen',
      locale: 'Language',
      timeZone: 'Time zone',
      none: '—',
    },
    allowContact: 'You may contact me about this',
    allowContactHint: 'We reply to {email} if we have a question or news.',
    cancel: 'Cancel',
    send: 'Send feedback',
    sending: 'Sending…',
    shortcut: 'to send',
    error: 'Your feedback could not be sent. Please try again.',
    rateLimited: 'You have sent a lot of feedback in the last hour. Please try again later.',
    success: {
      title: 'Thank you!',
      body: 'Your feedback has reached the Piloti team. Every report is read.',
      another: 'Send more',
      close: 'Close',
    },
  },
  kinds: {
    bug: {
      label: 'Bug',
      hint: 'Something is broken',
      placeholder: 'What did you do, what happened, and what did you expect instead?',
    },
    idea: {
      label: 'Idea',
      hint: 'Something is missing',
      placeholder: 'What would make your work easier? Describe the situation you are in.',
    },
    praise: {
      label: 'Praise',
      hint: 'Something works well',
      placeholder: 'What do you like? We love to hear it.',
    },
    question: {
      label: 'Question',
      hint: 'Something is unclear',
      placeholder: 'What would you like to know?',
    },
  },
  statuses: {
    new: 'New',
    in_progress: 'In progress',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
  },
  platform: {
    filters: {
      label: 'Filter by status',
      all: 'All',
      kindLabel: 'Kind',
      allKinds: 'All kinds',
    },
    empty: {
      title: 'No feedback here',
      description: 'When a member sends feedback, it shows up here and in your inbox.',
    },
    loadError: 'Feedback could not be loaded.',
    retry: 'Try again',
    loadMore: 'Load more',
    from: '{name} · {organization}',
    unknownReporter: 'Unknown member',
    unknownOrganization: 'Unknown organization',
    onPage: 'on {page}',
    contact: 'Reply by email',
    noContact: 'Does not want to be contacted',
    statusLabel: 'Status',
    triagedBy: 'Triaged by {name}',
    triaged: 'Moved to “{status}”.',
    triageError: 'The status could not be changed.',
    details: 'Browser details',
    listTitle: 'Reports',
    linked: 'From your inbox',
    focusMissing: {
      title: 'The linked report was not found.',
      description: 'It was deleted or is not visible to you. The other reports are listed below.',
    },
  },
}
