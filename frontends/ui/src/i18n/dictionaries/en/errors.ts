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
}
