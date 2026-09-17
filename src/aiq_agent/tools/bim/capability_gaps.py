"""What the model asked the spatial surface for and could not get.

A JSONL ledger of vocabulary misses (``measure="wandstaerke"``), plus one
ERROR log per distinct miss per process so the OTLP collector turns it into an
issue. Only a NAME-shaped value leaves the process; the full text stays local.

Record ONLY a value that is in no vocabulary. Not ``decidable: false`` (a
finding about the export) and not a wrong GlobalId (a mistake the caller fixes
in the same turn) — a ledger that logs every refusal is a log nobody reads.
Nothing here may turn a working measurement into an error: the ledger is a
convenience for us, the architect's answer is the product.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: How much of a model-authored value is kept: long enough to name a
#: measurement, short enough that a pasted paragraph cannot fill a disk.
MAX_VALUE_CHARS = 120

#: Beyond this the ledger stops accepting rows. The ledger is advisory; the
#: disk it shares is not.
MAX_BYTES = 8 * 1024 * 1024

#: A value shaped like a NAME — the only shape that is exported. German letters
#: are in the class because the vocabulary this surface refuses is German.
_NAME_SHAPED = re.compile(r"^[\w .\-]{1,60}$", re.UNICODE)

#: Exported in place of a value that is not name-shaped.
UNEXPORTABLE = "<nicht exportierbar>"

#: Past this many distinct misses the process stops escalating: a model that
#: invents a fresh word every turn must not page all night.
MAX_ESCALATIONS = 50


def default_path() -> Path:
    """An application-owned state directory, never a predictable name in shared ``/tmp``.

    A world-writable directory lets any local user pre-create the path as a
    file (to read model-authored requests) or a symlink (to redirect the
    append). The ``/tmp`` fallback is a directory of our own, created ``0o700``.
    """
    state = os.environ.get("XDG_STATE_HOME")
    if state:
        return Path(state) / "aiq" / "capability-gaps.jsonl"
    home = Path.home()
    if str(home) not in ("", "/") and os.access(home.parent if not home.exists() else home, os.W_OK):
        return home / ".local" / "state" / "aiq" / "capability-gaps.jsonl"
    return Path(tempfile.gettempdir()) / f"aiq-{os.getuid()}" / "capability-gaps.jsonl"


def ledger_path() -> Path:
    """The ledger in use. The env var is a TRUSTED deployment override, never request-influenced."""
    override = os.environ.get("AIQ_CAPABILITY_GAP_LOG")
    return Path(override) if override else default_path()


def _one_line(value: Any) -> str:
    """A model-authored value made safe for one line of a log read in a terminal."""
    text = str(value or "").strip()
    text = "".join(character for character in text if character.isprintable())
    return text[:MAX_VALUE_CHARS]


class _Escalations:
    """Registry of ``(surface, field, value)`` already reported as an ERROR in this process.

    Per-process by design: the error IS the issue, so the hundredth retry of
    one bad name must not be the hundredth issue. Reset in tests only.
    """

    def __init__(self) -> None:
        self._seen: set[tuple[str, str, str]] = set()
        self._lock = threading.Lock()

    def first_time(self, key: tuple[str, str, str]) -> bool:
        with self._lock:
            if key in self._seen or len(self._seen) >= MAX_ESCALATIONS:
                return False
            self._seen.add(key)
            return True

    def reset(self) -> None:
        with self._lock:
            self._seen.clear()


_escalations = _Escalations()


def reset_escalations_for_tests() -> None:
    _escalations.reset()


def record_gap(*, surface: str, field: str, asked_for: Any, known: Any = ()) -> None:
    """Note that the caller wanted a name this surface does not have.

    Called from a pydantic validator, which LangChain runs on the event loop
    when it parses tool arguments — so when a loop is running the file write
    and the escalation are handed to the loop's executor rather than done
    inline. The refused call never reaches the tool body, so nothing later
    could flush a queue; the executor is the only place the write can go.
    """
    value = _one_line(asked_for)
    if not value:
        # "The model sent nothing" is a bug in the caller, not a feature request.
        return
    row = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "surface": surface,
        "field": field,
        "askedFor": value,
        "known": sorted(str(name) for name in known),
    }
    loop = _running_loop()
    if loop is None:
        _persist(row)
        return
    loop.run_in_executor(None, _persist, row)


def _running_loop() -> asyncio.AbstractEventLoop | None:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None


def _persist(row: dict[str, Any]) -> None:
    """Append the row and escalate it. An unwritable ledger is logged, never raised."""
    try:
        _append_line(ledger_path(), json.dumps(row, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("the capability-gap ledger could not be written: %s", exc)
    _escalate(row)


def _append_line(path: Path, text: str) -> None:
    """The one I/O unit: ``0o700`` directory, ``0o600`` file, no symlink following, capped size.

    ``O_NOFOLLOW`` makes a symlink on the final component an error rather than
    a redirect; ``Path.open("a")`` would follow it and take its mode from the
    umask. The size is read off the open descriptor rather than stat'ed first.
    """
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(handle).st_size >= MAX_BYTES:
            return
        os.write(handle, text.encode("utf-8"))
    finally:
        os.close(handle)


def _escalate(row: dict[str, Any]) -> None:
    """Report the miss as an ERROR once per distinct miss, so it becomes an issue."""
    value = str(row["askedFor"])
    if not _escalations.first_time((str(row["surface"]), str(row["field"]), value)):
        return
    exportable = value if _NAME_SHAPED.match(value) else UNEXPORTABLE
    try:
        logger.error(
            "ifc spatial surface: no %s named %r — a caller wanted a capability this surface does not have",
            row["field"],
            exportable,
            extra={
                "ifc_capability_gap": True,
                "ifc_gap_surface": row["surface"],
                "ifc_gap_field": row["field"],
                "ifc_gap_asked_for": exportable,
                "ifc_gap_known": ", ".join(row["known"]),
            },
        )
    except Exception:  # noqa: BLE001 — a logging handler that raises is not ours to re-raise into an answer
        logger.debug("the capability gap could not be escalated", exc_info=True)


def read_gaps(path: Path | None = None) -> list[dict[str, Any]]:
    """Every row, oldest first. Unreadable lines are skipped, not raised."""
    target = path or ledger_path()
    if not target.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in target.read_text(encoding="utf-8", errors="replace").splitlines():
        row = _parse_row(line)
        if row is not None:
            rows.append(row)
    return rows


def _parse_row(line: str) -> dict[str, Any] | None:
    if not line.strip():
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    return row if isinstance(row, dict) else None


def summarise(path: Path | None = None) -> list[dict[str, Any]]:
    """The ledger as a ranked backlog: what was wanted, and how often."""
    counts: Counter[tuple[str, str, str]] = Counter()
    last_seen: dict[tuple[str, str, str], str] = {}
    for row in read_gaps(path):
        key = (str(row.get("surface", "")), str(row.get("field", "")), str(row.get("askedFor", "")))
        counts[key] += 1
        last_seen[key] = str(row.get("at", ""))
    return [
        {"surface": surface, "field": field, "askedFor": asked, "count": count, "lastSeen": last_seen[key]}
        for key, count in counts.most_common()
        for surface, field, asked in [key]
    ]


def render_report(path: Path | None = None) -> str:
    """The backlog as text a person can paste into an issue. A human files it, never this module."""
    rows = summarise(path)
    if not rows:
        return "Keine Lücken erfasst — jede Anfrage traf ein vorhandenes Werkzeug."

    lines = [
        "# Was Modelle von dieser Oberfläche wollten und nicht bekamen",
        "",
        f"{len(rows)} verschiedene Anfragen, nach Häufigkeit.",
        "",
        "| Anzahl | Oberfläche | Feld | Gewünscht | Zuletzt |",
        "|---:|---|---|---|---|",
    ]
    for row in rows:
        asked = str(row["askedFor"]).replace("|", "\\|")
        lines.append(f"| {row['count']} | {row['surface']} | {row['field']} | `{asked}` | {row['lastSeen']} |")
    lines += [
        "",
        "Jede Zeile ist ein Name, den ein Modell aufgerufen hat und den es hier nicht gibt.",
        "Das ist keine Fehlermeldung über ein Gebäude, sondern eine Aussage darüber, was",
        "dieser Oberfläche fehlt. Die Werte stammen aus einem Sprachmodell — als",
        "Wunschliste lesen, nicht als Spezifikation.",
    ]
    return "\n".join(lines)


def reset_for_tests(path: Path | None = None) -> None:
    target = path or ledger_path()
    if target.exists():
        target.unlink()
