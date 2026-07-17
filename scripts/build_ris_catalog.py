"""Verify RIS seeds live against OGD-RIS and merge the pointers into the norm registry.

Successor of the old flat-catalog builder (which wrote configs/ris_catalog.yml).
Seeds now live in ``configs/norms/<country>/seeds_ris.yml`` and the verified
pointers (application, document number, citation URL, entire-consolidated-law
URL, verified_at) are merged into ``configs/norms/<country>/registry.yml``.

Merge semantics (ADR-0025):

- Only the four RIS pointer fields plus ``verified_at`` are written. Curated
  registry fields (rank, role, relations, aliases, applicability, access,
  corpus editions) are NEVER clobbered.
- A seed whose id is already in the registry updates the matching
  ``kind: ris`` edition in place (or appends one when none exists).
- A seed with an unknown id creates a SKELETON entry with an inferred rank
  (LrKons+state -> landesgesetz, BrKons -> bundesgesetz) and a prominent
  warning — a human must curate rank/role/relations afterwards.
- Registry files are loaded and dumped with ruamel round-trip mode so the
  hand-written comments survive a merge.

Fails loudly: any seed without an unambiguous live hit aborts the build with a
non-zero exit code and the registry files are left untouched. After writing,
the merged registry is re-loaded in strict mode (OIB id-convention check).

Run (no project env needed):

    uv run --no-project --with httpx --with pydantic --with beautifulsoup4 \
        --with pyyaml --with ruamel.yaml python scripts/build_ris_catalog.py
"""

from __future__ import annotations

import asyncio
import re
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "sources" / "ris_adapter" / "src"))
sys.path.insert(0, str(REPO_ROOT / "src"))

import importlib.util  # noqa: E402

import yaml  # noqa: E402
from ris_adapter.client import RisClient  # noqa: E402
from ruamel.yaml import YAML  # noqa: E402


def _standalone_module(module_name: str, module_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_norm_registry_module():
    """Import norm_registry.py standalone (the package __init__ pulls langgraph/nat).

    Stubs the aiq_agent package chain and path-loads the country_packs modules
    norm_registry depends on, in dependency order.
    """
    import types

    common_dir = REPO_ROOT / "src" / "aiq_agent" / "common"
    for package in ("aiq_agent", "aiq_agent.common", "aiq_agent.common.country_packs"):
        if package not in sys.modules:
            stub = types.ModuleType(package)
            stub.__path__ = []  # package marker: no real __init__ is executed
            sys.modules[package] = stub
    packs_dir = common_dir / "country_packs"
    _standalone_module("aiq_agent.common.country_packs.base", packs_dir / "base.py")
    _standalone_module("aiq_agent.common.country_packs.at", packs_dir / "at.py")
    _standalone_module("aiq_agent.common.country_packs", packs_dir / "__init__.py")
    return _standalone_module("aiq_agent.common.norm_registry", common_dir / "norm_registry.py")


_norm_registry = _load_norm_registry_module()

NORMS_ROOT = REPO_ROOT / "configs" / "norms"

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

_GESETZESNUMMER_RE = re.compile(r"Gesetzesnummer=(\d+)")

# Seeds only verify RIS-sourced norms; everything else is curated by hand.
_KONSOLIDIERT_LABEL = "Konsolidierte Fassung (laufend)"


def _load_seeds(norms_root: Path) -> list[dict]:
    """All per-country seeds, each tagged with its registry file and country."""
    seeds: list[dict] = []
    for seeds_path in sorted(norms_root.glob("*/seeds_ris.yml")):
        data = yaml.safe_load(seeds_path.read_text(encoding="utf-8")) or {}
        country = data.get("country")
        if not country:
            raise SystemExit(f"ERROR: {seeds_path} has no top-level 'country' key")
        registry_path = seeds_path.parent / "registry.yml"
        for seed in data.get("seeds") or []:
            for key in ("id", "short", "application", "title_query", "expect"):
                if not seed.get(key):
                    raise SystemExit(f"ERROR: seed in {seeds_path} missing required key '{key}': {seed!r}")
            seed["_country"] = country
            seed["_registry_path"] = registry_path
            seeds.append(seed)
    if not seeds:
        raise SystemExit(f"ERROR: no seeds found under {norms_root}/*/seeds_ris.yml")
    return seeds


def _pick_hit(seed: dict, hits) -> object:
    """Select the currently-in-force whole-law anchor (the '§ 0' document)."""
    candidates = []
    for hit in hits:
        kurztitel = hit.metadata.get("Kurztitel") or hit.title or ""
        if seed["expect"].lower() not in kurztitel.lower():
            continue
        if any(term.lower() in kurztitel.lower() for term in seed.get("exclude", [])):
            continue
        if hit.metadata.get("Paragraph/Artikel") != "§ 0":
            continue
        if not hit.full_law_url:
            continue
        if seed.get("gesetzesnummer") and f"Gesetzesnummer={seed['gesetzesnummer']}" not in hit.full_law_url:
            continue
        candidates.append(hit)
    in_force = [h for h in candidates if not h.metadata.get("Außer Kraft seit")]
    selected = in_force or candidates
    if len(selected) != 1:
        raise SystemExit(
            f"ERROR: seed '{seed['id']}' has {len(selected)} candidate hits "
            f"(expected exactly 1): {[h.document_number for h in selected]}"
        )
    return selected[0]


async def _verify_seed(client: RisClient, seed: dict) -> dict:
    params: dict[str, str] = {"Titel": seed["title_query"]}
    if seed.get("bundesland"):
        params[f"Bundesland.{_BUNDESLAND_PARAMS[seed['bundesland']]}"] = "true"
    hits = []
    page = 1
    while True:
        result = await client.search(seed["application"], params=params, page=page, page_size=50)
        hits.extend(result.hits)
        if len(hits) >= result.total or not result.hits:
            break
        page += 1
    hit = _pick_hit(seed, hits)
    gesetzesnummer = ""
    match = _GESETZESNUMMER_RE.search(hit.full_law_url)
    if match:
        gesetzesnummer = match.group(1)
    kurztitel = hit.metadata.get("Kurztitel") or hit.title
    print(f"OK  {seed['id']:22s} -> {hit.document_number}  {kurztitel}  (GNr {gesetzesnummer or '?'})")
    return {
        "id": seed["id"],
        "title": kurztitel,
        "application": seed["application"],
        "document_number": hit.document_number,
        "citation_url": hit.citation_url,
        "full_law_url": hit.full_law_url,
        "verified_at": date.today().isoformat(),
    }


def _infer_rank(seed: dict) -> str:
    if seed["application"] == "LrKons":
        return "landesgesetz"
    if seed["application"] == "BrKons":
        return "bundesgesetz"
    print(
        f"WARNING: seed '{seed['id']}': application {seed['application']!r} has no rank inference - using 'verordnung'"
    )
    return "verordnung"


def _skeleton_entry(seed: dict, verified: dict) -> dict:
    state_token = _norm_registry.state_name_to_token(seed.get("bundesland") or None)
    return {
        "id": seed["id"],
        "title": verified["title"],
        "short": seed["short"],
        "rank": _infer_rank(seed),
        "role": "normativ",
        "jurisdiction": {"country": seed["_country"], "state": state_token},
        "topics": list(seed.get("topics") or []),
        "relevance": seed.get("relevance") or "",
        "editions": [
            {
                "id": "konsolidiert",
                "label": _KONSOLIDIERT_LABEL,
                "status": "current",
                "source": {
                    "kind": "ris",
                    "application": verified["application"],
                    "document_number": verified["document_number"],
                    "citation_url": verified["citation_url"],
                    "full_law_url": verified["full_law_url"],
                },
            }
        ],
        "verified_at": verified["verified_at"],
    }


def _merge_entry(entry: dict, verified: dict) -> None:
    """Update the matching kind:ris edition in place; never touch curated fields."""
    for edition in entry.get("editions") or []:
        source = edition.get("source") or {}
        if source.get("kind") == "ris" and source.get("application") == verified["application"]:
            source["document_number"] = verified["document_number"]
            source["citation_url"] = verified["citation_url"]
            source["full_law_url"] = verified["full_law_url"]
            break
    else:
        entry.setdefault("editions", []).append(
            {
                "id": "konsolidiert",
                "label": _KONSOLIDIERT_LABEL,
                "status": "current",
                "source": {
                    "kind": "ris",
                    "application": verified["application"],
                    "document_number": verified["document_number"],
                    "citation_url": verified["citation_url"],
                    "full_law_url": verified["full_law_url"],
                },
            }
        )
    entry["verified_at"] = verified["verified_at"]


def _merge_into_registry(registry_path: Path, verified_by_id: dict[str, dict], seeds_by_id: dict[str, dict]) -> int:
    ryaml = YAML()
    if registry_path.is_file():
        data = ryaml.load(registry_path.read_text(encoding="utf-8"))
    else:
        print(f"WARNING: {registry_path} does not exist — creating it (curate the header comment!)")
        data = {"version": 1, "country": next(iter(seeds_by_id.values()))["_country"], "entries": []}
    entries = data.setdefault("entries", [])
    by_id = {entry.get("id"): entry for entry in entries}
    skeletons = 0
    for entry_id, verified in verified_by_id.items():
        entry = by_id.get(entry_id)
        if entry is None:
            seed = seeds_by_id[entry_id]
            entries.append(_skeleton_entry(seed, verified))
            skeletons += 1
            print(
                f"WARNING: seed '{entry_id}' was not in {registry_path.name} — created a SKELETON entry "
                "(inferred rank, no relations). Curate rank/role/relations/applicability by hand."
            )
        else:
            _merge_entry(entry, verified)
    text_path = registry_path
    with text_path.open("w", encoding="utf-8") as handle:
        ryaml.dump(data, handle)
    return skeletons


async def _main() -> None:
    seeds = _load_seeds(NORMS_ROOT)
    client = RisClient()
    try:
        verified = [await _verify_seed(client, seed) for seed in seeds]
    finally:
        await client.aclose()
    # Group per registry file (a file only gets rewritten when one of its seeds ran).
    per_file: dict[Path, dict[str, dict]] = {}
    seeds_by_file: dict[Path, dict[str, dict]] = {}
    for seed, ver in zip(seeds, verified, strict=True):
        path = seed["_registry_path"]
        per_file.setdefault(path, {})[seed["id"]] = ver
        seeds_by_file.setdefault(path, {})[seed["id"]] = seed
    total_skeletons = 0
    for path, verified_by_id in per_file.items():
        total_skeletons += _merge_into_registry(path, verified_by_id, seeds_by_file[path])
    # Strict reload catches id-convention violations and schema drift in the merged files.
    _norm_registry.load_registry(str(NORMS_ROOT), strict=True)
    print(
        f"\nMerged {len(verified)} verified RIS pointer(s) into {len(per_file)} registry file(s)"
        + (f" — {total_skeletons} SKELETON entr(ies) need curation!" if total_skeletons else "")
    )


if __name__ == "__main__":
    asyncio.run(_main())
