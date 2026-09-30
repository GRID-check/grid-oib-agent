/**
 * The app's origin as the deployment pins it, for links built outside a
 * request (an issue body, a mail) and for return URLs that must not trust the
 * inbound Host header.
 *
 * The AuthKit redirect URI already names the real origin per deployment.
 * `WORKOS_REDIRECT_URI` first, for the reason the callback route gives: Next
 * can inline a `NEXT_PUBLIC_` variable at build time, and the image is built
 * without one.
 */
export function configuredAppOrigin(): string | null {
  const configured = process.env.WORKOS_REDIRECT_URI || process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    return null
  }
}
