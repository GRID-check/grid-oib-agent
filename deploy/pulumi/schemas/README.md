# Vendored CRD schemas (for `scripts/validate-crs.mjs`)

`cnpg-crds.yaml` — the Cluster / ScheduledBackup / Backup CRDs extracted from
the upstream CloudNativePG release manifest. Used to schema-validate the
untyped CNPG CustomResources in the Pulumi plan (tsc cannot check those).

Refresh (bump the version to the release you want to validate against):

```bash
curl -sSL https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/releases/cnpg-1.28.0.yaml \
  | python3 -c "
import sys, yaml
docs = [d for d in yaml.safe_load_all(sys.stdin)
        if d and d.get('kind') == 'CustomResourceDefinition'
        and d['spec']['names']['kind'] in ('Cluster','ScheduledBackup','Backup')]
yaml.safe_dump_all(docs, open('deploy/pulumi/schemas/cnpg-crds.yaml','w'), sort_keys=False)"
```

Gateway API / Envoy Gateway / cert-manager kinds don't need vendoring — their
schemas come from the `@kubernetes-models/*` packages in `devDependencies`.
