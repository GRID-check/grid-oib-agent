/**
 * Tell Astro the scheme the visitor used.
 *
 * Envoy terminates TLS and talks plain HTTP to this pod, so the socket is not
 * encrypted and the node adapter (`createRequestFromNodeRequest` in
 * `astro/app/node`, which ignores `X-Forwarded-Proto`) builds every request as
 * `http://piloti.at/...`. Astro's origin check (`security.checkOrigin`, on by
 * default for a site with server routes) then compares that with the browser's
 * `Origin: https://piloti.at` and refuses every form POST with a 403: the
 * contact form's script and its no-script page alike.
 *
 * Envoy sets `X-Forwarded-Proto` to the scheme it accepted (it overwrites what
 * a client sends), so the request is marked with it before Astro reads the
 * socket. Per request, because Envoy reuses one connection for many.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function markForwardedScheme(req) {
  const header = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim().toLowerCase()
  if (proto !== 'https' && proto !== 'http') return
  Object.defineProperty(req.socket, 'encrypted', { value: proto === 'https', configurable: true, writable: true })
}
