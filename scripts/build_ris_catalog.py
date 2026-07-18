"""Verify the norm registry's RIS pointers live against OGD-RIS and merge them back.

The registry is a FLAT catalog (``configs/norms/<country>/registry.yml``): one entry
per legal norm. Entries that carry a ``verify`` seed are re-checked against the live
OGD-RIS search API; only the machine-derived pointer fields
(``application``/``document_number``/``citation_url``/``full_law_url``/``verified_at``)
are written back. Every curated field (title/short/rank/bundesland/topics/relevance/
aliases/binding_note/review_note/verify) is left untouched. Entries WITHOUT a verify
seed are skipped with a logged note.

Merge semantics:

- The file's header comment block is preserved verbatim.
- Key order within each entry is preserved (``yaml.safe_dump(sort_keys=False)``);
  the five pointer keys already exist on verified entries, so their positions do
  not move.
- ``verify_entry(client, entry)`` verifies exactly ONE entry and returns the merged
  pointer dict — factored out so a future admin verify API can reuse it.

Fails loudly: any entry whose verify seed has no unambiguous live hit aborts the
build (non-zero exit) and the registry file is left untouched.

Run (no project env needed):

    uv run --no-project --with httpx --with pydantic --with beautifulsoup4 \
        --with pyyaml python scripts/build_ris_catalog.py
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "sources" / "ris_adapter" / "src"))
sys.path.insert(0, str(REPO_ROOT / "src"))

import importlib.util  # noqa: E402

import yaml  # noqa: E402
from ris_adapter.client import RisClient  # noqa: E402


def _standalone_module(module_name: str, module_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_norm_registry_module():
    """Import norm_registry.py standalone (the package __init__ pulls langgraph/nat).

    The flat module only needs pydantic + yaml at import time (``resolve_bundesland``
    imports project_context lazily), so stubbing the aiq_agent package chain is enough.
    """
    import types

    common_dir = REPO_ROOT / "src" / "aiq_agent" / "common"
    for package in ("aiq_agent", "aiq_agent.common"):
        if package not in sys.modules:
            stub = types.ModuleType(package)
            stub.__path__ = []  # package marker: no real __init__ is executed
            sys.modules[package] = stub
    return _standalone_module("aiq_agent.common.norm_registry", common_dir / "norm_registry.py")


_nr = _load_norm_registry_module()

NORMS_ROOT = REPO_ROOT / "configs" / "norms"

# Canonical Bundesland name -> OGD-RIS Landesrecht search parameter.
_BUNDESLAND_PARAMS: dict[str, str] = {
    "Wien": "SucheInWien",
    "Niederösterreich": "SucheInNiederoesterreich",
    "Oberösterreich": "SucheInOberoesterreich",
    "Steiermark": "SucheInSteiermark",
    "Kärnten": "SucheInKaernten",
    "Salzburg": "SucheInSalzburg",
    "Tirol": "SucheInTirol",
    "Vorarlberg": "SucheInVorarlberg",
    "Burgenland": "SucheInBurgenland",
}


def _pick_hit(entry_id: str, verify, hits):
    """Select the currently-in-force whole-law anchor (the '§ 0' document).

    Applies the verify seed's expect/exclude/gesetzesnummer guards and fails loud
    (SystemExit) when the number of surviving candidates is not exactly one.
    """
    candidates = []
    for hit in hits:
        kurztitel = hit.metadata.get("Kurztitel") or hit.title or ""
        if verify.expect.lower() not in kurztitel.lower():
            continue
        if any(term.lower() in kurztitel.lower() for term in verify.exclude):
            continue
        if hit.metadata.get("Paragraph/Artikel") != "§ 0":
            continue
        if not hit.full_law_url:
            continue
        if verify.gesetzesnummer and f"Gesetzesnummer={verify.gesetzesnummer}" not in hit.full_law_url:
            continue
        candidates.append(hit)
    in_force = [h for h in candidates if not h.metadata.get("Außer Kraft seit")]
    selected = in_force or candidates
    if len(selected) != 1:
        raise SystemExit(
            f"ERROR: entry '{entry_id}' has {len(selected)} candidate hits "
            f"(expected exactly 1): {[h.document_number for h in selected]}"
        )
    return selected[0]


async def verify_entry(client: RisClient, entry) -> dict:
    """Live-verify ONE registry entry and return its merged pointer fields.

    ``entry`` is a NormEntry (or any object exposing ``id``/``application``/
    ``bundesland``/``verify``). Reused by the build loop below and by the future
    admin verify API. Raises SystemExit on an ambiguous/missing hit.
    """
    verify = entry.verify
    if verify is None:
        raise ValueError(f"entry '{entry.id}' has no verify seed")
    params: dict[str, str] = {"Titel": verify.title_query}
    if entry.bundesland:
        params[f"Bundesland.{_BUNDESLAND_PARAMS[entry.bundesland]}"] = "true"
    hits = []
    page = 1
    while True:
        result = await client.search(entry.application, params=params, page=page, page_size=50)
        hits.extend(result.hits)
        if len(hits) >= result.total or not result.hits:
            break
        page += 1
    hit = _pick_hit(entry.id, verify, hits)
    kurztitel = hit.metadata.get("Kurztitel") or hit.title
    print(f"OK  {entry.id:22s} -> {hit.document_number}  {kurztitel}")
    return {
        "application": entry.application,
        "document_number": hit.document_number,
        "citation_url": hit.citation_url,
        "full_law_url": hit.full_law_url,
        "verified_at": date.today().isoformat(),
    }


def _split_header(text: str) -> tuple[str, str]:
    """Split the leading comment block from the YAML body (both re-joinable)."""
    lines = text.splitlines(keepends=True)
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            return "".join(lines[:idx]), "".join(lines[idx:])
    return text, ""


async def _process_registry(client: RisClient, registry_path: Path, *, dry_run: bool) -> int:
    """Verify every seeded entry in one registry file; merge and write unless dry-run.

    Returns the number of entries verified.
    """
    text = registry_path.read_text(encoding="utf-8")
    header, body = _split_header(text)
    data = yaml.safe_load(body) or {}
    raw_entries = data.get("entries") or []
    raw_by_id = {raw.get("id"): raw for raw in raw_entries}

    norms_file = _nr.NormsFile.model_validate(data)
    verified_count = 0
    for entry in norms_file.entries:
        if entry.verify is None:
            print(f"--  {entry.id:22s} skipped (no verify seed)")
            continue
        merged = await verify_entry(client, entry)
        raw_by_id[entry.id].update(merged)  # existing keys keep their position
        verified_count += 1

    if dry_run:
        print(f"(dry-run) {registry_path} — {verified_count} entr(ies) verified, not written")
        return verified_count

    dumped = yaml.safe_dump(data, sort_keys=False, allow_unicode=True)
    registry_path.write_text(header + dumped, encoding="utf-8")
    print(f"Wrote {registry_path} — {verified_count} verified pointer(s) merged")
    return verified_count


async def _main(norms_root: Path, *, dry_run: bool) -> None:
    registry_files = sorted(norms_root.glob("*/registry.yml"))
    if not registry_files:
        raise SystemExit(f"ERROR: no registry files under {norms_root}/*/registry.yml")
    client = RisClient()
    try:
        total = 0
        for registry_path in registry_files:
            total += await _process_registry(client, registry_path, dry_run=dry_run)
    finally:
        await client.aclose()

    # Sanity reload (fail-open loader): confirms the merged files still parse.
    if not dry_run:
        _nr.reset_registry_cache()
        registry = _nr.load_registry(str(norms_root))
        loaded = len(registry.entries) if registry else 0
        print(f"\nVerified {total} pointer(s); reloaded registry has {loaded} entr(ies)")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--norms-dir",
        type=Path,
        default=NORMS_ROOT,
        help="Root of the norms directory (default: configs/norms).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Verify against the live API but do not write the registry files.",
    )
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = _parse_args()
    asyncio.run(_main(args.norms_dir, dry_run=args.dry_run))
