/**
 * Project mail inbox: the Cloudflare Email Worker (deployed by `inbound-mail.ts`).
 *
 * It does not parse. It streams the raw RFC 822 bytes to the BFF and turns the
 * BFF's answer into accept, reject or retry. Everything that decides anything
 * (address, sender, DKIM/DMARC, permissions, rate limits) lives in the BFF,
 * where it is tested and audited; see the webhook contract in
 * `frontends/ui/src/app/api/internal/inbound-mail/route.ts`.
 *
 * Dependency-free on purpose: `inbound-mail.ts` uploads this file verbatim as
 * the Worker's only module, so there is no bundler and nothing to import.
 *
 * Runtime facts this relies on, as documented by Cloudflare:
 *
 *   - `message.raw` is a `ReadableStream` of the whole message and
 *     `message.rawSize` its size; inbound mail is capped at 25 MiB
 *     (developers.cloudflare.com/email-routing/email-workers/runtime-api/,
 *     and /email-service/platform/limits/, both read 2026-09-30).
 *   - A `ReadableStream` request body is streamed with chunked transfer
 *     encoding; only a `FixedLengthStream` or a fixed-length value carries a
 *     Content-Length (developers.cloudflare.com/workers/runtime-apis/request/).
 *     The BFF reads the body as a stream, so chunked is fine and the bytes are
 *     never buffered in this isolate, which keeps the CPU time near zero.
 *   - No `duplex: "half"`: that is a Node/undici requirement for stream
 *     bodies, and workerd ignores the option (the field is commented out in
 *     `RequestInitializerDict`, src/workerd/api/http.h, with a note that a
 *     later version may accept only "full" behind a compatibility flag).
 *     Passing it would buy nothing today and could break on that change.
 *
 * `redirect: "manual"` is a security setting, not a nicety. A followed 301/302
 * turns the POST into a GET and re-sends every custom header, the token
 * included, to wherever the redirect points. A 3xx is unmapped, so it throws.
 */

/** The BFF route, relative to `BFF_URL`. */
export const INBOUND_MAIL_PATH = "/api/internal/inbound-mail";

/**
 * Statuses that reject the message for good. One text for all three, so the
 * bounce cannot be used to tell an unknown address from an unauthorised
 * sender or an oversized message.
 */
export const REJECT_STATUSES = new Set([403, 404, 413]);

/**
 * The one bounce text, identical for every rejection. It carries no link: the
 * sender is outside the product, so the useful instruction is the fallback.
 * ASCII on purpose ("fuer", not "für"): it travels as the SMTP reply text,
 * which is ASCII unless the sending MTA negotiated SMTPUTF8.
 */
export const REJECT_TEXT =
  "Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt, " +
  "oder der Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht " +
  "verifizierbar. Bitte laden Sie die Dateien direkt in Piloti hoch.";

export default {
  /**
   * @param {{ from: string, to: string, raw: ReadableStream, rawSize: number, setReject(reason: string): void }} message
   * @param {{ BFF_URL: string, INBOUND_MAIL_TOKEN: string }} env
   */
  async email(message, env) {
    // A network error rejects here and propagates: Cloudflare answers the
    // sending MTA with a temporary failure and it retries.
    const response = await fetch(new URL(INBOUND_MAIL_PATH, env.BFF_URL), {
      method: "POST",
      headers: {
        "x-grid-internal-token": env.INBOUND_MAIL_TOKEN,
        "x-envelope-to": message.to,
        "x-envelope-from": message.from,
        "content-type": "message/rfc822",
      },
      body: message.raw,
      redirect: "manual",
    });

    if (response.status >= 200 && response.status < 300) return;

    if (REJECT_STATUSES.has(response.status)) {
      message.setReject(REJECT_TEXT);
      return;
    }

    // 429, 5xx, 401 (a token mismatch is ours to fix, not the sender's
    // problem) and anything else: throw, so the sender retries later.
    throw new Error(`inbound-mail: the BFF answered ${response.status}; asking the sender to retry`);
  },
};
