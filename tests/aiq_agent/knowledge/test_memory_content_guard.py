"""One personal-data guard on the path both memory writers share."""

from __future__ import annotations

import pytest

from aiq_agent.knowledge import project_memory
from aiq_agent.knowledge.project_memory import insert_memory_item
from aiq_agent.knowledge.project_memory import looks_like_personal_data


@pytest.mark.parametrize(
    "content",
    [
        "Bauverhandlung am 12.03.2027, Frist für Einwendungen 26/03/2027.",
        "Einreichung bis 2027-03-12 laut Bescheid.",
        "Atrium wird als OIB 2.3 behandelt (Entscheidung vom 12.08.2026).",
        "Fluchtweg im 4. OG: 34,5 m, Grenzwert 40 m.",
    ],
)
def test_a_date_or_a_measurement_is_a_fact_not_a_phone_number(content):
    assert looks_like_personal_data(content) is False


@pytest.mark.parametrize(
    "content",
    [
        "Rückfragen an bauamt.wien@example.at",
        "Bauherr erreichbar unter +43 664 1234567",
        "IBAN AT611904300234573201 für die Kaution",
        "API key: sk-live-abc",
    ],
)
def test_contact_details_and_secrets_are_not_recorded(content):
    assert looks_like_personal_data(content) is True


def test_insert_refuses_personal_data_before_any_request(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "a-real-secret-token")

    def _no_request(*args, **kwargs):  # pragma: no cover - the assertion is that this is never reached
        raise AssertionError("a personal-data finding must never reach the BFF")

    monkeypatch.setattr(project_memory._opener, "open", _no_request)
    assert (
        insert_memory_item(
            scope="project",
            project_id="proj-1",
            organization_id="org-1",
            kind="derived_fact",
            content="Bauherr erreichbar unter +43 664 1234567",
        )
        is None
    )
