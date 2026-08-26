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
| Edit `Pulumi.<stack>.yaml` | Append new keys **below** the encrypted secrets block, leaving those lines untouched | They are encrypted by the stack's Pulumi-Cloud key and deliberately committed. detect-secrets' filter here is line-scoped, so inserting a key above them shifts every line and breaks the next unlucky PR |
| Add a replica | Check the tier scales. The chat/web tier is single-replica, pending the ingest-status and reaper-lock follow-up | Conversation affinity (ADR-0028) is what makes the agent tier scale; the web tier does not have it yet |

## Reference

- [`pulumi/README.md`](pulumi/README.md) explains the committed-secrets design.
- [`docs/deployment/kubernetes.md`](../docs/deployment/kubernetes.md) §6.3 has
  the open scaling follow-ups; [`docs/deployment/docker-compose.md`](../docs/deployment/docker-compose.md)
  is the service reference.
- ADR-0020 (Dragonfly), ADR-0029 (Aspire telemetry), ADR-0043 (SeaweedFS topology).
