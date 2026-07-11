/** onboarding namespace — populated during component i18n. */
export const onboarding = {
  validation: {
    nameRequired: 'Organization name is required.',
    nameTooLong: 'Organization name must be at most 100 characters.',
  },
  steps: {
    createOrg: 'Create your organization',
    makeAdmin: 'Make you the workspace admin',
    openProject: 'Open Grid and your first project',
  },
  inviteOnly: {
    title: 'This platform is invite-only',
    description:
      'New organizations are created by the platform team. Ask your organization\u2019s admin for an invitation \u2014 once invited, you\u2019ll land directly in their workspace.',
    wrongAccount:
      'Signed in with the wrong account? Sign out below and sign in with the one that received the invitation.',
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
  intro: {
    eyebrow: 'first workspace',
    title: 'Set your organization before Grid handles project data.',
    description:
      'Your organization is the private boundary for your building projects — documents, members, and OIB/RIS research all live inside it. You become its admin.',
    invitedHint:
      'Expecting to join an existing organization? Ask its admin for an invitation instead — invited members never see this step.',
  },
  features: {
    privateTenant: 'Private tenant',
    adminAccess: 'Admin access',
    projectsReady: 'Projects ready',
  },
  success: {
    eyebrow: 'workspace ready',
    title: 'You’re all set',
    description: 'Your organization is created and you’re the admin.',
    redirecting: 'Taking you to your projects…',
  },
  form: {
    eyebrow: 'organization setup',
    title: 'Name your organization',
    description: 'Use your office, practice, or client organization name.',
    nameLabel: 'Organization name',
    namePlaceholder: 'Grid Bauphysik Vienna',
    submit: 'Create organization',
  },
}
