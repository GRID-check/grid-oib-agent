# ADR-0031: err2issue — ERROR telemetry becomes deduplicated GitHub issues

Date: 2026-07-28

## Status

Accepted (dev only; prod deployment gated — see Consequences)

## Context

ADR-0029 gave the platform a live telemetry pane: producers export OTLP to the
`otel-collector` Service, which forwards traces, logs and metrics to a .NET
Aspire dashboard. That ADR was explicit about what it bought and what it did
not: an **in-memory ring buffer**, "a live-view tool, not a log archive", with
no alerting.

The gap that leaves is not observability, it is *follow-up*. An error that
happens while nobody is looking at the dashboard is gone on the next pod
restart. There is no record that it occurred, no owner, no way to tell a
first-time failure from one that has been firing for a week, and nothing to
attach a fix to. Errors are visible but not actionable.

The conventional answer is an alerting stack (Alertmanager, PagerDuty, Sentry) —
a second system to run, with its own accounts, retention, routing rules and
per-seat cost, and its own inbox that a small team has to remember to check.

[err2issue](https://github.com/matthiasbigl/err2issue) takes a different angle:
GitHub *is* the store, the inbox and the notification channel. It accepts OTLP,
keeps only ERROR-severity records, redacts, fingerprints (SHA256), suppresses
repeats, and turns each unique fingerprint into exactly one GitHub issue —
carrying the occurrence count in the title (`[x12] …`), plus stack trace,
preceding log context and runtime attributes. Deduplication state lives in
GitHub itself (issue labels used as a distributed mutex), so the service holds
no database.

Two properties made it the right fit here specifically:

1. **The team already lives in this repo's issue tracker.** An error that
   becomes an issue lands in an existing triage flow, with assignment,
   milestones and search already working, at zero additional operational cost.
2. **We just wired up Claude Code GitHub Actions.** An issue containing a
   fingerprint, a stack trace and surrounding log context is exactly the input
   `@claude` needs — an automatically-filed error can be handed to an agent for
   a fix PR without a human transcribing anything. err2issue's own README names
   "an automated fix agent" as an intended consumer.

Options considered:

1. **Alerting stack** (Alertmanager / Grafana OnCall). Mature, flexible
   routing, real on-call rotations. A whole second system to run and pay for,
   and it produces notifications, not tracked work items.
2. **Hosted error tracking** (Sentry). Best-in-class grouping and release
   tracking. Per-seat cost, a second inbox, and tenant telemetry leaves the
   cluster to a third party — the thing ADR-0029's Option 1 analysis was
   already trying to avoid.
3. **err2issue as a second collector consumer.** One small stateless pod, no
   database, no new UI, output lands where the work already happens.
4. **No change.** Keep the live pane; accept that unattended errors vanish.

Chosen: **Option 3**.

## Decision

Deploy err2issue as a single-replica Deployment in the `grid` namespace
(`deploy/pulumi/src/platform/err2issue.ts`) and fan the collector's **logs**
signal out to it alongside the Aspire dashboard.

Key decisions within the approach:

- **A consumer, not an ingestion point.** Producers are untouched: they keep
  exporting plain OTLP to `otel-collector` and know nothing about this pod.
  ADR-0029's amendment made the collector the single ingestion point precisely
  so that adding or swapping a backend is a config change *there* and app-only
  work stays zero. This ADR is the first exercise of that property.

- **A separate `logs/err2issue` pipeline, not an extra exporter on `logs`.**
  The severity filter is per-pipeline. Adding the filter to the existing logs
  pipeline would strip sub-ERROR records from the dashboard too and gut the
  live view; adding the exporter without a filter would ship every INFO and
  DEBUG line to a sink that discards all of them. The two pipelines share the
  `otlp` receiver and diverge after it.

- **Filter at the collector, not at the sink.** `filter/errors_only` drops
  everything below `SEVERITY_NUMBER_ERROR` before export. err2issue would
  discard the same records itself, but only after paying collector egress, sink
  CPU and pod memory for them — at exactly the moment a failing service is
  noisiest. `error_mode: ignore` keeps a malformed record from taking the
  pipeline down, since the dashboard's copy of the signal rides the same
  receiver.

- **Single replica.** Correctness does not require it — GitHub holds the dedup
  state, so N replicas still produce one issue per fingerprint. But suppression
  windows and the daily fingerprint budget are per-pod in-memory counters, so N
  replicas multiply the effective caps by N. One pod keeps the budget honest.
  The sink is on no user-facing path, so a few seconds of unavailability
  mid-roll costs at most a dropped error export, which OTLP already treats as
  best-effort.

- **Network isolation matching the dashboard's.** This pod authenticates
  nobody on its OTLP receiver and holds a GitHub token with Issues write. Left
  in the wholesale `allow-same-namespace` allow, any pod in the namespace —
  including the agent worker running model-chosen tool calls — could forge
  issues into the repo. It is therefore excluded from rule 2 and granted
  exactly one caller, `otel-collector` on 4318, in rule 9. This is the same
  arrangement rules 2/7/8 give the dashboard, for the same reason.

- **Availability = flag AND capability**, following ADR-0029's pattern: the
  sink deploys only when `err2issueEnabled` is set AND a GitHub token and
  fallback repo exist AND the observability tier is on. The dependency on
  observability is structural, not stylistic — with no collector in front of
  it, err2issue has no receiver of its own and could only sit idle.

- **Opt-in (`err2issueEnabled` defaults to false)**, unlike the rest of the
  observability tier. Enabling this component writes to a system *outside the
  cluster*; that should never happen because someone accepted a default.

- **Conservative caps by default**: 20 new fingerprints/day (upstream default
  is 50) and a 600s coalescing window. The realistic first-deployment failure
  is not a runaway loop, it is the long tail of pre-existing, never-noticed
  errors arriving at once and burying the tracker on day one.

## Consequences

### Positive

- Every unique production error becomes a tracked, owned, searchable work item
  with a stack trace and surrounding context — surviving pod restarts, which
  the Aspire ring buffer does not.
- Recurrence is visible and quantified (`[x12]` in the title) rather than
  something you infer by watching a dashboard at the right moment.
- Filed issues are directly consumable by the `@claude` workflow added in
  `.github/workflows/claude.yml`: error → issue → agent-authored fix PR, with
  no human transcription step.
- No new datastore, dashboard, account or per-seat cost. Telemetry does not
  leave the cluster except as issue content the team chose to route.
- Swapping the sink later is a collector config change, exactly as ADR-0029
  intended.

### Negative

- **A new egress path for potentially sensitive data.** err2issue redacts
  before dispatch, but redaction is a filter, not a proof: an error string can
  carry a tenant identifier, a document title, or a fragment of user content,
  and issue bodies are readable by everyone with repo access. Routing errors to
  a private repo is load-bearing, not incidental.
- **The issue tracker becomes partly machine-written.** Triage habits have to
  absorb that; a noisy service can make the tracker less useful before the caps
  are tuned.
- **A GitHub token with write access now lives in the cluster.** Mitigated by
  rule 9's isolation and by scoping the PAT to Issues on one repo, but it is a
  new credential with outward-facing reach.
- The collector's logs path now has a second consumer, so a misconfiguration
  there can affect the dashboard pipeline's health (bounded by
  `error_mode: ignore` and by the pipelines being separate).

### Risks

- **The image is not digest-pinned.** Upstream publishes no tags or releases,
  so `ghcr.io/matthiasbigl/err2issue:latest` is the only reference that exists.
  Every other image in this stack is digest-pinned for supply-chain reasons,
  and the trivy job in `.github/workflows/security.yml` only scans pinned refs.
  A moving tag on a pod holding a repo-write token is not an acceptable prod
  posture. **This is why prod is off**; dev accepts the risk to gather volume
  data.
- **Exceptions carried only as span events are not covered.** This wiring
  forwards the logs signal only. Errors that surface purely as a span status
  never reach the sink. Adding a filtered traces pipeline is a follow-up once
  the logs path is proven.
- **Suppression is per-pod and in memory.** A crash-looping err2issue resets
  its windows and budget, so a restart storm could file more issues than the
  caps imply.

## Alternatives considered

See Context. The decisive factor against both the alerting stack and hosted
error tracking was that they produce *notifications*, whereas the thing this
team was missing was *tracked work items in the place work already happens* —
and, since the GitHub Actions integration landed, a format an agent can act on
directly.

## References

- Upstream: <https://github.com/matthiasbigl/err2issue>
- ADR-0029 (`0029-aspire-dashboard-telemetry.md`) — the collector and dashboard
  this builds on; its amendment established the collector as the single
  ingestion point.
- `deploy/pulumi/src/platform/err2issue.ts` — the workload.
- `deploy/pulumi/src/platform/otel-collector.ts` — the `logs/err2issue`
  pipeline and severity filter.
- `deploy/pulumi/src/platform/network-policies.ts` — rules 2 and 9.
- `.github/workflows/claude.yml` — the `@claude` consumer of filed issues.
