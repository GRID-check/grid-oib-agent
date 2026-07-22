# Deploy

This directory contains deployment assets for the AI-Q blueprint.

## Docker Compose

Use Docker Compose to run the backend, UI, and PostgreSQL locally:

- [compose/README.md](compose/README.md)

## Kubernetes (Pulumi)

Deploy the full stack to a Kubernetes cluster with the Pulumi (TypeScript)
program — backend, frontend, workers, CloudNativePG Postgres, Dragonfly, and
SeaweedFS, behind ingress-nginx + cert-manager TLS:

- [pulumi/README.md](pulumi/README.md) — deploy steps
- [../docs/deployment/kubernetes.md](../docs/deployment/kubernetes.md) —
  architecture, storage/SeaweedFS decisions, and the agent-scaling roadmap
