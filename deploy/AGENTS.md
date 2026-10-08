# Infrastructure: `deploy/`

Three deployment paths off one image set: Docker Compose (`compose/`, plus a
Coolify variant), Helm charts (`helm/`), and the Pulumi TypeScript program
(`pulumi/`) that is the Kubernetes source of truth.

`pulumi/` and `pulumi/policy/` are two Node programs with separate lockfiles.
`task setup` installs both. `infra:preview` needs stack credentials;
`infra:types` and `infra:test` do not.

## Obligations

| When you | You must | What fails you |
|---|---|---|
| Change a manifest | Add or update a case in `index*.spec.ts` | `typecheck` proves the program is well-typed and nothing about the manifests. Every SeaweedFS bug in this repo's history was a string: a renamed flag, a Service missing the gRPC port `weed shell` needs, a probe pointed at an endpoint that answers 423 |
| Add a service | Add it to Compose **and** Pulumi, or say in the PR why only one | The paths silently diverge and the difference is found in production |
| Edit `Pulumi.<stack>.yaml` | Leave the `secure:` values untouched; set or rotate one only with `pulumi config set --secret` | They are encrypted by the stack's Pulumi-Cloud key and deliberately committed. |
| Add or change a KEDA ScaledObject | Build a queue tier's through `installQueueScaledObject` (`pulumi/src/app/keda-scaling.ts`) and give it a `fallback`; a tier with a `cpu` trigger cannot have one. Point its trigger at a login that cannot write (`grid_keda_scaler`, `queue-scaler-grants.ts`), never the owner's DSN | `keda-scaling.spec.ts`. Otherwise a trigger KEDA cannot read leaves the tier at its count while the queue grows, and nothing alerts |
| Raise `ingestWorkerMaxReplicas`, its concurrency or `vlmBatchWorkers` | Check it against `vlmFleetConcurrency`: peak vision calls may be at most 2x the pool, and the pool at most `providerModelLimitCeiling` and `providerLimitCeiling` | `assertVlmPeakFitsCeiling` fails the plan with the numbers. Replicas past it only wait for a slot |
| Add a replica | Read the tier's own module under `deploy/pulumi/src/app/` first. `frontend.ts` and `web.ts` are HPA-owned, so their count is not yours to set | Both carry `ignoreChanges: ["spec.replicas"]`, so a hand-set count is reverted. The agent tier's count is static while `chatAffinity` is on (ADR-0028: the hash is taken modulo it) and KEDA's, on running turns, once it is off (ADR-0080, `backend-scaling.ts`); `agent-worker` executes jobs (ADR-0021) |

## Reference

- [`pulumi/README.md`](pulumi/README.md) explains the committed-secrets design.
- [`docs/deployment/kubernetes.md`](../docs/deployment/kubernetes.md) §6.3 has
  the open scaling follow-ups; [`docs/deployment/docker-compose.md`](../docs/deployment/docker-compose.md)
  is the service reference.
- ADR-0020 (Dragonfly), ADR-0029 (Aspire telemetry), ADR-0043 (SeaweedFS topology).
