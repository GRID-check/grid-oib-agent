/** onboarding namespace — the organization setup screen and the product tour. */
export const onboarding = {
  validation: {
    nameRequired: 'Organization name is required.',
    nameTooLong: 'Organization name must be at most 100 characters.',
  },
  inviteOnly: {
    eyebrow: 'Invitation required',
    title: 'This platform is invite-only',
    description:
      'New organizations are created by the platform team. Ask your organization’s admin for an invitation — once invited, you’ll land directly in their workspace.',
    wrongAccount:
      'Signed in with the wrong account? Sign out and sign in with the one that received the invitation.',
  },
  account: {
    signedInAs: 'Signed in as {email}',
    signedIn: 'You are signed in.',
  },
  errors: {
    createFailed: 'Failed to create organization.',
    selfServeDisabled: 'Creating new organizations is disabled on this platform. Ask your administrator for an invitation.',
    generic: 'Something went wrong.',
    title: 'Organization setup failed',
  },
  form: {
    eyebrow: 'New organization',
    title: 'Name your organization',
    description:
      'Your organization is the private space for your office’s building projects, documents and colleagues. You’ll be its admin.',
    nameLabel: 'Organization name',
    namePlaceholder: 'Musterarchitektur ZT GmbH',
    nameHint: 'Usually your office or practice name.',
    submit: 'Create organization',
    invitedHint:
      'Expecting to join an existing organization? Ask its admin for an invitation instead — invited members skip this step.',
  },
  next: {
    heading: 'What happens next',
    private: 'Documents, chats and research stay inside your organization.',
    admin: 'As admin, you invite colleagues and decide what they can do.',
    tour: 'A one-minute tour shows you around.',
  },
  success: {
    title: 'Organization created',
    description: '{name} is ready, and you’re its admin.',
    redirecting: 'Opening your workspace…',
  },
  tour: {
    progress: '{current} of {total}',
    next: 'Next',
    back: 'Back',
    done: 'Get started',
    close: 'Close tour',
    stops: {
      welcome: {
        title: 'Welcome to Piloti',
        body: 'Your organization is ready. Here is a quick look at where things live — it takes about a minute.',
      },
      createProject: {
        title: 'Start with a project',
        body: 'A project holds one building: its plans and documents, the people working on it, and a chat that answers from OIB guidelines and Austrian building law, with every source cited.',
      },
      archiv: {
        title: 'Archiv',
        body: 'Your office’s shared knowledge — reference documents and proven details, available in every project.',
      },
      inbox: {
        title: 'Inbox',
        body: 'Mentions, requests and updates from your colleagues arrive here.',
      },
      account: {
        title: 'Your organization',
        body: 'Invite colleagues and manage roles under Organization. Theme, language and this tour live here too.',
      },
      shortcuts: {
        title: 'Move faster',
        body: 'Two keys get you almost anywhere.',
        palette: 'Jump to anything',
        cheatsheet: 'All shortcuts',
      },
    },
  },
}
