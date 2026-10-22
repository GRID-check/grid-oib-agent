import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  BFF_TIMEOUT_MS,
  ENVELOPE_FROM_HEADER,
  ENVELOPE_TO_HEADER,
  INBOUND_MAIL_PATH,
  NULL_SENDER,
  REJECT_TEXT,
  SIGNATURE_ALGORITHM,
  SIGNATURE_LABEL,
  SIGNATURE_LIFETIME_S,
  TOKEN_PATTERN,
  UNKNOWN_ADDRESS_TEXT,
  VERDICT_HEADER,
  VERDICT_REJECT,
  type Env,
} from "./inbound-mail-worker.js";
// Imports, not `node:fs`: this spec is also checked against the Workers
// runtime types (tsconfig.worker.json), which have no Node modules.
import addressContract from "../../../../shared/inbound-address.json";
import contract from "../../../../shared/inbound-mail-contract.json";
import signatureVectors from "../../../../shared/inbound-mail-signature.json";
import publicSite from "../../../../shared/public-site.json";

/**
 * The Email Worker's whole job: sign the message exactly as the BFF verifies
 * it, and map the BFF's answer to accept, reject or retry. A reject is
 * permanent (the sender's server gives up and the mail is lost); a throw is
 * temporary (it retries for days). So every branch is pinned here against a
 * stubbed `fetch`, the request against the shared signature vectors, and the
 * rule the spec guards above all is that only an explicit
 * `x-inbound-verdict: reject` on a 4xx ever bounces.
 *
 * Type-checked against `@cloudflare/workers-types` by `tsconfig.worker.json`,
 * so the fake message below is the runtime's `ForwardableEmailMessage`, not a
 * shape this file made up.
 */

const VECTOR = signatureVectors.vectors[0];

const ENV: Env = {
  BFF_URL: VECTOR.bffUrl,
  SIGNING_KEY_ID: VECTOR.keyId,
  SIGNING_KEY: VECTOR.secret,
  PAUSED: "false",
};

/** The handler never touches the execution context. */
const CTX = {} as ExecutionContext;

const PROJECT_ADDRESS = "riverside.k3m7q2xw4pab@piloti.test";

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const RAW = new TextEncoder().encode("Subject: Site visit\r\n\r\nbody\r\n");

function fakeMessage(to = PROJECT_ADDRESS, options: { from?: string; raw?: Uint8Array } = {}) {
  const bytes = options.raw ?? RAW;
  const setReject = vi.fn<(reason: string) => void>();
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const message: ForwardableEmailMessage = {
    from: options.from ?? "sender@example.org",
    to,
    raw,
    rawSize: bytes.byteLength,
    headers: new Headers(),
    setReject,
    forward: () => Promise.reject(new Error("the Worker must not forward")),
    reply: () => Promise.reject(new Error("the Worker must not reply")),
  };
  return { message, setReject };
}

async function deliver(message: ForwardableEmailMessage, env: Env = ENV): Promise<void> {
  if (!worker.email) throw new Error("the Worker exports no email handler");
  await worker.email(message, env, CTX);
}

type FetchMock = ReturnType<typeof vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>>;

function stubFetch(answer: () => Promise<Response>): FetchMock {
  const fetchMock = vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const respond =
  (status: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(new Response(null, { status, headers }));

const REJECT = { [VERDICT_HEADER]: VERDICT_REJECT };

/** The headers the Worker sent, as a plain record. */
function sentHeaders(fetchMock: FetchMock): Record<string, string> {
  return Object.fromEntries(new Headers(fetchMock.mock.calls[0][1]?.headers).entries());
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("inbound mail worker: the contract file", () => {
  it("restates shared/inbound-mail-contract.json", () => {
    expect(INBOUND_MAIL_PATH).toBe(contract.path);
    expect(INBOUND_MAIL_PATH.startsWith(contract.signedPathPrefix)).toBe(true);
    expect(VERDICT_HEADER).toBe(contract.verdictHeader);
    expect(VERDICT_REJECT).toBe(contract.verdictReject);
    expect(ENVELOPE_TO_HEADER).toBe(contract.envelopeToHeader);
    expect(ENVELOPE_FROM_HEADER).toBe(contract.envelopeFromHeader);
    expect(NULL_SENDER).toBe(contract.envelopeEncoding.nullSender);
    expect(SIGNATURE_ALGORITHM).toBe(contract.signatureAlgorithm);
    expect(SIGNATURE_LABEL).toBe(contract.signatureLabel);
    expect(SIGNATURE_LIFETIME_S).toBe(contract.signatureLifetimeSeconds);
    expect(BFF_TIMEOUT_MS).toBe(contract.workerTimeoutMs);
    expect(REJECT_TEXT).toBe(contract.rejectText);
    expect(UNKNOWN_ADDRESS_TEXT).toBe(contract.unknownAddressText);
  });

  it("gives the BFF headroom above Cloudflare's 25 MiB, and the edge headroom above the BFF", () => {
    expect(contract.maxRawMessageBytes).toBeGreaterThan(25 * 1024 * 1024);
    expect(contract.edgeMaxBodyBytes).toBeGreaterThanOrEqual(contract.maxRawMessageBytes);
  });
});

describe("inbound mail worker: the signed request", () => {
  it.each(signatureVectors.vectors)("produces the vector's request byte for byte: $name", async (vector) => {
    // The Worker reads the clock for `created`; only Date is faked, so the
    // abort timer stays real.
    vi.useFakeTimers({ now: vector.created * 1000, toFake: ["Date"] });
    const fetchMock = stubFetch(respond(202));
    const body = bytesOf(vector.bodyBase64);
    const { message } = fakeMessage(vector.envelope.to, { from: vector.envelope.from, raw: body });

    await deliver(message, {
      BFF_URL: vector.bffUrl,
      SIGNING_KEY_ID: vector.keyId,
      SIGNING_KEY: vector.secret,
      PAUSED: "false",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(vector.expected.url);
    expect(init?.method).toBe("POST");
    // Content-Length is the runtime's, from the fixed-length body; the
    // signature covers the value it will send.
    const { "content-length": contentLength, ...signedRest } = vector.expected.headers;
    expect(sentHeaders(fetchMock)).toEqual(signedRest);
    const sent = init?.body;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(String((sent as Uint8Array).byteLength)).toBe(contentLength);
    expect(Array.from(sent as Uint8Array)).toEqual(Array.from(body));
  });

  it("encodes envelope addresses as the contract's cases say", async () => {
    for (const { address, header } of contract.envelopeEncoding.cases) {
      const fetchMock = stubFetch(respond(202));
      await deliver(fakeMessage(PROJECT_ADDRESS, { from: address }).message);
      expect(sentHeaders(fetchMock)[ENVELOPE_FROM_HEADER], JSON.stringify(address)).toBe(header);
      vi.unstubAllGlobals();
    }
  });

  it("signs with a five-minute lifetime from now", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 12), toFake: ["Date"] });
    const fetchMock = stubFetch(respond(202));
    await deliver(fakeMessage().message);
    const created = Date.UTC(2026, 9, 22, 12) / 1000;
    expect(sentHeaders(fetchMock)["signature-input"]).toContain(
      `;created=${created};expires=${created + 300};keyid="${VECTOR.keyId}";alg="hmac-sha256"`,
    );
  });

  it("never follows a redirect, which would resend the signed request elsewhere", async () => {
    const fetchMock = stubFetch(respond(202));
    await deliver(fakeMessage().message);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });
});

describe("inbound mail worker: the pause", () => {
  it("asks the sender to retry, without reading the message or calling the BFF", async () => {
    const fetchMock = stubFetch(respond(202));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message, { ...ENV, PAUSED: "true" })).rejects.toThrow("paused");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(setReject).not.toHaveBeenCalled();
    expect(message.raw.locked).toBe(false);
  });

  it("still refuses an address that is not project-shaped while paused", async () => {
    stubFetch(respond(202));
    const { message, setReject } = fakeMessage("contact@piloti.test");
    await deliver(message, { ...ENV, PAUSED: "true" });
    expect(setReject).toHaveBeenCalledWith(UNKNOWN_ADDRESS_TEXT);
  });
});

describe("inbound mail worker: the verdict contract", () => {
  it.each(contract.cases)(
    "$status with verdict $verdict means $outcome ($note)",
    async ({ status, verdict, outcome }) => {
      stubFetch(respond(status, verdict === null ? {} : { [VERDICT_HEADER]: verdict }));
      const { message, setReject } = fakeMessage();
      if (outcome === "retry") {
        await expect(deliver(message)).rejects.toThrow(String(status));
        expect(setReject).not.toHaveBeenCalled();
        return;
      }
      await expect(deliver(message)).resolves.toBeUndefined();
      if (outcome === "rejected") expect(setReject).toHaveBeenCalledWith(REJECT_TEXT);
      else expect(setReject).not.toHaveBeenCalled();
    },
  );

  it("bounces only an unknown or switched-off address and an oversized mail, never a closed project's mail", () => {
    const rejects = contract.cases.filter((c) => c.outcome === "rejected").map((c) => c.status);
    expect(rejects.sort()).toEqual([404, 413]);
    expect(contract.cases.find((c) => /closed project/.test(c.note))?.outcome).toBe("accepted");
  });

  it("accepts a 2xx even if it carries the reject header", async () => {
    // Any 2xx means the BFF took the mail; bouncing it would tell the sender
    // it was lost when it was not.
    stubFetch(respond(202, REJECT));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).resolves.toBeUndefined();
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 410, 413, 422])(
    "rejects a %i that carries x-inbound-verdict: reject, with the one generic text",
    async (status) => {
      stubFetch(respond(status, REJECT));
      const { message, setReject } = fakeMessage();
      await expect(deliver(message)).resolves.toBeUndefined();
      expect(setReject).toHaveBeenCalledTimes(1);
      expect(setReject).toHaveBeenCalledWith(REJECT_TEXT);
    },
  );

  it.each([
    [401, "a refused signature: a rotated key, a skewed clock"],
    [404, "a BFF_URL pointed at the wrong host, or a route not deployed yet"],
    [409, "the BFF is busy with the same message"],
    [413, "the edge cut the body"],
    [429, "the BFF's rate limit"],
  ])("throws on a bare %i (%s) so the sender retries", async (status) => {
    stubFetch(respond(status));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow(String(status));
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([500, 502, 503, 504])("throws on %i so the sender retries", async (status) => {
    stubFetch(respond(status));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow(String(status));
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([301, 302, 307, 308])("throws on a %i redirect", async (status) => {
    stubFetch(respond(status, { location: "https://elsewhere.example/" }));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow(String(status));
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([302, 500, 503])("ignores the reject header outside 4xx: %i throws", async (status) => {
    // The verdict is a 4xx's qualifier. A 5xx or a redirect with the header is
    // not a refusal the BFF can stand behind, so it stays a retry.
    stubFetch(respond(status, REJECT));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow(String(status));
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each(["", "retry", "rejected", "reject, retry"])(
    "throws on a 404 whose verdict is %j rather than exactly reject",
    async (verdict) => {
      stubFetch(respond(404, { [VERDICT_HEADER]: verdict }));
      const { message, setReject } = fakeMessage();
      await expect(deliver(message)).rejects.toThrow("404");
      expect(setReject).not.toHaveBeenCalled();
    },
  );

  it("gives up on a hung BFF after the timeout, and throws rather than rejects", async () => {
    // The fetch carries the abort signal; a fetch it aborts rejects with it.
    const fetchMock = stubFetch(() =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { message, setReject } = fakeMessage();

    await expect(deliver(message)).rejects.toThrow("timed out");

    expect(timeout).toHaveBeenCalledWith(BFF_TIMEOUT_MS);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
    expect(setReject).not.toHaveBeenCalled();
  });

  it("throws on a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("network connection lost")));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow("network connection lost");
    expect(setReject).not.toHaveBeenCalled();
  });
});

describe("inbound mail worker: the bounce texts", () => {
  it("links the help and privacy pages of shared/public-site.json", () => {
    const { origin, paths } = publicSite;
    expect(REJECT_TEXT).toContain(`Help: ${origin}${paths.mailInbox}`);
    expect(REJECT_TEXT).toContain(`Privacy: ${origin}${paths.privacy}`);
  });

  it.each([REJECT_TEXT, UNKNOWN_ADDRESS_TEXT])(
    "is printable ASCII and under 300 characters, so it survives as an SMTP reply: %s",
    (text) => {
      expect(text).toMatch(/^[\x20-\x7e]+$/);
      expect(text.length).toBeLessThan(300);
    },
  );

  it("is the same for every rejection, so nothing can be enumerated", async () => {
    const texts: string[] = [];
    for (const { status, verdict } of contract.cases.filter((c) => c.outcome === "rejected")) {
      stubFetch(respond(status, { [VERDICT_HEADER]: String(verdict) }));
      const { message, setReject } = fakeMessage();
      await deliver(message);
      texts.push(setReject.mock.calls[0][0]);
    }
    expect(new Set(texts)).toEqual(new Set([REJECT_TEXT]));
  });
});

/** The address contract both sides run (see its `$comment`). */
interface AddressContract {
  tokenPattern: string;
  cases: { recipient: string; project: boolean; note?: string }[];
}

const ADDRESSES: AddressContract = addressContract;

describe("inbound mail worker: which recipients reach the BFF", () => {
  it("uses the token pattern of shared/inbound-address.json", () => {
    // The BFF's address.spec.ts checks its own pattern against the same file.
    expect(TOKEN_PATTERN).toBe(ADDRESSES.tokenPattern);
  });

  it.each(ADDRESSES.cases.filter((c) => c.project))(
    "posts a project address to the BFF: $recipient",
    async ({ recipient }) => {
      const fetchMock = stubFetch(respond(202));
      const { message, setReject } = fakeMessage(recipient);
      await deliver(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(setReject).not.toHaveBeenCalled();
    },
  );

  it.each(ADDRESSES.cases.filter((c) => !c.project))(
    "refuses any other address itself, without a request: $recipient",
    async ({ recipient }) => {
      // The catch-all hands the Worker every unrouted address on the product
      // domain. Only project addresses are the BFF's business.
      const fetchMock = stubFetch(respond(202));
      const { message, setReject } = fakeMessage(recipient);
      await expect(deliver(message)).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(setReject).toHaveBeenCalledWith(UNKNOWN_ADDRESS_TEXT);
      expect(message.raw.locked).toBe(false);
    },
  );
});
