import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMessage,
  dkimVerdict,
  EICAR,
  headerFields,
  messageOfSize,
  organizationalDomain,
  signedHeaders,
  splitMbox,
} from "./inbound-mail-smoke";

/**
 * The launch-gate tool's own logic (`scripts/inbound-mail-smoke.ts`). The
 * gates themselves run against a deployed stack and are never run here; what
 * is pinned is that its probes are what they claim to be: signed exactly as
 * the Worker signs (the shared vectors), of exactly the size a gate names, and
 * that G9 counts only what the receiving server vouched for.
 */

const SCRIPT = join(__dirname, "inbound-mail-smoke.ts");
const VECTORS = JSON.parse(
  readFileSync(join(__dirname, "../../../shared/inbound-mail-signature.json"), "utf8"),
) as {
  vectors: Array<{
    keyId: string;
    secret: string;
    created: number;
    bodyBase64: string;
    expected: { url: string; headers: Record<string, string> };
  }>;
};

describe("the probes' signatures", () => {
  it.each(VECTORS.vectors.map((v, i) => [i, v] as const))("match signature vector %i", async (_i, vector) => {
    const headers = await signedHeaders({
      url: vector.expected.url,
      body: Buffer.from(vector.bodyBase64, "base64"),
      keyId: vector.keyId,
      secret: vector.secret,
      envelopeTo: vector.expected.headers["x-envelope-to"],
      envelopeFrom: vector.expected.headers["x-envelope-from"],
      created: new Date(vector.created * 1000),
    });
    expect(headers).toEqual(vector.expected.headers);
  });
});

describe("the probe messages", () => {
  it.each([64 * 1024, 1024 * 1024, 24 * 1024 * 1024, 26 * 1024 * 1024 + 1])("builds a message of exactly %i bytes", (size) => {
    expect(messageOfSize("p.k3m7q2xw4pab@piloti.test", "size", size).byteLength).toBe(size);
  });

  it("is CRLF throughout, with base64 lines of at most 76 characters", () => {
    const raw = buildMessage({
      to: "p.k3m7q2xw4pab@piloti.test",
      subject: "EICAR",
      text: "hello",
      attachments: [{ name: "eicar.com.txt", contentType: "text/plain", bytes: Buffer.from(EICAR) }],
    }).toString("latin1");
    expect(raw).not.toMatch(/[^\r]\n/);
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(120);
    expect(raw).toContain(Buffer.from(EICAR).toString("base64").slice(0, 76));
    expect(raw).toMatch(/^Subject: \[smoke\] EICAR$/m);
  });

  it("gives every message its own Message-ID, so a re-run is never a duplicate", () => {
    const id = (raw: Buffer) => /^Message-ID: (.*)$/m.exec(raw.toString())?.[1];
    const args = { to: "p.k3m7q2xw4pab@piloti.test", subject: "x", text: "x" };
    expect(id(buildMessage(args))).not.toBe(id(buildMessage(args)));
  });
});

describe("G9: the aligned DKIM share", () => {
  const message = (results: string[], from = "Mag. Huber <huber@ma37.wien.gv.at>") =>
    [...results.map((r) => `Authentication-Results: ${r}`), `From: ${from}`, "Subject: x", "", "body"].join("\r\n");

  it("counts a pass signed by the From domain's organization", () => {
    expect(dkimVerdict(message(["mx.office.example; dkim=pass header.d=wien.gv.at; dmarc=pass"]))).toEqual({
      hasResults: true,
      dkimPass: true,
      alignedDkimPass: true,
      dmarcPass: true,
    });
  });

  it("counts a pass by a third party (a newsletter service) as not aligned", () => {
    const verdict = dkimVerdict(message(["mx; dkim=pass header.d=mcsv.net; dmarc=fail"]));
    expect(verdict).toMatchObject({ dkimPass: true, alignedDkimPass: false, dmarcPass: false });
  });

  it("reads header.i when header.d is absent, and folded headers", () => {
    const raw = message(["mx;\r\n dkim=pass\r\n header.i=@statik-weber.at"], "office@mail.statik-weber.at");
    expect(dkimVerdict(raw).alignedDkimPass).toBe(true);
  });

  it("trusts only the topmost Authentication-Results, the receiving server's", () => {
    const raw = message(["mx; dkim=fail header.d=wien.gv.at", "forged; dkim=pass header.d=wien.gv.at"]);
    expect(dkimVerdict(raw)).toMatchObject({ dkimPass: false, alignedDkimPass: false });
  });

  it("reports a message without results as such", () => {
    expect(dkimVerdict(message([])).hasResults).toBe(false);
  });

  it.each([
    ["ma37.wien.gv.at", "wien.gv.at"],
    ["mail.statik-weber.at", "statik-weber.at"],
    ["Example.CO.UK.", "example.co.uk"],
    ["piloti.at", "piloti.at"],
  ])("takes %s's organizational domain as %s", (domain, org) => {
    expect(organizationalDomain(domain)).toBe(org);
  });

  it("splits an mbox and undoes its From-quoting", () => {
    const parts = splitMbox("From a@x Mon\nSubject: one\n\n>From here\nFrom b@y Tue\nSubject: two\n\nbody\n");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("\nFrom here");
    expect(headerFields(parts[1])).toEqual([["subject", "two"]]);
  });
});

describe("the command line", () => {
  const run = (...args: string[]) =>
    spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

  it("prints every gate and sends nothing by default", () => {
    const result = run();
    expect(result.status).toBe(0);
    for (const gate of ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"]) expect(result.stdout).toContain(` ${gate} `);
  });

  it("refuses to send without --run, even with nothing configured", () => {
    const result = run("signed");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Add --run to send them");
  });

  it("stops on a missing input rather than guessing one", () => {
    const result = run("signed", "--run");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("INBOUND_MAIL_TEST_ADDRESS is not set");
  });
});
