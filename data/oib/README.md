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
prefix, and `oib_family_member` and `guess_display_title` read the Richtlinie
number from it. Keep the names exactly as oib.or.at publishes them, which is not
one spelling:

| Document | Most parts (2023) | OIB-RL 2.2 |
|---|---|---|
| Richtlinie | `oib-rl_2.1_ausgabe_mai_2023.pdf` | `oib-richtlinie_2.2_ausgabe_mai_2023.pdf` |
| Erläuterungen | `erlaeuterungen_oib-rl_2.1_…` | `erlaeuterungen-zu-oib-richtlinie_2.2_…` |
| Änderungen | `aenderungen_oib-rl_2.1_…` | `aenderungen_oib-richtlinie_2.2_…` |

`canonical_oib_file_name` maps both spellings onto one before parsing. The
Änderungen diff documents are kept out of retrieval by name
(`knowledge_search.exclude_file_names` in `configs/config_oib_openrouter.yml`),
so a new published name there needs a new line in that list;
`TestPublishedOibFilenames` in `tests/aiq_agent/common/test_norm_registry.py`
fails until it has one.
