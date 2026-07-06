import { handleAuth } from '@workos-inc/authkit-nextjs';

/**
 * Post-login redirect base.
 *
 * The frontend runs behind a proxy (Coolify/Traefik) with Next.js on an
 * internal address. Without a baseURL, authkit builds the post-callback
 * redirect from the request origin, which leaks the internal host
 * (e.g. https://0.0.0.0:3001/app/projects) instead of the public domain.
 *
 * The configured redirect URI is already the public callback URL, so its
 * origin is the correct public base. authkit overrides the pathname with
 * returnPathname, so only the origin of baseURL is used. Unset (auth disabled)
 * → undefined → authkit falls back to the request URL.
 *
 * Prefer the plain WORKOS_REDIRECT_URI (a normal server env var, read at
 * runtime) over NEXT_PUBLIC_WORKOS_REDIRECT_URI, which Next can inline at build
 * time and would be empty when the value is only supplied at deploy time.
 */
const redirectUri =
  process.env.WORKOS_REDIRECT_URI ?? process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
const baseURL = redirectUri ? new URL(redirectUri).origin : undefined;

export const GET = handleAuth({ returnPathname: '/app/projects', baseURL });
