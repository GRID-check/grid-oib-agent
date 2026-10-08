# A local copy of the OIB corpus, for the evals and tests

The running platform does not read this directory. Its base corpus lives in
object storage and is uploaded through the platform-admin UI (or
`scripts/upload_oib_corpus.py data/oib`, which sends every PDF in a directory
through the same admin route); see
[`docs/technical-reference/oib-sync.md`](../../docs/technical-reference/oib-sync.md).

What reads `data/oib` is the offline tooling: the retrieval benchmarks
(`frontends/benchmarks/oib_retrieval`), the answer-suite census and the filename
tests in `tests/aiq_agent/common/test_norm_registry.py`. They need the
Richtlinien PDFs on disk, and the corpus is licensed material that belongs to
whoever operates the platform, so this directory ships **empty**: 71 MB of
binaries in git made every clone pay for documents that change once a year.
Put the PDFs here yourself; those tests skip when there are none.

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
