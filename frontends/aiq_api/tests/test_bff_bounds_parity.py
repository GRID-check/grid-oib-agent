"""Parity guard: the BFF's copies of this tier's request bounds.

The BFF keeps what it sends inside these models' bounds instead of having a
whole upload or search refused with a 422: the collections one search may
name (``BACKEND_SEARCH_MAX_COLLECTIONS``), the project facts it copies onto
every chunk (``PROJECT_FACTS_LIMITS``), and the batch it sends the
document facts repair (``DOCUMENT_FACTS_BATCH``). There is no shared schema,
so a bound changed here and not there is caught by this test, not by an
office whose uploads start failing.
"""

import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from aiq_api.models.requests import GroupedDocumentSearchRequest
from aiq_api.models.requests import ProjectFacts
from aiq_api.models.similar import SimilarPassagesRequest
from aiq_api.routes.maintenance import REFRESH_FACTS_MAX_COLLECTIONS

UI_LIB = Path(__file__).resolve().parents[2] / "ui" / "src" / "lib"


def _ts_number(path: Path, name: str) -> int:
    match = re.search(rf"export const {name} = (\d+)", path.read_text(encoding="utf-8"))
    assert match, f"{name} not found in {path}"
    return int(match.group(1))


def _ts_facts_limits() -> dict[str, int]:
    source = (UI_LIB / "cross-project" / "project-facts-mirror.ts").read_text(encoding="utf-8")
    match = re.search(r"export const PROJECT_FACTS_LIMITS = \{(.*?)\} as const", source, re.DOTALL)
    assert match, "PROJECT_FACTS_LIMITS not found in project-facts-mirror.ts"
    return {key: int(value) for key, value in re.findall(r"(\w+): (\d+)", match.group(1))}


def _refuses_collections(model, count: int) -> bool:
    """Whether ``model`` refuses ``count`` collections, whatever else the body lacks."""
    try:
        model.model_validate({"collections": [f"proj_{n}" for n in range(count)]})
    except ValidationError as error:
        return any(issue["loc"][:1] == ("collections",) for issue in error.errors())
    return False


def _max_collections(model) -> int:
    for count in range(400, 1001):
        if _refuses_collections(model, count):
            return count - 1
    pytest.fail(f"{model.__name__} accepts more than 1000 collections")


def test_one_search_names_no_more_collections_than_both_routes_accept():
    cap = _ts_number(UI_LIB / "documents" / "service.ts", "BACKEND_SEARCH_MAX_COLLECTIONS")
    assert cap == _max_collections(GroupedDocumentSearchRequest) == _max_collections(SimilarPassagesRequest)


def test_the_project_facts_the_bff_sends_fit_the_model():
    limits = _ts_facts_limits()
    longest = "x" * limits["token"]
    ProjectFacts(bundesland=longest, bauweise=[longest])
    with pytest.raises(ValidationError):
        ProjectFacts(bauweise=[longest + "x"])
    for key in ("gebaeudeklasse", "bauweise", "nutzungen", "vorhabensart"):
        value = 4 if key == "gebaeudeklasse" else "t"
        ProjectFacts(**{key: [value] * limits[key]})
        with pytest.raises(ValidationError):
            ProjectFacts(**{key: [value] * (limits[key] + 1)})


def test_the_document_facts_batch_fits_the_repair_route():
    batch = _ts_number(UI_LIB / "platform" / "vector-reconcile.ts", "DOCUMENT_FACTS_BATCH")
    assert 1 <= batch <= REFRESH_FACTS_MAX_COLLECTIONS
