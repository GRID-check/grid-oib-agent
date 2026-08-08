import * as k8s from "@pulumi/kubernetes";

/**
 * Container-level securityContext that satisfies the Pod Security "restricted"
 * profile for the images we build ourselves (backend UID 1000, frontend UID
 * 1001 — both already run as non-root). Applied to every first-party workload
 * container so a compromised process can't escalate, keep host capabilities, or
 * escape the default seccomp sandbox.
 *
 * `readOnlyRootFilesystem` is intentionally left off: the backend writes
 * `/app/data`, the frontend keeps a Next.js runtime cache, and the workers write
 * a `/tmp` liveness marker. The four levers below are the ones that harden
 * without breaking those writes.
 */
export function hardenedContainerSecurityContext(): k8s.types.input.core.v1.SecurityContext {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
}

/**
 * A lighter context for short-lived bootstrap Jobs that run third-party images
 * (postgres, curl, weed) which may not start as a fixed non-root UID. Drops all
 * capabilities and pins seccomp without forcing a UID, so it never breaks an
 * image's own entrypoint while still removing ambient privilege.
 */
export function hardenedJobSecurityContext(): k8s.types.input.core.v1.SecurityContext {
  return {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
}
