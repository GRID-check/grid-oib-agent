"""Build configs/ris_catalog.yml from verified live OGD-RIS API data.

Curates the building-relevant Austrian norms (Bauordnungen of all nine states,
Bautechnik/Garagen state law, and adjacent federal acts) by searching the live
OGD-RIS API v2.6 for each seed and recording the verified pointers (application,
document number, citation URL, entire-consolidated-law URL, Bundesland).

Fails loudly: any seed without an unambiguous live hit aborts the build with a
non-zero exit code and the catalog file is left untouched.

Run (no project env needed):

    uv run --no-project --with httpx --with pydantic --with beautifulsoup4 \
        --with pyyaml python scripts/build_ris_catalog.py
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


def _load_ris_catalog_module():
    """Import ris_catalog.py standalone (the package __init__ pulls langgraph/nat)."""
    module_path = REPO_ROOT / "src" / "aiq_agent" / "common" / "ris_catalog.py"
    spec = importlib.util.spec_from_file_location("ris_catalog", module_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["ris_catalog"] = module
    spec.loader.exec_module(module)
    return module


RisCatalog = _load_ris_catalog_module().RisCatalog

CATALOG_PATH = REPO_ROOT / "configs" / "ris_catalog.yml"

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

# Each seed: the German Titel query, a substring the Kurztitel of the selected
# hit must contain (guard against picking up a similarly-named law), plus the
# curated topics/relevance the API cannot provide.
SEEDS: list[dict] = [
    # --- State building codes (LrKons) -------------------------------------
    {
        "id": "bo-wien",
        "short": "BO für Wien",
        "application": "LrKons",
        "bundesland": "Wien",
        "title_query": "Bauordnung für Wien",
        "expect": "Bauordnung",
        "topics": ["bauordnung", "bauantrag", "baubewilligung", "bauklasse", "widmung"],
        "relevance": "Viennese building code (Stadtentwicklungs-, Stadtplanungs- und Baugesetzbuch)",
    },
    {
        "id": "garagengesetz-wien",
        "short": "Garagengesetz Wien",
        "application": "LrKons",
        "bundesland": "Wien",
        "title_query": "Garagengesetz",
        "expect": "Garagen",
        "topics": ["garagengesetz", "garage", "stellplatz", "stellplatzverpflichtung", "kraftfahrzeugabstellplatz"],
        "relevance": "Vienna: garage construction and parking-space obligations",
    },
    {
        "id": "bo-noe",
        "short": "NÖ BO 2014",
        "application": "LrKons",
        "bundesland": "Niederösterreich",
        "title_query": "NÖ Bauordnung 2014",
        "expect": "Bauordnung",
        "exclude": ["Interpretation"],
        "topics": ["bauordnung", "bauantrag", "baubewilligung", "bebauungsplan"],
        "relevance": "Lower Austrian building code",
    },
    {
        "id": "bo-ooe",
        "short": "Oö. BauO 1994",
        "application": "LrKons",
        "bundesland": "Oberösterreich",
        "title_query": "Oö. Bauordnung 1994",
        "expect": "Bauordnung",
        "topics": ["bauordnung", "bauantrag", "baubewilligung", "bautechnik"],
        "relevance": "Upper Austrian building code",
    },
    {
        "id": "bo-stmk",
        "short": "Stmk. BauG",
        "application": "LrKons",
        "bundesland": "Steiermark",
        "title_query": "Baugesetz Steiermark",
        "expect": "Bau",
        "topics": ["baugesetz", "bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Styrian building act",
    },
    {
        "id": "bo-ktn",
        "short": "Ktn. BO",
        "application": "LrKons",
        "bundesland": "Kärnten",
        "title_query": "Kärntner Bauordnung",
        "expect": "Bauordnung",
        "topics": ["bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Carinthian building code",
    },
    {
        "id": "bo-sbg",
        "short": "Sbg. BTG",
        "application": "LrKons",
        "bundesland": "Salzburg",
        "title_query": "Bautechnikgesetz",
        "expect": "Bautechnikgesetz",
        "topics": ["bautechnikgesetz", "bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Salzburg building technics act (the Salzburg building code)",
    },
    {
        "id": "bo-tirol",
        "short": "Tiroler BO",
        "application": "LrKons",
        "bundesland": "Tirol",
        "title_query": "Tiroler Bauordnung",
        "expect": "Bauordnung",
        "topics": ["bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Tyrolean building code",
    },
    {
        "id": "bo-vbg",
        "short": "Vbg. BauG",
        "application": "LrKons",
        "bundesland": "Vorarlberg",
        "title_query": "Baugesetz",
        "expect": "Baugesetz",
        "gesetzesnummer": "20000734",
        "topics": ["baugesetz", "bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Vorarlberg building act",
    },
    {
        "id": "bo-bgld",
        "short": "Bgld. BO",
        "application": "LrKons",
        "bundesland": "Burgenland",
        "title_query": "Burgenländisches Baugesetz",
        "expect": "Baugesetz",
        "topics": ["bauordnung", "bauantrag", "baubewilligung"],
        "relevance": "Burgenland building code",
    },
    # --- Adjacent federal law (BrKons) --------------------------------------
    {
        "id": "aschg",
        "short": "ASchG",
        "application": "BrKons",
        "bundesland": "",
        "title_query": "ArbeitnehmerInnenschutzgesetz",
        "expect": "Arbeitnehmer",
        "topics": ["arbeitnehmerinnenschutz", "arbeitsstätten", "baustelle", "arbeitssicherheit"],
        "relevance": "Federal employee-protection act (workplace and construction-site safety)",
    },
    {
        "id": "astv",
        "short": "AStV",
        "application": "BrKons",
        "bundesland": "",
        "title_query": "Arbeitsstättenverordnung",
        "expect": "Arbeitsstätten",
        "gesetzesnummer": "10009098",
        "topics": ["arbeitsstättenverordnung", "arbeitsstätten", "fluchtweg", "notausgang"],
        "relevance": "Workplace ordinance (dimensions, escape routes, sanitary facilities)",
    },
    {
        "id": "bkag",
        "short": "BKAG",
        "application": "BrKons",
        "bundesland": "",
        "title_query": "Bauarbeitenkoordinationsgesetz",
        "expect": "Bauarbeitenkoordination",
        "topics": ["bauarbeitenkoordination", "baustellenkoordination", "sicherheitskoordinator", "sigeko"],
        "relevance": "Construction-site coordination act (SiGeKo duties)",
    },
    {
        "id": "ztg",
        "short": "ZTG 2019",
        "application": "BrKons",
        "bundesland": "",
        "title_query": "Ziviltechnikergesetz",
        "expect": "Ziviltechniker",
        "topics": ["ziviltechnikergesetz", "ziviltechniker", "baumeister", "architekt"],
        "relevance": "Civil engineers act (professional duties of Baumeister/architects)",
    },
    {
        "id": "wgg",
        "short": "WGG",
        "application": "BrKons",
        "bundesland": "",
        "title_query": "Wohnungsgemeinnützigkeitsgesetz",
        "expect": "Wohnungsgemeinnützigkeits",
        "topics": ["wohnungsgemeinnützigkeit", "gemeinnütziger wohnbau", "wohnbauförderung"],
        "relevance": "Non-profit housing act (subsidised housing developers)",
    },
]


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
    if seed["bundesland"]:
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
        "short": seed["short"],
        "application": seed["application"],
        "document_number": hit.document_number,
        "citation_url": hit.citation_url,
        "full_law_url": hit.full_law_url,
        "bundesland": seed["bundesland"],
        "topics": seed["topics"],
        "relevance": seed["relevance"],
        "verified_at": date.today().isoformat(),
    }


async def _main() -> None:
    client = RisClient()
    try:
        entries = [await _verify_seed(client, seed) for seed in SEEDS]
    finally:
        await client.aclose()
    catalog = RisCatalog.model_validate({"version": 1, "entries": entries})
    header = (
        "# Curated RIS catalog — verified pointers to the building-relevant Austrian norms.\n"
        "# REGENERATE, do not hand-edit: scripts/build_ris_catalog.py (verifies every entry\n"
        "# against the live OGD-RIS API and fails loudly on unverifiable seeds).\n"
    )
    body = yaml.safe_dump(catalog.model_dump(), allow_unicode=True, sort_keys=False, width=120)
    CATALOG_PATH.write_text(header + body, encoding="utf-8")
    print(f"\nWrote {len(entries)} verified entries to {CATALOG_PATH}")


if __name__ == "__main__":
    asyncio.run(_main())
