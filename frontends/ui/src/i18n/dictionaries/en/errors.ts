/** Error, not-found, and auth-error surfaces. */
export const errors = {
  notFound: {
    code: '404',
    title: "We couldn't find that",
    description:
      "The page or project you're looking for doesn't exist, or you no longer have access to it.",
    action: 'Back to projects',
  },
  appError: {
    code: 'Error',
    title: 'Something went wrong',
    description: 'An unexpected error occurred. You can try again, or head back to your projects.',
    action: 'Try again',
    backAction: 'Back to projects',
  },
  access: {
    code: 'Access',
    title: 'You don’t have access to this',
    description:
      'This project may have been moved, or your access was changed. Check with a project admin if you think this is a mistake.',
    action: 'Go Home',
  },
  auth: {
    title: 'Authentication error',
    heading: 'Authentication Error',
    description: 'We could not sign you in. Please try again.',
    action: 'Back to home',
    tryAgain: 'Try Again',
    goHome: 'Go Home',
    redirecting: 'Redirecting…',
    loading: 'Loading',
    messages: {
      Configuration: 'There is a problem with the server configuration.',
      AccessDenied: 'You do not have permission to access this resource.',
      Verification: 'The verification link has expired or has already been used.',
      Default: 'An error occurred during authentication.',
    },
  },
  /**
   * A conversation that drew on a folder with restricted access, refusing to
   * carry its content where others read it (ADR-0087,
   * `lib/conversations/restricted-egress.ts`). One sentence per door, relayed
   * as the API error: the agent quotes the German one to the reader.
   */
  confinement: {
    deepResearch:
      'This conversation draws on a folder with restricted access, so it cannot start a deep research run: the run, its title and its report would be visible to everyone in the project, including people not cleared for that folder.',
    task: 'This conversation draws on a folder with restricted access, so it cannot create a task: tasks are visible to everyone in the project, including people not cleared for that folder.',
    profilePatch:
      'This conversation draws on a folder with restricted access, so it cannot change the project context: the project context is visible to everyone in the project, including people not cleared for that folder.',
    filing:
      'This conversation draws on a folder with restricted access, so nothing from it can be filed there: that place is visible to people not cleared for the restricted folder. Filing works only into a folder restricted at least as narrowly.',
    revision:
      'This document is in a folder with restricted access, so Piloti cannot revise it: the task for that would be visible to everyone in the project, including people not cleared for that folder. Request the changes without Piloti.',
    planDocument:
      'A document you named sits in a folder with restricted access, so it cannot be handed to a research run: a run’s documents and its report are visible to everyone in the project, including people not cleared for that folder.',
  },
}
