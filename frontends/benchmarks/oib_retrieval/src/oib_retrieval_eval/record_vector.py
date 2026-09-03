"""Record the VECTOR channel's file-level ranking for every golden question.

WHY THIS EXISTS
---------------
The golden harness scored two of production's three retrieval channels — the
exact ``$contains`` pass and the German sparse index — and left the vector
channel out because it needs a model, a key and the corpus. That omission is
not a detail. Measured with the production embedder over the real corpus, the
vector channel alone answers the overview cohort at recall@16 0.933 while the
two deterministic channels together manage 0.150. A harness reporting only the
0.150 makes any movement in the deterministic channels look like the whole
story, and it once made a change that widened a channel to 92% of the corpus
read as a 4x improvement.

So the vector channel is RECORDED: embedded once here, against the real
``data/oib`` corpus with the production model, and written to a fixture the
offline harness reads. CI stays offline, deterministic and key-free; the
number is a measurement rather than a model of one.

WHAT IS RECORDED, AND WHAT THAT COSTS
-------------------------------------
Per golden question, the file-level ranking over the corpus plus each file's
best chunk score — not the vectors. 30 questions x 39 files is a fixture a
human can read and diff; 3072-dimensional vectors for every chunk are 15 MB
nobody would review. The cost is that the recording cannot be re-derived from
the fixture: change the embedder, the chunking or the corpus and this file is
stale, which is why it carries the model name and the corpus fingerprint it
was made with, and the golden test pins that model against the deployed one
(``deploy/compose/docker-compose.coolify.yaml``) so a stale fixture fails CI
rather than quietly scoring the wrong embedder.

The chunks here are sampled PAGES, not production's chunks: page text carrying
the same ``MetadataMode.EMBED`` header production embeds (the filename is in
that header on purpose — ``EMBED_EXCLUDED_METADATA_KEYS`` keeps ``file_name``
because "those are what users actually ask by"). File-level recall is stable
under that difference in a way chunk-level recall would not be, which is why
this records files and the golden set labels files.

USAGE
-----
    task be:eval:record-vector      # needs the embeddings key
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import urllib.request
from pathlib import Path

#: Pages sampled per corpus document. Four is enough for a file to register in
#: a file-level ranking and keeps one recording inside a few hundred embeddings.
PAGES_PER_DOC = 4

#: Deterministic page sampling, so a re-recording without a corpus change
#: produces the same pages and the diff shows model drift, not sampling noise.
SAMPLE_SEED = 0

#: Chunk text cap, near production's chunk size.
MAX_CHUNK_CHARS = 2000

_BATCH = 64

DEFAULT_MODEL = os.environ.get("AIQ_EMBED_MODEL", "openai/text-embedding-3-large")
DEFAULT_BASE_URL = os.environ.get("AIQ_EMBED_BASE_URL", "https://openrouter.ai/api/v1")


def default_fixture_path() -> Path:
    return Path(__file__).resolve().parents[2] / "fixtures" / "vector_channel_recorded.json"


def resolve_api_key(base_url: str, model: str) -> str:
    """Production's own key chain, imported when it is importable.

    The fallback is the same chain by hand, so this script still runs from a
    checkout that has not installed the knowledge layer.
    """
    try:
        from knowledge_layer.llamaindex.adapter import _resolve_embed_api_key

        key = _resolve_embed_api_key(base_url, model)
        if key:
            return key
    except Exception:  # noqa: BLE001 - the hand chain below is the whole point
        pass
    for env in ("AIQ_EMBED_API_KEY", "NVIDIA_API_KEY", "OPENROUTER_KEY", "OPENROUTER_API_KEY"):
        value = os.environ.get(env)
        if value:
            return value
    raise SystemExit("No embeddings key: set AIQ_EMBED_API_KEY (or the provider key for AIQ_EMBED_BASE_URL).")


def embed(texts: list[str], *, model: str, base_url: str, api_key: str) -> list[list[float]]:
    """Embed ``texts`` in order through the configured embeddings endpoint."""
    vectors: list[list[float]] = []
    for start in range(0, len(texts), _BATCH):
        batch = texts[start : start + _BATCH]
        request = urllib.request.Request(
            f"{base_url.rstrip('/')}/embeddings",
            data=json.dumps({"model": model, "input": batch}).encode(),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=180) as response:
            payload = json.load(response)["data"]
        vectors.extend(item["embedding"] for item in sorted(payload, key=lambda item: item["index"]))
        print(f"  embedded {min(start + _BATCH, len(texts))}/{len(texts)}", file=sys.stderr)
    return vectors


def read_corpus(corpus_dir: Path) -> list[tuple[str, int, str]]:
    """Sampled (file_name, page, text) triples from the real corpus PDFs."""
    import pdfplumber

    rng = random.Random(SAMPLE_SEED)
    chunks: list[tuple[str, int, str]] = []
    for path in sorted(corpus_dir.glob("*.pdf")):
        with pdfplumber.open(path) as pdf:
            pages = len(pdf.pages)
            for index in sorted(rng.sample(range(pages), min(PAGES_PER_DOC, pages))):
                text = (pdf.pages[index].extract_text() or "").strip()
                if text:
                    chunks.append((path.name, index + 1, text[:MAX_CHUNK_CHARS]))
    return chunks


def embed_text_for(file_name: str, page: int, text: str) -> str:
    """The string production embeds: LlamaIndex's EMBED header, then the body.

    ``file_name`` is in the header deliberately (see the module docstring); a
    recording that dropped it would measure a retrieval this product does not
    run.
    """
    return f"file_name: {file_name}\npage_label: {page}\n\n{text}"


def corpus_fingerprint(chunks: list[tuple[str, int, str]]) -> str:
    """Identity of what was embedded, so a stale fixture is detectable."""
    digest = hashlib.sha256()
    for file_name, page, text in chunks:
        digest.update(f"{file_name}\x00{page}\x00{text}\x00".encode())
    return digest.hexdigest()[:16]


def cosine(left: list[float], right: list[float]) -> float:
    dot = sum(x * y for x, y in zip(left, right, strict=True))
    left_norm = sum(x * x for x in left) ** 0.5
    right_norm = sum(x * x for x in right) ** 0.5
    if not left_norm or not right_norm:
        return 0.0
    return dot / (left_norm * right_norm)


def record(golden_path: Path, corpus_dir: Path, *, model: str, base_url: str) -> dict:
    """Embed corpus and questions, return the fixture payload."""
    entries = json.loads(golden_path.read_text())["entries"]
    chunks = read_corpus(corpus_dir)
    if not chunks:
        raise SystemExit(f"No corpus text under {corpus_dir}")
    print(f"corpus: {len(chunks)} page-chunks", file=sys.stderr)

    api_key = resolve_api_key(base_url, model)
    print("embedding corpus …", file=sys.stderr)
    chunk_vectors = embed([embed_text_for(*chunk) for chunk in chunks], model=model, base_url=base_url, api_key=api_key)
    print("embedding questions …", file=sys.stderr)
    question_vectors = embed([entry["question"] for entry in entries], model=model, base_url=base_url, api_key=api_key)

    rankings: dict[str, list[list]] = {}
    for entry, question_vector in zip(entries, question_vectors, strict=True):
        best: dict[str, float] = {}
        for (file_name, _page, _text), chunk_vector in zip(chunks, chunk_vectors, strict=True):
            score = cosine(question_vector, chunk_vector)
            if score > best.get(file_name, -2.0):
                best[file_name] = score
        ordered = sorted(best.items(), key=lambda item: -item[1])
        rankings[entry["id"]] = [[file_name, round(score, 6)] for file_name, score in ordered]

    return {
        "schema_version": 1,
        "description": (
            "Recorded file-level vector-channel ranking per golden question. Produced by "
            "oib_retrieval_eval.record_vector against the real data/oib corpus with the "
            "production embedding model. Re-record when the model, the corpus or the "
            "golden questions change; the harness refuses a fixture whose model does not "
            "match the configured one."
        ),
        "model": model,
        "base_url": base_url,
        "pages_per_doc": PAGES_PER_DOC,
        "sample_seed": SAMPLE_SEED,
        "corpus_fingerprint": corpus_fingerprint(chunks),
        "chunk_count": len(chunks),
        "rankings": rankings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", default=None)
    parser.add_argument("--corpus", default="data/oib")
    parser.add_argument("--out", default=None)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    args = parser.parse_args(argv)

    from oib_retrieval_eval.overview import default_golden_path

    golden = Path(args.golden) if args.golden else default_golden_path()
    out = Path(args.out) if args.out else default_fixture_path()
    payload = record(golden, Path(args.corpus), model=args.model, base_url=args.base_url)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {out} ({len(payload['rankings'])} questions, model {payload['model']})")
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry
    raise SystemExit(main())
