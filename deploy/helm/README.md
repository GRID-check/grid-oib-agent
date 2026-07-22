# Kubernetes deployment → see `deploy/pulumi`

Helm charts are not used for this project. The Kubernetes deployment is defined
as code with **Pulumi (TypeScript)** in [`deploy/pulumi`](../pulumi), which
installs the app workloads plus the supporting operators/charts it needs
(cert-manager, ingress-nginx, CloudNativePG) against a provider-supplied
kubeconfig.

- Deploy steps: [`deploy/pulumi/README.md`](../pulumi/README.md)
- Architecture, storage/SeaweedFS decisions, and the agent-scaling roadmap:
  [`docs/deployment/kubernetes.md`](../../docs/deployment/kubernetes.md)
