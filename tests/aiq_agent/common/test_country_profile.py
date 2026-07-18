"""Tests for the CountryProfile contract (aiq_agent.common.country_profile).

Covers the Austria (#1) profile's fields, the registry-file override precedence
(``with_overrides`` — data wins over code, empty overrides ignored), unknown-country
handling, the ``doctrine_for`` fail-open, and ``load_norms_file`` store-vs-YAML
precedence.
"""

from __future__ import annotations

import pytest

from aiq_agent.common import country_profile as cp
from aiq_agent.common import norm_registry as nr


@pytest.fixture(autouse=True)
def _clean_state():
    """Ensure no admin-store loader leaks between tests (and the cache is fresh)."""
    nr.reset_registry_cache()
    yield
    nr.set_db_loader(None)  # also clears the registry cache
    nr.reset_registry_cache()


def _norms_file(**overrides) -> nr.NormsFile:
    """A NormsFile with one valid entry (store loader requires non-empty entries)."""
    entry = nr.NormEntry.model_validate(
        {
            "id": "bo-wien",
            "title": "Bauordnung für Wien",
            "short": "BO Wien",
            "rank": "landesgesetz",
            "bundesland": "Wien",
            "application": "LrKons",
            "document_number": "LWI40000225",
        }
    )
    return nr.NormsFile(entries=[entry], **overrides)


# ---------------------------------------------------------------------------
# Austria profile (#1)
# ---------------------------------------------------------------------------


class TestAustriaProfile:
    def test_at_profile_fields(self):
        profile = cp.get_country_profile("at")

        assert profile is not None
        assert profile.country == "at"
        assert profile.language == "de-AT"
        # No override in the seed → code defaults hold.
        assert profile.corpus_collection == "oib_knowledge"
        assert profile.doctrine == nr.NORM_DOCTRINE
        assert profile.corpus_note == nr.OIB_CORPUS_NOTE
        assert profile.states == nr.BUNDESLAND_TOKENS
        assert profile.state_probe_order == tuple(nr.BUNDESLAENDER)
        assert "Bebauungsplan" in profile.parcel_tags
        assert "Flächenwidmungsplan" in profile.parcel_tags
        # Code hooks are always the registered callables.
        assert callable(profile.applicability)
        assert callable(profile.corpus_doc_class)

    def test_default_country_is_austria(self):
        assert cp.DEFAULT_COUNTRY == "at"
        assert cp.get_country_profile(None) is not None
        assert cp.get_country_profile(None).country == "at"

    def test_country_code_is_case_insensitive(self):
        assert cp.get_country_profile("AT") is not None


# ---------------------------------------------------------------------------
# with_overrides precedence (registry data wins over code; empty ignored)
# ---------------------------------------------------------------------------


class TestWithOverrides:
    def test_nonempty_override_wins(self):
        base = cp.get_country_profile("at")
        overridden = base.with_overrides(doctrine="REGISTRY DOCTRINE")
        assert overridden.doctrine == "REGISTRY DOCTRINE"
        # Untouched fields keep their code values; the base is unmutated.
        assert overridden.corpus_note == base.corpus_note
        assert base.doctrine == nr.NORM_DOCTRINE

    def test_empty_override_ignored(self):
        base = cp.get_country_profile("at")
        same = base.with_overrides(doctrine="", corpus_note="", parcel_tags=None, states=None)
        assert same.doctrine == nr.NORM_DOCTRINE
        assert same.corpus_note == nr.OIB_CORPUS_NOTE
        assert same.parcel_tags == base.parcel_tags
        assert same.states == base.states

    def test_no_overrides_returns_same_instance(self):
        base = cp.get_country_profile("at")
        assert base.with_overrides() is base

    def test_registry_override_applied_through_get_country_profile(self):
        # A stored NormsFile carrying a doctrine override wins over the code constant.
        nr.set_db_loader(lambda: _norms_file(doctrine="STORED DOCTRINE", language="de-XX"))
        profile = cp.get_country_profile("at")
        assert profile.doctrine == "STORED DOCTRINE"
        assert profile.language == "de-XX"

    def test_empty_registry_fields_keep_code_defaults(self):
        # Stored NormsFile with empty override fields → code defaults survive.
        nr.set_db_loader(lambda: _norms_file())
        profile = cp.get_country_profile("at")
        assert profile.doctrine == nr.NORM_DOCTRINE
        assert profile.corpus_note == nr.OIB_CORPUS_NOTE


# ---------------------------------------------------------------------------
# Unknown country
# ---------------------------------------------------------------------------


class TestUnknownCountry:
    def test_unknown_country_returns_none(self):
        assert cp.get_country_profile("zz") is None

    def test_register_and_lookup(self):
        # The registry is a plain dict; a second country registers the same way.
        assert cp.get_country_profile("qq") is None


# ---------------------------------------------------------------------------
# doctrine_for fail-open
# ---------------------------------------------------------------------------


class TestDoctrineFor:
    def test_unknown_country_falls_back_to_norm_doctrine(self):
        assert nr.doctrine_for("country=zz Bauvorhaben") == nr.NORM_DOCTRINE

    def test_default_country_uses_profile_doctrine(self):
        nr.set_db_loader(lambda: _norms_file(doctrine="PROFILE DOCTRINE"))
        assert nr.doctrine_for(None) == "PROFILE DOCTRINE"

    def test_none_context_defaults_to_austria(self):
        assert nr.doctrine_for(None) == nr.NORM_DOCTRINE


# ---------------------------------------------------------------------------
# load_norms_file: store precedence, YAML fallback
# ---------------------------------------------------------------------------


class TestLoadNormsFile:
    def test_store_precedence_for_default_country(self):
        stored = _norms_file(doctrine="from store")
        nr.set_db_loader(lambda: stored)
        assert nr.load_norms_file("at") is stored

    def test_empty_store_falls_back_to_yaml(self):
        # An empty store (no entries) must not shadow the YAML seed.
        nr.set_db_loader(lambda: nr.NormsFile(entries=[]))
        loaded = nr.load_norms_file("at")
        assert loaded is not None
        assert loaded.corpus_collection == "oib_knowledge"

    def test_yaml_fallback_without_store(self):
        nr.set_db_loader(None)
        nr.reset_registry_cache()
        loaded = nr.load_norms_file("at")
        assert loaded is not None
        assert loaded.corpus_collection == "oib_knowledge"

    def test_unknown_country_yaml_missing_returns_none(self):
        nr.set_db_loader(None)
        assert nr.load_norms_file("zz") is None
