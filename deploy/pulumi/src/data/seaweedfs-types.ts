import * as k8s from "@pulumi/kubernetes";

/**
 * What every SeaweedFS topology must provide, so the rest of the program can be
 * written against the contract rather than against a layout.
 *
 * The two addresses are the reason this interface exists. `weed shell`, the
 * offsite mirror and the metadata snapshot all take an explicit `-master=` /
 * `-filer=`, and under the single-node topology those were the same host as the
 * S3 endpoint. They are not, once the roles are split — so anything that hard
 * codes `seaweedfs:9333` works on one topology and silently hangs on the other
 * (a `weed shell` pointed at a port nothing listens on blocks rather than
 * failing). Pass these through instead.
 */
export interface SeaweedTopology {
  /** Every workload this topology creates, for dependency ordering. */
  workloads: k8s.apps.v1.StatefulSet[];
  /** The `seaweedfs` Service: S3 on 8333, filer on 8888/18888. */
  service: k8s.core.v1.Service;
  /** The Service carrying master HTTP/gRPC. Same object as `service` when the
   *  topology runs everything in one process. */
  masterService: k8s.core.v1.Service;
  /** `host:port` for `weed shell -master=` and `weed volume -mserver=`. */
  masterAddress: string;
  /** `host:port` for `weed filer.backup -filer=` and `weed filer.copy`. */
  filerAddress: string;
  pdbs: k8s.policy.v1.PodDisruptionBudget[];
}
