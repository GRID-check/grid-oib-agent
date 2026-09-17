# OIB corpus — provided by the platform owner, not by this repository

This directory is where the OIB Richtlinien PDFs live at runtime. It ships
**empty**: the corpus is licensed material that belongs to whoever operates the
platform, and 71 MB of binaries in git made every clone pay for documents that
change once a year and that an operator can supply in a minute.

There are two ways to fill it, and they are equivalent from the agent's side:

- **Upload through the platform-admin UI.** Files land in `OIB_UPLOADS_DIR`
  (`data/oib_uploads`, on the persistent data volume) and are ingested by the
  same background sync. This is the path a running deployment should use.
- **Drop PDFs in here before first boot.** Both Compose files bind-mount this
  directory read-only, and `oib_sync.discover_pdfs()` reads it alongside the
  uploads directory. Useful for a local stack or for seeding a fresh volume.

Either way the sync is incremental and hash-gated (`data/oib_registry.json`),
so re-running it costs nothing for files that have not changed.

`*.pdf` here is gitignored. Do not commit the corpus back.

The filename convention matters: `oib_doc_class` in
`src/aiq_agent/common/norm_registry.py` derives a document's class from its
prefix (`oib-rl_`, `erlaeuterungen_`, `aenderungen_`), and
`frontends/ui/src/lib/oib/standards-catalog.ts` lists the expected names. Keep
the published filenames.
