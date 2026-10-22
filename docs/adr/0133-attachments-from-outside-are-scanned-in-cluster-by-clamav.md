---
status: proposed
date: 2026-10-22
decision-makers: Grid engineering
consulted: the security and shippability red team of the project-mail design
informed: everyone who serves or files bytes a stranger sent
---

# Attachments from outside are scanned in the cluster by ClamAV before anyone can file or download them

## Context and Problem Statement

Until now every file in Piloti was put there by a member of the office: an
upload, a mail-import archive a person chose, a report Piloti wrote. Nothing
scans those bytes; an upload is admitted by its extension, its size and the
content-term screen (ADR-0086), and the external-dependency register says so
("No malware scanning of uploads").

Project mail changes who can put bytes in front of a person. Anyone may write
to a project's address, so attachments arrive from strangers, and a person in
the office opens, previews or files them. A file nobody in the office chose
needs a check before anyone can act on it, and the check must not be a model
reading the file.

The question this record answers: which scanner, where it runs, and what its
answer means when it is not a plain "clean".

## Decision Drivers

- **Fail closed.** No answer, a late answer, a broken answer and a limit hit
  must all mean "not clean". The failure that matters is a scanner that says
  `OK` for bytes it did not inspect.
- **The bytes stay in the cluster.** Attachments are client data under the
  office's processing agreement; a third-party scanning service would be a new
  sub-processor for every mail.
- **Buy, don't build.** Signatures and file-format parsers are somebody else's
  domain. The part we own is the wire protocol and what each answer means.
- **Off by default, prepared.** It lands before the feature that needs it, and
  a stack that has not opted in must plan exactly as before.
- **Testable without the engine.** CI has no clamd (it needs gigabytes of memory
  and minutes to load), so the client is proven against the protocol, and the
  engine at a launch gate.

## Considered Options

1. ClamAV in the cluster (clamd and freshclam), spoken to over INSTREAM by a
   small client in the BFF.
2. A SaaS scanner (VirusTotal, a cloud vendor's malware API).
3. No scanning: rely on the person's own endpoint protection, as uploads do today.

## Decision Outcome

Chosen: **option 1, ClamAV in the cluster**, fail closed and configured to
alert. It keeps every byte inside the deployment, it is the standard
self-hosted engine, and its answers can be made exact.

### Where it runs

- `deploy/pulumi/src/app/clamav.ts`, on the Gotenberg pattern: one Deployment of
  `clamav/clamav` (digest-pinned, scanned by trivy through `ci/pinned_images.py`),
  a Service `clamav:3310`, and an ingress-only NetworkPolicy `clamav-bff-only`
  admitting the `frontend` and `bff-jobs` pods. Egress stays open: freshclam
  needs `database.clamav.net`, which no NetworkPolicy can name.
- The pod runs three containers as the image's `clamav` user: `seed` copies the
  signatures baked into the image onto an emptyDir, `clamd` scans, `freshclam`
  checks for new signatures twelve times a day and tells clamd to load them.
  The image's root entrypoint is skipped.
- Compose has the same service behind `--profile malware-scan`, with the same
  pin and the same two files, `deploy/compose/clamav/{clamd,freshclam}.conf`,
  which Pulumi reads into a ConfigMap. `clamav.spec.ts` holds the two paths equal.
- Off by default: `grid-oib:malwareScanEnabled`. When on, the frontend and the
  bff-jobs pool get `GRID_MALWARE_SCAN_URL=tcp://clamav:3310`.

### What an answer means

The client is `frontends/ui/src/lib/malware-scan/`. Each scan asks `VERSION`,
then streams the bytes with `zINSTREAM` in chunks of at most 64 KiB. The reply
maps exactly:

| clamd says | Verdict |
|---|---|
| `stream: OK` (exactly, NUL-terminated) | `clean` |
| `stream: Heuristics.Limits.Exceeded.<limit> FOUND` | `failed`, `limit-exceeded` |
| `stream: <any other name> FOUND`, `Heuristics.*` included | `infected` |
| `INSTREAM size limit exceeded. ERROR` | `failed`, `limit-exceeded` |
| any other `… ERROR` | `failed`, `scanner-error` |
| anything else, a reply without its NUL, a reset, no connection, no answer in 150 s | `failed` |

`clean` is the only verdict that lets bytes through. `infected` is a finding
about the bytes (the mail can only be dismissed); `failed` says the scanner
could not vouch for them, and the caller scans again later.

**Limits are failures, not findings.** clamd reports a limit it hit
(`MaxRecursion`, `MaxFileSize`, `MaxScanSize`, `MaxScanTime`, `MaxFiles`) as a
heuristic signature. The project-mail design mapped `Heuristics.*` to `infected`,
and its launch gate G6 expects a limit-exceeding archive to give `failed`. This
record takes G6's side for limits only: the bytes were not fully inspected,
which is not evidence of malware, and either verdict keeps them unfileable.

### clamd.conf: alerts instead of silent OKs

With clamd's defaults an encrypted archive, a macro document, a broken
executable and a file over a limit all come back `OK`. The shipped
`clamd.conf` sets `HeuristicAlerts`, `AlertExceedsMax`, `AlertEncrypted`,
`AlertEncryptedArchive`, `AlertEncryptedDoc`, `AlertOLE2Macros` and
`AlertBrokenExecutables` to `yes`, with `ScanMail yes` and `ScanArchive yes` so a
raw message streamed whole is decoded and unpacked by clamd itself.
`HeuristicScanPrecedence no` lets a real signature inside an encrypted or
oversized container be reported by name. `StreamMaxLength 30M` sits above the
largest message the webhook accepts (26 MiB); `MaxScanTime 120000`, and the
other limits written down at clamd's defaults so a release that moves them
cannot loosen them unseen.

A macro document is therefore `infected` and can only be dismissed. That is
deliberately strict for the first slice; an office that receives macro
workbooks by mail is a reason to revisit it, not to switch the alert off.

### Freshness

Every scan reads the signature database's build time from `VERSION`
(`ClamAV 1.5.4/28161/Thu Oct 22 06:24:11 2026`). Older than 48 hours, or with no
database named, the scan fails `stale-signatures` before a byte is sent. The
clamd container's readiness probe applies the same age, so a pod whose freshclam
has stopped updating leaves the Service and shows as not ready. The image's
baked signatures are already days old when it is pulled; the pod becomes ready
once freshclam has fetched the current ones, which it does at start.

### The development scanner

`GRID_MALWARE_SCAN_URL=fake://` selects a fake that finds the EICAR test string
and calls everything else clean, and only where `isDevEnvironment()` holds
(`APP_ENV` development, dev or local). It is never chosen by `NODE_ENV`, never
by default, and Pulumi refuses `grid-oib:malwareScanUrl` on every stack: a
stack's scanner is always its own clamd. Unset, or set to anything the client
does not accept, every scan fails `not-configured`.

### What it never does

- Answer `clean` without the exact `stream: OK` from a clamd whose signatures
  are under 48 hours old.
- Send bytes anywhere but the cluster's own clamd.
- Store what it scanned: bytes arrive on a socket and are gone with the reply.

### Scope

Attachments and raw messages of project mail, and every download of a kept
original, once the inbound-mail feature uses it. Ordinary uploads and chat
attachments are not scanned yet; that is a follow-up (FU6), and the register in
`docs/compliance/external-dependencies.md` keeps saying so until it lands.

### Observability

A scan makes no model call, so it has no Langfuse generation. The verdict, its
failure code and the engine (`version`, `signatures`, `signaturesPublishedAt`)
are returned for the caller to store beside what it scanned; the inbound-mail
jobs record them, and their audit and logs carry codes, never content.

### Consequences

- Good: strangers' bytes are checked in the cluster before a person acts on
  them, and every way the check can fail leaves them unfileable.
- Good: the scanner is off until a stack opts in; with it off the plan is
  unchanged and the BFF fails closed.
- Bad: one more stateful-ish pod with a 2 GiB memory request and an outbound
  dependency on ClamAV's CDN. While freshclam cannot reach it for two days,
  nothing from outside can be filed.
- Bad: ClamAV is a detection engine with known gaps. Measured on 1.5.4: a zip
  member larger than `MaxFileSize` (100 MB) is scanned only up to that size and
  answers `OK`, with no limit alert (`cli_unzip: trimming output size to
  maxfilesize`), while the same oversized member in gzip alerts. A file can hide
  bytes past 100 MB uncompressed inside a 26 MiB mail. The person still decides
  before anything is filed, and G6 records the case.
- Neutral: a single replica. While it restarts, scans fail `unavailable` and are
  retried; a rollout surges and drains, and clamd finishes the scans it holds on
  SIGTERM.

### Confirmation

- `frontends/ui/src/lib/malware-scan/clamd-protocol.spec.ts`: the reply table,
  exactly, every unknown reply failed; the `VERSION` parse.
- `frontends/ui/src/lib/malware-scan/client.spec.ts`: the real client against a
  socket stub that speaks INSTREAM framing: `OK`, `FOUND`, a limit heuristic,
  `INSTREAM size limit exceeded` while the client is still writing, an error
  line, a reset, a reply without its NUL, no listener, a hang, a stale and an
  absent database, chunking, an empty chunk, the size cap, the configuration.
- `frontends/ui/src/lib/malware-scan/config.spec.ts`: `fake://` only in development.
- `deploy/pulumi/src/app/clamav.spec.ts`: the alert settings in clamd.conf, the
  BFF's age and stream limit equal to the probe's and clamd's, the containers'
  user, the probes, the ConfigMap checksum, the env for frontend and bff-jobs,
  the NetworkPolicy, and Compose equal to Pulumi.
- `deploy/pulumi/src/config.spec.ts`: off by default, the digest pin, and
  `malwareScanUrl` refused.
- `deploy/pulumi/index.spec.ts`: off by default, no resource and no URL.
- Launch gate G6: EICAR through the whole path; a limit-exceeding archive and a
  stale database each give `failed`; an infected original's download is refused.

## Pros and Cons of the Options

### 1. ClamAV in the cluster

- Good: no byte leaves the deployment; no new sub-processor.
- Good: the open standard engine, with an official image and a documented
  protocol; we own about a hundred lines of client.
- Bad: memory and an outbound signature feed to operate; detection weaker than
  commercial multi-engine services.

### 2. A SaaS scanner

- Good: more engines, better detection, nothing to operate.
- Bad: every attachment of every office goes to a third party, often outside
  the EU; a new sub-processor and a transfer assessment for each customer.
- Bad: hash-lookup tiers do not scan unknown files; upload tiers make the bytes
  available to the vendor's community.

### 3. No scanning

- Good: nothing to build or run.
- Bad: a stranger's file reaches a person in the office with no check at all,
  and the review step would be the only line. Uploads were accepted without a
  scanner because a member chose every file; mail removes that premise.

## More Information

- The npm clients were evaluated and none bought. `clamscan` 2.4.0 returns its
  error object for an `… ERROR` reply instead of throwing it, so a caller reading
  `isInfected` sees `undefined`; `clamdjs` 1.0.2 calls a reply clean when it
  contains `OK` anywhere; `clamav.js` 0.12.0 maps exactly but is unmaintained
  since 2022 and reads no `VERSION`, so the freshness rule would be ours anyway.
  The client lives in `lib/malware-scan/client.ts`, the socket stub and G6 are
  its oracle.
- Every reply quoted above was taken from `clamav/clamav:1.5.4` running the
  shipped `clamd.conf` on 2026-10-22: EICAR, EICAR inside a zip and inside a
  MIME message, an encrypted zip (`Heuristics.Encrypted.Zip`), twenty nested
  zips (`Heuristics.Limits.Exceeded.MaxRecursion`), a gzip over `MaxFileSize`,
  a 31 MiB stream, and a database four days old refused by the client.
- trivy (`ci/trivy_scan.sh`'s flags, trivy 0.61.1) on the pinned image reported
  no fixable HIGH or CRITICAL finding on 2026-10-22. ClamAV itself is built from
  source in that image, not installed as an Alpine package, so trivy sees the
  base's packages and not ClamAV's own advisories; a ClamAV security release
  is a pin bump.
- G6 is a launch gate of the project-mail feature, run by an operator against a
  real cluster before the first office receives mail; its record lands with that
  feature's runbook in `docs/deployment/kubernetes.md`.
