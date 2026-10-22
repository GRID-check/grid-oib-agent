// @ts-check
/**
 * Project mail: the Cloudflare Email Worker (deployed by `inbound-mail.ts`).
 *
 * It does not parse. It reads the raw RFC 5322 bytes Cloudflare received,
 * signs them for the BFF, posts them, and turns the BFF's answer into accept,
 * reject or retry. Everything that decides anything about a project (address,
 * office, sender, DKIM, limits) lives in the BFF, where it is tested and
 * audited (ADR-0135). The webhook's contract is `shared/inbound-mail-contract.json`;
 * the constants below restate it, and `inbound-mail-worker.spec.ts` holds them
 * to that file.
 *
 * ## The one thing it decides: is this a project address at all
 *
 * The catch-all it hangs off is the product domain's own (`piloti.at`), so it
 * receives every address on that domain that no literal rule claimed first:
 * project addresses, and also typos of company addresses and whatever spam
 * guesses. Cloudflare matches literal rules before the catch-all, so a named
 * company address with its own rule never gets here. For the rest, the Worker
 * checks the recipient's SHAPE, the rule of `shared/inbound-address.json`,
 * which the BFF's parser runs too. A project-shaped address goes to the BFF.
 * Anything else is refused here with `UNKNOWN_ADDRESS_TEXT`, without a
 * request: spam to random names never reaches the webhook.
 *
 * The shape is public, so splitting the two texts on it tells a prober
 * nothing: whether a project-shaped address EXISTS is answered only by the
 * BFF, with `REJECT_TEXT` for every refusal.
 *
 * ## The request: RFC 9421 over a fixed-length body
 *
 * The BFF accepts the request only with an HTTP Message Signature (RFC 9421,
 * `hmac-sha256`) over `@method`, `@target-uri`, `content-digest`,
 * `content-length` and the two envelope headers, with a `Content-Digest`
 * (RFC 9530) of the exact bytes (`requireInternalSignature` in
 * `frontends/ui/src/lib/internal-auth.ts`). So the Worker buffers the message:
 * the digest is known only after the last byte, and a fixed-length body is
 * what carries a real `Content-Length` (a stream body goes out chunked, and the
 * BFF refuses a request it cannot hold to an exact length). Buffering 25 MiB is
 * CPU and memory a Workers Free plan does not have; Workers Paid is a launch
 * prerequisite and gate G5 measures it (DECISION D19). There is no fallback
 * that drops the digest: a replay is then the same bytes, which the BFF
 * answers as a duplicate.
 *
 * The signer is written by hand on WebCrypto, because the Worker has no
 * bundler. `shared/inbound-mail-signature.json` pins it: the spec makes this
 * module produce every vector's request byte for byte, and the BFF's spec
 * verifies the same vectors with the library the BFF uses.
 *
 * The key is the one entry of the BFF's key map (`GRID_INBOUND_MAIL_SIGNING_KEYS`)
 * this Worker signs with, its secret base64 as in the map. Rotation adds the
 * successor to the map first, then moves this Worker to it (the BFF accepts
 * both meanwhile), then drops the old one (`docs/deployment/kubernetes.md` §3c).
 *
 * ## The verdict contract
 *
 * A bounce is permanent: the sender's server gives up and the mail is gone. A
 * thrown error is temporary: Cloudflare answers the sending server with a 4xx
 * SMTP code and it retries for days. So the Worker bounces only when the BFF
 * says so explicitly, and treats every other failure as ours to fix:
 *
 *   - 2xx: accepted (held, dropped as automatic mail, or a duplicate).
 *   - 4xx WITH `x-inbound-verdict: reject`: a permanent refusal (unknown or
 *     revoked address, the office has the feature off, an oversized mail).
 *     `setReject(REJECT_TEXT)`.
 *   - Anything else throws, so the sender retries: a refused signature, a
 *     paused deployment, a rate limit, a truncated body, 5xx, 3xx, a network
 *     error, and a BFF that has not answered within `BFF_TIMEOUT_MS`.
 *
 * A status alone never bounces. A rotated key (401), a `BFF_URL` that points at
 * the wrong host (404) or the edge's own 413 all look like refusals by status,
 * and none of them is the sender's fault.
 *
 * ## The pause
 *
 * `PAUSED` ("true") makes every delivery to a project address a temporary
 * failure before anything is read or sent: the sending servers keep the mail
 * and retry. It is the first lever in an incident, and the state of the first
 * promote (`inboundMailPaused`). The BFF has the same switch
 * (`GRID_INBOUND_MAIL_PAUSED`), which answers 503; the Worker's takes effect
 * the moment Pulumi updates the binding, without waiting for a frontend
 * rollout.
 *
 * ## Runtime facts this relies on, as documented by Cloudflare
 *
 *   - `message.raw` is a `ReadableStream` of the whole message and
 *     `message.rawSize` its size; inbound mail is capped at 25 MiB
 *     (developers.cloudflare.com/email-routing/email-workers/runtime-api/,
 *     last updated 2026-10-15, and /email-service/platform/limits/).
 *   - A fetch with an `ArrayBuffer`-backed body sends `Content-Length`; a
 *     stream body is sent chunked (developers.cloudflare.com/workers/runtime-apis/request/).
 *   - A thrown error is a temporary SMTP failure. Cloudflare does not document
 *     it; gate G2 proves it and G8 re-proves it after a `compatibilityDate` bump.
 *
 * `redirect: "manual"` is a security setting, not a nicety. A followed 301/302
 * turns the POST into a GET and re-sends the headers to wherever the redirect
 * points. A 3xx is unmapped, so it throws.
 *
 * Dependency-free on purpose: `inbound-mail.ts` uploads this file verbatim as
 * the Worker's only module. It is still type-checked: `// @ts-check` above,
 * the handler typed as `ExportedHandler<Env>` from `@cloudflare/workers-types`,
 * and `tsconfig.worker.json` runs it through `tsc` in `npm run typecheck`. It
 * exports only the handler and plain strings and numbers: a module Worker's
 * named exports are read as entrypoints.
 */

/**
 * The Worker's bindings, set by `inbound-mail.ts`.
 *
 * @typedef {object} Env
 * @property {string} BFF_URL The app origin, e.g. `https://app.example.at`: the origin of `WORKOS_REDIRECT_URI`, which the BFF checks `@target-uri` against.
 * @property {string} SIGNING_KEY_ID The keyid this Worker signs with, a key of `GRID_INBOUND_MAIL_SIGNING_KEYS`.
 * @property {string} SIGNING_KEY Its secret, base64 as in the key map.
 * @property {string} PAUSED `"true"` while deliveries are paused.
 */

/**
 * A project token: 12 characters of lowercased RFC 4648 base32. Must equal
 * `tokenPattern` in `shared/inbound-address.json` (the spec checks).
 */
export const TOKEN_PATTERN = "^[a-z2-7]{12}$";

const TOKEN = new RegExp(TOKEN_PATTERN);

/** The BFF route, relative to `BFF_URL`. `path` in the contract. */
export const INBOUND_MAIL_PATH = "/api/internal/signed/inbound-mail";

/** Response header by which the BFF marks a refusal as permanent. */
export const VERDICT_HEADER = "x-inbound-verdict";

/** The one value of `VERDICT_HEADER` that bounces the mail. */
export const VERDICT_REJECT = "reject";

/** The SMTP envelope recipient, as the contract's `envelopeEncoding` writes it. */
export const ENVELOPE_TO_HEADER = "x-envelope-to";

/** The SMTP envelope sender (`MAIL FROM`), likewise. */
export const ENVELOPE_FROM_HEADER = "x-envelope-from";

/** How a null reverse-path (an empty envelope sender) is written. */
export const NULL_SENDER = "<>";

/** The one signature label (RFC 9421 §4.1). The BFF accepts any one label. */
export const SIGNATURE_LABEL = "sig";

/** `alg` of the signature. */
export const SIGNATURE_ALGORITHM = "hmac-sha256";

/** `expires - created`. The BFF refuses more than 300. */
export const SIGNATURE_LIFETIME_S = 300;

/**
 * How long the Worker waits for the BFF. A hung BFF then aborts the fetch,
 * which throws like a network error, so the sender retries. The BFF does no
 * parsing in the request: it stages the bytes in object storage and answers,
 * so 25 MiB at a pessimistic 1 MB/s plus connect slack fits.
 */
export const BFF_TIMEOUT_MS = 90_000;

/**
 * The one bounce text for a project-shaped address, identical for every
 * refusal, so the bounce cannot tell an unknown address from an office that
 * switched the feature off or an oversized message. ASCII: it travels as the
 * SMTP reply text, which is ASCII unless the sending server negotiated
 * SMTPUTF8. The help page tells the sender what to do instead; the privacy
 * link is there because a refused mail was still received and processed.
 */
export const REJECT_TEXT =
  "This message could not be delivered: the address is unknown or no longer valid. " +
  "Help: https://piloti.at/e-mail-eingang/ Privacy: https://piloti.at/datenschutz/";

/** The bounce for an address that is not project-shaped: a typo, a name nobody routed, a guess. */
export const UNKNOWN_ADDRESS_TEXT = "Unknown address: this message was not delivered.";

/** The components the signature covers, in order. */
const COVERED_COMPONENTS = [
  "@method",
  "@target-uri",
  "content-digest",
  "content-length",
  ENVELOPE_TO_HEADER,
  ENVELOPE_FROM_HEADER,
];

/**
 * Whether `recipient` has the shape of a project address: after ASCII
 * lowercasing, dropping surrounding `<>` and quotes and a `+detail`
 * subaddress, what follows the LAST dot (or the whole local part) matches
 * `TOKEN_PATTERN`. ASCII lowercasing only, so `K` (Kelvin) cannot fold onto `k`.
 *
 * @param {string} recipient
 * @returns {boolean}
 */
function isProjectRecipient(recipient) {
  const trimmed = recipient.trim().replace(/^<|>$/g, "");
  const at = trimmed.lastIndexOf("@");
  if (at === -1) return false;
  let local = trimmed.slice(0, at);
  if (local.length >= 2 && local.startsWith('"') && local.endsWith('"')) {
    local = local.slice(1, -1);
  }
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  local = local.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const dot = local.lastIndexOf(".");
  return TOKEN.test(dot === -1 ? local : local.slice(dot + 1));
}

/**
 * An envelope address as a header value: every UTF-8 byte outside 0x21-0x7E,
 * and `%`, as `%XX`, so `decodeURIComponent` restores it; an empty sender as
 * `NULL_SENDER`, never an empty header. Header values must be ASCII, and
 * SMTPUTF8 addresses are not.
 *
 * @param {string} address
 * @returns {string}
 */
function envelopeHeader(address) {
  if (address === "") return NULL_SENDER;
  let encoded = "";
  for (const byte of new TextEncoder().encode(address)) {
    encoded +=
      byte >= 0x21 && byte <= 0x7e && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Standard base64 of `bytes`, chunked so a long input never overflows the
 * argument list of `String.fromCharCode`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * The signed request's headers: the RFC 9530 digest, the envelope, and the
 * RFC 9421 `Signature-Input` and `Signature` over the signature base of
 * §2.5, one line per covered component and `@signature-params` last. The
 * component values here contain no surrounding whitespace, so they enter the
 * base as they are.
 *
 * @param {{ url: string, body: Uint8Array, envelopeTo: string, envelopeFrom: string, env: Env }} input
 * @returns {Promise<Record<string, string>>}
 */
async function signedHeaders({ url, body, envelopeTo, envelopeFrom, env }) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  /** @type {Record<string, string>} */
  const fields = {
    "content-digest": `sha-256=:${base64(digest)}:`,
    "content-length": String(body.byteLength),
    [ENVELOPE_TO_HEADER]: envelopeTo,
    [ENVELOPE_FROM_HEADER]: envelopeFrom,
  };
  const created = Math.floor(Date.now() / 1000);
  const params =
    `(${COVERED_COMPONENTS.map((c) => `"${c}"`).join(" ")})` +
    `;created=${created};expires=${created + SIGNATURE_LIFETIME_S}` +
    `;keyid="${env.SIGNING_KEY_ID}";alg="${SIGNATURE_ALGORITHM}"`;
  const base = [
    `"@method": POST`,
    `"@target-uri": ${url}`,
    ...COVERED_COMPONENTS.slice(2).map((name) => `"${name}": ${fields[name]}`),
    `"@signature-params": ${params}`,
  ].join("\n");
  const secret = Uint8Array.from(atob(env.SIGNING_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  return {
    "content-type": "message/rfc822",
    "content-digest": fields["content-digest"],
    [ENVELOPE_TO_HEADER]: envelopeTo,
    [ENVELOPE_FROM_HEADER]: envelopeFrom,
    "signature-input": `${SIGNATURE_LABEL}=${params}`,
    signature: `${SIGNATURE_LABEL}=:${base64(mac)}:`,
  };
}

/**
 * Whether the BFF's answer is an explicit, permanent refusal.
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
    if (!isProjectRecipient(message.to)) {
      message.setReject(UNKNOWN_ADDRESS_TEXT);
      return;
    }
    if (env.PAUSED === "true") {
      // Before a byte is read: the sending server keeps the message.
      throw new Error("inbound-mail: deliveries are paused; asking the sender to retry");
    }

    const body = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const url = new URL(INBOUND_MAIL_PATH, env.BFF_URL).href;
    const headers = await signedHeaders({
      url,
      body,
      envelopeTo: envelopeHeader(message.to),
      envelopeFrom: envelopeHeader(message.from),
      env,
    });

    // A network error or the timeout rejects here and propagates: Cloudflare
    // answers the sending server with a temporary failure and it retries.
    // The body is a Uint8Array, so the runtime sends the Content-Length the
    // signature covers.
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(BFF_TIMEOUT_MS),
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
