/**
 * Whether the deployment requires WorkOS-authenticated requests.
 *
 * When false (local dev / anonymous single-tenant mode) pages, the AuthKit
 * proxy and routes skip all auth so requests stay anonymous.
 */
export const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}
