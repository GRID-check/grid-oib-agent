// @ts-check
/**
 * Project mail inbox: the Cloudflare Email Worker (deployed by `inbound-mail.ts`).
 *
 * It does not parse. It streams the raw RFC 822 bytes to the BFF and turns the
 * BFF's answer into accept, reject or retry. Everything that decides anything
 * (address, sender, DKIM, membership, permissions, rate limits) lives in the
 * BFF, where it is tested and audited; see the webhook contract in
 * `frontends/ui/src/app/api/internal/inbound-mail/route.ts`.
 *
 * Dependency-free on purpose: `inbound-mail.ts` uploads this file verbatim as
 * the Worker's only module, so there is no bundler and nothing to import. It is
 * still type-checked: `// @ts-check` above, the handler typed as
 * `ExportedHandler<Env>` from `@cloudflare/workers-types`, and
 * `tsconfig.worker.json` runs it through `tsc` as part of `npm run typecheck`.
 *
 * ## The verdict contract
 *
 * A bounce is permanent: the sender's server gives up and the mail is gone. A
 * thrown error is temporary: Cloudflare answers the sending server with a
 * 4xx SMTP code and it retries for days. So the Worker bounces only when the
 * BFF says so explicitly, and treats every other failure as ours to fix:
 *
 *   - 2xx: accepted (filed, queued or a duplicate). Nothing else to do.
 *   - 4xx WITH `x-inbound-verdict: reject`: a permanent refusal (unknown or
 *     revoked address, unverifiable or unauthorised sender, oversized mail, the
 *     inbox switched off for the organisation). `setReject(REJECT_TEXT)`.
 *   - Anything else throws, so the sender retries: 401/403/404/413 without the
 *     header, 409, 429, 5xx, 3xx, and network errors.
 *
 * A status alone never bounces. A rotated `INBOUND_MAIL_TOKEN` (403 from the
 * token check), a `BFF_URL` that points at the wrong host (404) or a proxy's
 * 413 all look like refusals by status, and none of them is the sender's
 * fault. Without the header they are retried until the operator fixes them.
 *
 * ## Runtime facts this relies on, as documented by Cloudflare
 *
 *   - `message.raw` is a `ReadableStream` of the whole message and
 *     `message.rawSize` its size; inbound mail is capped at 25 MiB
 *     (developers.cloudflare.com/email-routing/email-workers/runtime-api/,
 *     and /email-service/platform/limits/, both read 2026-09-30).
 *   - A `ReadableStream` request body is sent with chunked transfer encoding.
 *     The runtime sets Content-Length itself and ignores a value set in the
 *     headers; only a `FixedLengthStream` or a fixed-length body carries one
 *     (developers.cloudflare.com/workers/runtime-apis/request/, read
 *     2026-09-30). So the size travels as `x-inbound-raw-size` instead: the
 *     BFF can refuse an oversized mail before reading a byte, and still caps
 *     the stream itself, because a header is a claim and not a limit. A
 *     `FixedLengthStream` would give a real Content-Length, but it errors the
 *     whole delivery if `rawSize` and the bytes ever disagree by one.
 *   - The body is passed through as the same stream, never read or buffered in
 *     this isolate: CPU time stays near zero and the bytes the BFF's DKIM check
 *     sees are the bytes Cloudflare received.
 *   - No `duplex: "half"`: that is a Node/undici requirement for stream
 *     bodies, and workerd ignores the option (the field is commented out in
 *     `RequestInitializerDict`, src/workerd/api/http.h, with a note that a
 *     later version may accept only "full" behind a compatibility flag).
 *
 * `redirect: "manual"` is a security setting, not a nicety. A followed 301/302
 * turns the POST into a GET and re-sends every custom header, the token
 * included, to wherever the redirect points. A 3xx is unmapped, so it throws.
 */

/**
 * The Worker's bindings, set by `inbound-mail.ts`.
 *
 * @typedef {object} Env
 * @property {string} BFF_URL The app origin, e.g. `https://app.example.at`.
 * @property {string} INBOUND_MAIL_TOKEN Shared secret the BFF checks (`GRID_INBOUND_MAIL_TOKEN`).
 */

/** The BFF route, relative to `BFF_URL`. Must equal `EDGE_RATE_LIMIT.paths.inboundMail`. */
export const INBOUND_MAIL_PATH = "/api/internal/inbound-mail";

/** Response header by which the BFF marks a refusal as permanent. */
export const VERDICT_HEADER = "x-inbound-verdict";

/** The one value of `VERDICT_HEADER` that bounces the mail. */
export const VERDICT_REJECT = "reject";

/** Request header carrying `message.rawSize`, since Content-Length cannot (see above). */
export const RAW_SIZE_HEADER = "x-inbound-raw-size";

/**
 * The one bounce text, identical for every refusal, so the bounce cannot be
 * used to tell an unknown address from an unauthorised sender or an oversized
 * message. ASCII on purpose ("fuer", not "für"): it travels as the SMTP reply
 * text, which is ASCII unless the sending server negotiated SMTPUTF8. The help
 * page tells the sender what to do instead; the privacy link is there because
 * a refused mail was still received and processed.
 */
export const REJECT_TEXT =
  "Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt, " +
  "oder der Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht " +
  "verifizierbar. Hilfe: https://piloti.at/e-mail-eingang/ " +
  "Datenschutz: https://piloti.at/datenschutz/";

/**
 * Whether the BFF's answer is an explicit, permanent refusal. Not exported: a
 * Worker's module exports are its entrypoints, so this module exports only the
 * handler and plain constants.
 *
 * @param {Response} response
 * @returns {boolean}
 */
function isExplicitReject(response) {
  return (
    response.status >= 400 &&
    response.status < 500 &&
    response.headers.get(VERDICT_HEADER) === VERDICT_REJECT
  );
}

/** @type {ExportedHandler<Env>} */
export default {
  async email(message, env) {
    // A network error rejects here and propagates: Cloudflare answers the
    // sending server with a temporary failure and it retries.
    const response = await fetch(new URL(INBOUND_MAIL_PATH, env.BFF_URL), {
      method: "POST",
      headers: {
        "x-grid-internal-token": env.INBOUND_MAIL_TOKEN,
        "x-envelope-to": message.to,
        [RAW_SIZE_HEADER]: String(message.rawSize),
        "content-type": "message/rfc822",
      },
      body: message.raw,
      redirect: "manual",
    });

    if (response.status >= 200 && response.status < 300) return;

    if (isExplicitReject(response)) {
      message.setReject(REJECT_TEXT);
      return;
    }

    // Not an explicit verdict: a misconfiguration, an outage or back-pressure
    // on our side. Throw, so the sender retries and nothing is lost.
    throw new Error(
      `inbound-mail: the BFF answered ${response.status} without a reject verdict; ` +
        "asking the sender to retry",
    );
  },
};
