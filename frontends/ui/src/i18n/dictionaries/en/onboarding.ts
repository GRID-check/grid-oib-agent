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
      welcomeJoined: {
        title: 'Welcome to Piloti',
        body: 'This is where your team works on its building projects. Here is a quick look at where things live — it takes about a minute.',
      },
      createProjectJoined: {
        title: 'Your projects',
        body: 'Projects appear here as colleagues add you to them. You can also start one yourself: a project holds one building, its documents, the people on it, and a chat that answers from OIB guidelines and Austrian building law.',
      },
      createProject: {
        title: 'Start with a project',
        body: 'A project holds one building: its plans and documents, the people working on it, and a chat that answers from OIB guidelines and Austrian building law, with every source cited. A short setup asks about the building, then we show you around inside.',
      },
      archiv: {
        title: 'Archiv',
        body: 'Your office’s shared documents — standard details, specifications, templates. File something here once and every project can draw on it.',
      },
      inbox: {
        title: 'Inbox',
        body: 'Mentions, requests and updates from your colleagues arrive here.',
      },
      account: {
        title: 'Your organization',
        body: 'Invite colleagues and manage roles under Organization. Theme, language and this tour live here too.',
      },
      accountMember: {
        title: 'Your account',
        body: 'Your profile, theme and language, and this tour whenever you want it again. Members and roles are managed by your organization’s admins.',
      },
      shortcuts: {
        title: 'Move faster',
        body: 'Two keys get you almost anywhere.',
        palette: 'Jump to anything',
        cheatsheet: 'All shortcuts',
      },
      projectWelcome: {
        title: 'Your project is set up',
        body: 'Piloti now knows the basics of this building. Here is where the work happens.',
      },
      projectWelcomeJoined: {
        title: 'Inside a project',
        body: 'Every building gets a space like this one. Here is where the work happens.',
      },
      projectChat: {
        title: 'Ask Piloti',
        body: 'Ask about this building in plain language: fire compartments, escape routes, accessibility, energy. Answers draw on building law, OIB guidelines and your own documents.',
      },
      projectFiles: {
        title: 'Files: this project’s documents',
        body: 'Upload plans, reports and correspondence for this building. Once a file is indexed, Piloti can quote it — only inside this project.',
      },
      projectArchiv: {
        title: 'Archiv: your office’s documents',
        body: 'The Archiv sits above your projects, and every project searches it automatically. It starts empty: admins add documents, and everyone in the organization can read and cite them.',
      },
      filesOrArchiv: {
        title: 'Files or Archiv?',
        body: 'Ask who the document belongs to.',
        filesTerm: 'Files — this building',
        filesDetail: 'Its plans, reports, correspondence. Cited only in this project.',
        archivTerm: 'Archiv — the office',
        archivDetail: 'Standard details, specifications, templates, earlier submissions worth reusing. Cited in every project.',
      },
      projectSources: {
        title: 'Every answer shows its sources',
        body: 'Each claim is marked with where it came from — Building law, Project knowledge or Office archive — and opens the passage it rests on. If Piloti has no source for something, it says so.',
      },
      projectSettings: {
        title: 'Settings and members',
        body: 'Invite the people working on this building, and revisit the project setup whenever the facts change.',
      },
    },
  },
}
