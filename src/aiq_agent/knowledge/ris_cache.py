"""Persistent cache records for RIS-fetched consolidated statutes (norm-registry Phase 3).

A persistent cache of consolidated statutes is a correctness hazard: a Novelle
changes the text, and LrKons/BrKons statutes version by Fassung date, not by
Ausgabe. This module is the storage half of the freshness policy (spec §4.4);
the fetch path in ``sources/ris_adapter`` owns re-validation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import asdict
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from datetime import timedelta
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_CACHE_DIR = Path("data/ris_cache")
ENV_CACHE_TTL_DAYS = "GRID_RIS_CACHE_TTL_DAYS"
DEFAULT_TTL_DAYS = 7


def cache_ttl_days() -> int:
    """TTL for cached RIS documents before metadata re-validation (default 7 days)."""
    raw = os.environ.get(ENV_CACHE_TTL_DAYS, "").strip()
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_TTL_DAYS
    return value if value > 0 else DEFAULT_TTL_DAYS


@dataclass
class RisCacheRecord:
    """One cached RIS document: the registry metadata plus where its text lives."""

    document_number: str
    content_hash: str
    fetched_at: datetime
    fassung: str | None
    title: str
    url: str
    file_name: str
    ingested_at: datetime | None = None


class RisCacheStore:
    """JSON registry + plain-text files under a cache directory."""

    def __init__(self, cache_dir: Path | str = DEFAULT_CACHE_DIR) -> None:
        self._dir = Path(cache_dir)
        self._registry_path = self._dir / "registry.json"

    def lookup(self, document_number: str) -> RisCacheRecord | None:
        registry = self._read_registry()
        raw = registry.get(document_number)
        if not raw:
            return None
        try:
            raw["fetched_at"] = datetime.fromisoformat(raw["fetched_at"])
            if raw.get("ingested_at"):
                raw["ingested_at"] = datetime.fromisoformat(raw["ingested_at"])
            return RisCacheRecord(**raw)
        except (TypeError, ValueError):
            logger.warning("ris_cache: corrupt registry entry for %s, ignoring", document_number)
            return None

    def is_fresh(self, record: RisCacheRecord, ttl_days: int) -> bool:
        return datetime.now(UTC) - record.fetched_at < timedelta(days=ttl_days)

    def store(
        self,
        document_number: str,
        *,
        text: str,
        url: str,
        title: str,
        fassung: str | None,
        file_name: str,
    ) -> RisCacheRecord:
        self._dir.mkdir(parents=True, exist_ok=True)
        text_path = self._text_path(document_number)
        text_path.write_text(text, encoding="utf-8")
        record = RisCacheRecord(
            document_number=document_number,
            content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            fetched_at=datetime.now(UTC),
            fassung=fassung,
            title=title,
            url=url,
            file_name=file_name,
        )
        registry = self._read_registry()
        registry[document_number] = self._serialize(record)
        self._write_registry(registry)
        return record

    def touch(self, record: RisCacheRecord) -> None:
        record.fetched_at = datetime.now(UTC)
        registry = self._read_registry()
        registry[record.document_number] = self._serialize(record)
        self._write_registry(registry)

    def mark_ingested(self, record: RisCacheRecord) -> None:
        """Remember that the cached text has been embedded into ``ris_knowledge``."""
        record.ingested_at = datetime.now(UTC)
        registry = self._read_registry()
        registry[record.document_number] = self._serialize(record)
        self._write_registry(registry)

    def read_text(self, record: RisCacheRecord) -> str:
        return self._text_path(record.document_number).read_text(encoding="utf-8")

    def _text_path(self, document_number: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in document_number)
        return self._dir / f"{safe}.txt"

    @staticmethod
    def _serialize(record: RisCacheRecord) -> dict:
        raw = asdict(record)
        raw["fetched_at"] = record.fetched_at.isoformat()
        raw["ingested_at"] = record.ingested_at.isoformat() if record.ingested_at else None
        return raw

    def _read_registry(self) -> dict:
        try:
            return json.loads(self._registry_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _write_registry(self, registry: dict) -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        self._registry_path.write_text(json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8")
