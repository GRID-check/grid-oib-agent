import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { REJECT_TEXT, type Env } from "./inbound-mail-worker.js";

/**
 * The Email Worker's whole job is a mapping: the BFF's answer to accept, reject
 * or retry. A reject is permanent (the sender's server gives up and the mail is
 * lost); a throw is temporary (it retries for days). So every branch is pinned
 * here against a stubbed `fetch`, and the rule the spec guards above all is
 * that only an explicit `x-inbound-verdict: reject` on a 4xx ever bounces.
 *
 * Type-checked against `@cloudflare/workers-types` by `tsconfig.worker.json`,
 * so the fake message below is the runtime's `ForwardableEmailMessage`, not a
 * shape this file made up.
 */

const ENV: Env = {
  BFF_URL: "https://app.example.test",
  INBOUND_MAIL_TOKEN: "inbound-token", // pragma: allowlist secret
};

/** The handler never touches the execution context. */
const CTX = {} as ExecutionContext;

const RAW = new TextEncoder().encode("Subject: Plan\r\n\r\nbody");

function fakeMessage() {
  const setReject = vi.fn<(reason: string) => void>();
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(RAW);
      controller.close();
    },
  });
  const message: ForwardableEmailMessage = {
    from: "bounce@sender.example",
    to: "wohnbau.abcdefghijkl@eingang.example.test",
    raw,
    rawSize: RAW.byteLength,
    headers: new Headers(),
    setReject,
    forward: () => Promise.reject(new Error("the Worker must not forward")),
    reply: () => Promise.reject(new Error("the Worker must not reply")),
  };
  return { message, setReject };
}

async function deliver(message: ForwardableEmailMessage): Promise<void> {
  if (!worker.email) throw new Error("the Worker exports no email handler");
  await worker.email(message, ENV, CTX);
}

function stubFetch(answer: () => Promise<Response>) {
  const fetchMock =
    vi.fn<(input: URL | RequestInfo, init?: RequestInit) => Promise<Response>>(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const respond =
  (status: number, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(new Response(null, { status, headers }));

const REJECT = { "x-inbound-verdict": "reject" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inbound mail worker: the request", () => {
  it("posts the raw message to the BFF route with the contract's headers", async () => {
    const fetchMock = stubFetch(respond(202));

    await deliver(fakeMessage().message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://app.example.test/api/internal/inbound-mail");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "x-grid-internal-token": "inbound-token", // pragma: allowlist secret
      "x-envelope-to": "wohnbau.abcdefghijkl@eingang.example.test",
      // Not content-length: Workers ignores a Content-Length set by hand on a
      // stream body and sends it chunked, so the size rides in its own header.
      "x-inbound-raw-size": String(RAW.byteLength),
      "content-type": "message/rfc822",
    });
  });

  it("passes the body through untouched, as the same stream", async () => {
    // Identity, not equality: the Worker must not read, buffer or re-encode the
    // message. Reading it would cost CPU per byte and could alter what the
    // BFF's DKIM check sees.
    const fetchMock = stubFetch(respond(202));
    const { message } = fakeMessage();

    await deliver(message);

    expect(fetchMock.mock.calls[0][1]?.body).toBe(message.raw);
    expect(message.raw.locked).toBe(false);
  });

  it("never follows a redirect, which would resend the token elsewhere", async () => {
    const fetchMock = stubFetch(respond(202));
    await deliver(fakeMessage().message);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });
});

describe("inbound mail worker: the verdict contract", () => {
  it.each([200, 202, 204])("accepts on %i", async (status) => {
    stubFetch(respond(status));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).resolves.toBeUndefined();
    expect(setReject).not.toHaveBeenCalled();
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

  it("does not bounce a token mismatch: a bare 403 throws and never rejects (K3)", async () => {
    // The BFF answers a wrong or rotated INBOUND_MAIL_TOKEN with 403 and no
    // verdict. Before the header contract, that status alone bounced every
    // mail for good until an operator noticed. It must be a retry.
    stubFetch(respond(403));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow("403 without a reject verdict");
    expect(setReject).not.toHaveBeenCalled();
  });

  it.each([
    [401, "an auth failure between Worker and BFF"],
    [404, "a BFF_URL pointed at the wrong host, or a route not deployed yet"],
    [409, "the BFF is busy with the same message"],
    [413, "a proxy in front of the BFF cut the body"],
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
    "throws on a 403 whose verdict is %j rather than exactly reject",
    async (verdict) => {
      stubFetch(respond(403, { "x-inbound-verdict": verdict }));
      const { message, setReject } = fakeMessage();
      await expect(deliver(message)).rejects.toThrow("403");
      expect(setReject).not.toHaveBeenCalled();
    },
  );

  it("throws on a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("network connection lost")));
    const { message, setReject } = fakeMessage();
    await expect(deliver(message)).rejects.toThrow("network connection lost");
    expect(setReject).not.toHaveBeenCalled();
  });
});

describe("inbound mail worker: the bounce text", () => {
  it("is the one agreed text, with the help and privacy links", () => {
    expect(REJECT_TEXT).toBe(
      "Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt, oder der " +
        "Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht verifizierbar. " +
        "Hilfe: https://piloti.at/e-mail-eingang/ Datenschutz: https://piloti.at/datenschutz/",
    );
  });

  it("is printable ASCII and under 300 characters, so it survives as an SMTP reply", () => {
    // An SMTP reply line is ASCII unless the sender negotiated SMTPUTF8, and
    // long replies get cut or wrapped by the relaying servers.
    expect(REJECT_TEXT).toMatch(/^[\x20-\x7e]+$/);
    expect(REJECT_TEXT.length).toBeLessThan(300);
  });

  it("is the same for every rejection, so nothing can be enumerated", async () => {
    const texts: string[] = [];
    for (const status of [403, 404, 413]) {
      stubFetch(respond(status, REJECT));
      const { message, setReject } = fakeMessage();
      await deliver(message);
      texts.push(setReject.mock.calls[0][0]);
    }
    expect(new Set(texts)).toEqual(new Set([REJECT_TEXT]));
  });
});
