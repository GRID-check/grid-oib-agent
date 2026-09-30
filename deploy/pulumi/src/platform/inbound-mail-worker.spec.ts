import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { REJECT_TEXT, type InboundMailEnv } from "./inbound-mail-worker.js";

/**
 * The Email Worker's whole job is a mapping: BFF status to accept, reject or
 * retry. Each branch decides whether a sender's mail bounces for good or is
 * retried for days, so every one is pinned here against a stubbed `fetch`.
 */

const ENV: InboundMailEnv = {
  BFF_URL: "https://app.example.test",
  INBOUND_MAIL_TOKEN: "inbound-token", // pragma: allowlist secret
};

function fakeMessage() {
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Subject: Plan\r\n\r\nbody"));
      controller.close();
    },
  });
  return {
    from: "bounce@sender.example",
    to: "wohnbau.abcdefghijkl@eingang.example.test",
    raw,
    rawSize: 22,
    setReject: vi.fn<(reason: string) => void>(),
  };
}

function stubFetch(answer: () => Promise<Response>) {
  const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>(answer);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const respond = (status: number) => () => Promise.resolve(new Response(null, { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inbound mail worker", () => {
  it("posts the raw message to the BFF route with the contract's headers", async () => {
    const fetchMock = stubFetch(respond(200));
    const message = fakeMessage();

    await worker.email(message, ENV);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://app.example.test/api/internal/inbound-mail");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "x-grid-internal-token": "inbound-token", // pragma: allowlist secret
      "x-envelope-to": "wohnbau.abcdefghijkl@eingang.example.test",
      "x-envelope-from": "bounce@sender.example",
      "content-type": "message/rfc822",
    });
  });

  it("passes the body through untouched, as the same stream", async () => {
    // Identity, not equality: the Worker must not read, buffer or re-encode the
    // message. Reading it would cost CPU per byte and could alter what the
    // BFF's DKIM check sees.
    const fetchMock = stubFetch(respond(200));
    const message = fakeMessage();

    await worker.email(message, ENV);

    expect(fetchMock.mock.calls[0][1]?.body).toBe(message.raw);
    expect(message.raw.locked).toBe(false);
  });

  it("never follows a redirect, which would resend the token elsewhere", async () => {
    const fetchMock = stubFetch(respond(200));
    await worker.email(fakeMessage(), ENV);
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([200, 202, 204])("accepts on %i", async (status) => {
    stubFetch(respond(status));
    const message = fakeMessage();
    await expect(worker.email(message, ENV)).resolves.toBeUndefined();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each([403, 404, 413])("rejects on %i with the one generic text", async (status) => {
    stubFetch(respond(status));
    const message = fakeMessage();

    await expect(worker.email(message, ENV)).resolves.toBeUndefined();

    expect(message.setReject).toHaveBeenCalledTimes(1);
    expect(message.setReject).toHaveBeenCalledWith(REJECT_TEXT);
  });

  it("uses the same text for every rejection, so nothing can be enumerated", async () => {
    const texts: string[] = [];
    for (const status of [403, 404, 413]) {
      stubFetch(respond(status));
      const message = fakeMessage();
      await worker.email(message, ENV);
      texts.push(message.setReject.mock.calls[0][0]);
    }
    expect(new Set(texts).size).toBe(1);
    expect(texts[0]).toBe(
      "Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt, oder der " +
        "Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht verifizierbar. Bitte laden " +
        "Sie die Dateien direkt in Piloti hoch.",
    );
  });

  it.each([429, 500, 502, 503, 504])("throws on %i so the sender retries", async (status) => {
    stubFetch(respond(status));
    const message = fakeMessage();
    await expect(worker.email(message, ENV)).rejects.toThrow(String(status));
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it.each([301, 302, 400, 401, 409, 422])("throws on unmapped %i", async (status) => {
    stubFetch(respond(status));
    const message = fakeMessage();
    await expect(worker.email(message, ENV)).rejects.toThrow();
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it("throws on a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("network connection lost")));
    const message = fakeMessage();
    await expect(worker.email(message, ENV)).rejects.toThrow("network connection lost");
    expect(message.setReject).not.toHaveBeenCalled();
  });
});
