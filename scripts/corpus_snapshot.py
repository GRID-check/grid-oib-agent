"""The ingested OIB corpus as one reusable snapshot, so nothing re-ingests what is already ingested.

Ingesting the corpus costs embedding and summary calls and several minutes, and
what it produces depends on two things only: the PDFs and
``oib_sync.CHUNK_FORMAT_VERSION``. So the result is built once and kept as an
OCI artifact in the organisation's registry (private GHCR, like the images):

    data/oib/*.pdf           the corpus (read_passage and view_knowledge_image open them)
    data/oib_uploads/*.pdf   the corpus as uploaded through the platform admin (where staging keeps it)
    data/oib_registry.json   what was ingested: each PDF's hash, and the chunk format
    data/oib_excluded.json   PDFs an operator excluded (when present)
    summaries.db             document summaries, inventory, chunk-text mirror (AIQ_SUMMARY_DB default)
    chroma/                  the vectors ($AIQ_CHROMA_DIR)

`pull` restores it, `data/oib_uploads` exactly as the snapshot carries it
(`data/oib`, a developer's own corpus, is only added to); `oib_sync.sync()`
afterwards is a no-op when nothing changed,
ingests only a new or changed PDF when one did, and re-ingests everything when
the chunk format moved, because that is what its registry already decides.
`push` publishes the result under the format's tag, so the next run anywhere
starts from it.

`mirror DIR` makes the uploaded corpus exactly the PDFs in DIR, the way the
admin UI would: a new or changed PDF is ingested, one DIR no longer has is
removed from disk, registry and index (`oib_sync.remove_uploaded_document`).
With `--manifest` (`sha256sum` taken where the PDFs came from) it first refuses
a DIR that is not exactly that set, and it always refuses to finish when a PDF
did not ingest, so neither a partial copy nor a failed ingest is published.
`.github/workflows/corpus-snapshot.yml` runs pull, mirror and push with DIR
copied from staging, so what an admin uploads and syncs there becomes the
snapshot every test run restores. Only that workflow publishes.

    python scripts/corpus_snapshot.py pull              # ghcr.io/<owner>/grid-oib-corpus:format-<N>
    python scripts/corpus_snapshot.py mirror /tmp/staging-uploads --manifest /tmp/staging-manifest.txt
    python scripts/corpus_snapshot.py push
    python scripts/corpus_snapshot.py pull --oci-layout /tmp/store   # a local OCI layout, for tests

Needs the `oras` CLI (https://oras.land) and, for GHCR, `oras login ghcr.io`
with a token that can read (pull) or write (push) packages.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPOSITORY = "ghcr.io/grid-check/grid-oib-corpus"
ARCHIVE = "corpus.tar.gz"
MEDIA_TYPE = "application/vnd.grid.oib-corpus.v1.tar+gzip"
ARTIFACT_TYPE = "application/vnd.grid.oib-corpus.v1"

#: Files and directories under the repo root that make up an ingested corpus.
_FILES = ("data/oib_registry.json", "data/oib_excluded.json", "summaries.db")
_UPLOADS = "data/oib_uploads"
_PDF_DIRS = ("data/oib", _UPLOADS)
_CHROMA_MEMBER = "chroma"


def chunk_format_version() -> int:
    """The chunk format the checked-out code writes; the snapshot tag follows it."""
    sys.path.insert(0, str(ROOT / "src"))
    from aiq_agent.oib_sync import CHUNK_FORMAT_VERSION

    return CHUNK_FORMAT_VERSION


def chroma_dir() -> Path:
    """Where the vectors live, resolved the way oib_sync resolves it."""
    path = Path(os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data"))
    return path if path.is_absolute() else ROOT / path


def tags(format_version: int) -> list[str]:
    """The tags a snapshot is pushed under and pulled from, most specific first."""
    return [f"format-{format_version}", "latest"]


def pack(archive: Path) -> None:
    """Write the ingested corpus under ROOT (and the Chroma dir) into ``archive``."""
    with tarfile.open(archive, "w:gz") as tar:
        for name in _FILES:
            if (ROOT / name).exists():
                tar.add(ROOT / name, arcname=name)
        for pdf_dir in _PDF_DIRS:
            for pdf in sorted((ROOT / pdf_dir).glob("*.pdf")):
                tar.add(pdf, arcname=f"{pdf_dir}/{pdf.name}")
        if chroma_dir().is_dir():
            tar.add(chroma_dir(), arcname=_CHROMA_MEMBER)


def unpack(archive: Path) -> None:
    """Restore ``archive``: the Chroma member into the Chroma dir, everything else under ROOT."""
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        unknown = [m.name for m in members if not _expected(m.name)]
        if unknown:
            raise SystemExit(f"corpus snapshot: refusing unexpected members {unknown[:5]}")
        target = chroma_dir()
        if any(m.name.split("/", 1)[0] == _CHROMA_MEMBER for m in members):
            shutil.rmtree(target, ignore_errors=True)
        with tempfile.TemporaryDirectory() as staging:
            # Member by member, and only the members just checked against the
            # layout: `filter="data"` still refuses links, devices and absolute
            # or escaping paths on each one.
            for member in members:
                tar.extract(member, staging, filter="data")
            staged = Path(staging)
            if (staged / _CHROMA_MEMBER).is_dir():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(staged / _CHROMA_MEMBER), target)
            for name in _FILES:
                if (staged / name).exists():
                    (ROOT / name).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(staged / name, ROOT / name)
            for pdf_dir in _PDF_DIRS:
                _restore_pdfs(staged / pdf_dir, ROOT / pdf_dir, exact=pdf_dir == _UPLOADS)


def _restore_pdfs(staged: Path, destination: Path, *, exact: bool) -> None:
    """Copy the snapshot's PDFs into ``destination``; with ``exact``, drop the ones it does not carry.

    The uploads directory is exact: it is staging's upload set, and a PDF left
    over from before the restore would be ingested by the next sync on top of
    the restored index. `data/oib` is not: it is where a developer keeps a
    corpus of their own, and a pull must not delete it.
    """
    destination.mkdir(parents=True, exist_ok=True)
    carried = {pdf.name for pdf in staged.glob("*.pdf")}
    if exact:
        for stale in destination.glob("*.pdf"):
            if stale.name not in carried:
                stale.unlink()
    for name in carried:
        shutil.copy2(staged / name, destination / name)


def _expected(name: str) -> bool:
    """A member a snapshot may carry; anything else is refused before extraction."""
    if name in _FILES or name == "data" or name in _PDF_DIRS:
        return True
    for pdf_dir in _PDF_DIRS:
        if name.startswith(f"{pdf_dir}/"):
            return name.endswith(".pdf") and "/" not in name[len(pdf_dir) + 1 :]
    return name == _CHROMA_MEMBER or name.startswith(f"{_CHROMA_MEMBER}/")


def _oras(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["oras", *args], capture_output=True, text=True, check=False)


def _target(repository: str, tag: str, oci_layout: Path | None) -> list[str]:
    if oci_layout is not None:
        return ["--oci-layout", f"{oci_layout}:{tag}"]
    return [f"{repository}:{tag}"]


def pull(repository: str, oci_layout: Path | None) -> tuple[str | None, list[str]]:
    """Restore the newest snapshot for this chunk format, else ``latest``.

    Returns the tag restored (or None) and, per tag that failed, what the
    registry said. GHCR answers "denied" alike for a package that does not
    exist and for one the token may not read, so the answer is reported rather
    than interpreted: a missing snapshot and a broken login must both be
    visible in the log.
    """
    refusals = []
    for tag in tags(chunk_format_version()):
        with tempfile.TemporaryDirectory() as out:
            done = _oras("pull", *_target(repository, tag, oci_layout), "-o", out)
            archive = Path(out) / ARCHIVE
            if done.returncode == 0 and archive.exists():
                unpack(archive)
                return tag, refusals
            said = (done.stderr or done.stdout).strip().splitlines()
            refusals.append(f"{tag}: {said[-1] if said else 'no archive in the artifact'}")
    return None, refusals


def push(repository: str, oci_layout: Path | None) -> list[str]:
    """Publish the ingested corpus under this format's tag and ``latest``; the tags pushed."""
    if not (ROOT / "data/oib_registry.json").exists():
        raise SystemExit("corpus snapshot: nothing ingested here (no data/oib_registry.json); run the sync first")
    pushed = []
    with tempfile.TemporaryDirectory() as out:
        archive = Path(out) / ARCHIVE
        pack(archive)
        for tag in tags(chunk_format_version()):
            args = ["push", *_target(repository, tag, oci_layout), "--artifact-type", ARTIFACT_TYPE]
            done = subprocess.run(
                ["oras", *args, f"{ARCHIVE}:{MEDIA_TYPE}"], cwd=out, capture_output=True, text=True, check=False
            )
            if done.returncode != 0:
                raise SystemExit(f"corpus snapshot: push of {tag} failed: {done.stderr.strip()}")
            pushed.append(tag)
    return pushed


def mirror(source: Path, manifest: Path | None = None) -> dict[str, list[str]]:
    """Make the uploaded corpus exactly the PDFs in ``source``, then sync; what changed.

    Refuses, before touching anything, an empty ``source`` (a copy that failed
    must not read as "every document was deleted") and, given ``manifest``
    (`sha256sum` output taken where the PDFs live), a ``source`` that is not
    exactly that set: a partial copy would otherwise delete what it missed.
    Refuses, after the sync, a corpus in which any PDF did not ingest, so a
    failed ingest is never published as the snapshot.
    """
    wanted = {pdf.name: pdf for pdf in source.glob("*.pdf")}
    if not wanted:
        raise SystemExit(f"corpus snapshot: {source} holds no PDFs; refusing to mirror an empty corpus")
    if manifest is not None:
        _check_against_manifest(wanted, manifest)
    os.chdir(ROOT)  # oib_sync resolves data/... against the working directory
    sys.path.insert(0, str(ROOT / "src"))
    from aiq_agent import oib_sync

    uploads = oib_sync.OIB_UPLOADS_DIR
    uploads.mkdir(parents=True, exist_ok=True)
    removed = [p.name for p in sorted(uploads.glob("*.pdf")) if p.name not in wanted]
    for name in removed:
        oib_sync.remove_uploaded_document(name)
    added = []
    for name, pdf in sorted(wanted.items()):
        target = uploads / name
        if not target.exists() or target.read_bytes() != pdf.read_bytes():
            shutil.copy2(pdf, target)
            added.append(name)
    oib_sync.sync()
    registry = oib_sync._load_registry()
    failed = [name for name in sorted(wanted) if registry.get(str(uploads / name)) != _sha256(uploads / name)]
    if failed:
        raise SystemExit(f"corpus snapshot: {len(failed)} PDF(s) did not ingest, refusing to publish: {failed[:5]}")
    return {"added_or_changed": added, "removed": removed}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _check_against_manifest(wanted: dict[str, Path], manifest: Path) -> None:
    """Refuse a copy that is not byte for byte the set ``manifest`` lists (`sha256sum` lines)."""
    expected = {}
    for line in manifest.read_text().splitlines():
        digest, _, name = line.strip().partition(" ")
        if digest:
            expected[Path(name.strip().lstrip("*")).name] = digest
    copied = {name: _sha256(pdf) for name, pdf in wanted.items()}
    if copied != expected:
        missing = sorted(set(expected) - set(copied))
        differ = sorted(n for n in set(expected) & set(copied) if expected[n] != copied[n])
        extra = sorted(set(copied) - set(expected))
        raise SystemExit(
            f"corpus snapshot: the copy does not match the manifest (missing {missing[:5]}, "
            f"different {differ[:5]}, unlisted {extra[:5]}); refusing to mirror a partial copy"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=["pull", "push", "mirror"])
    parser.add_argument("source", nargs="?", type=Path, help="mirror: the directory of PDFs to mirror")
    parser.add_argument("--manifest", type=Path, default=None, help="mirror: `sha256sum` of the PDFs at their origin")
    parser.add_argument("--repository", default=os.environ.get("GRID_CORPUS_REPOSITORY", DEFAULT_REPOSITORY))
    parser.add_argument("--oci-layout", type=Path, default=None, help="a local OCI layout dir, not a registry")
    args = parser.parse_args(argv)
    if args.command == "mirror":
        if args.source is None:
            parser.error("mirror needs the directory of PDFs to mirror")
        changes = mirror(args.source, args.manifest)
        print(f"corpus snapshot: mirrored {args.source}: {changes}")
        return 0
    if shutil.which("oras") is None:
        print("corpus snapshot: the oras CLI is not installed (https://oras.land/docs/installation)", file=sys.stderr)
        return 2
    if args.command == "pull":
        tag, refusals = pull(args.repository, args.oci_layout)
        if tag is None:
            print("corpus snapshot: none restored; the sync will ingest from data/oib if it has PDFs")
            for refusal in refusals:
                print(f"  {args.repository}:{refusal}")
            return 0
        print(f"corpus snapshot: restored {tag}")
        return 0
    print(f"corpus snapshot: pushed {', '.join(push(args.repository, args.oci_layout))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
