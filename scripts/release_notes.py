#!/usr/bin/env python3
"""Release notes: lint the reno notes, publish them to the marketing site.

The pipeline this file implements
---------------------------------

1. A change that a customer can notice ships with a reno note
   (``releasenotes/notes/<slug>-<hash>.yaml``, written with ``task release:note``).
   ``lint`` enforces the house rules on it, on every PR.
2. On merge to ``develop``, ``publish`` reads the notes **through reno** — so a
   note is attributed to the release it actually shipped in, from git history
   rather than from whatever the file claims — translates the new English
   strings into German once, and writes
   ``frontends/web/src/data/changelog.json``.
3. The Astro site renders that file at ``/changelog`` (de) and ``/en/changelog``
   (en). The web image is built from the repo, so the commit made in step 2 is
   what puts the note in front of a reader.

Why a JSON artifact instead of ``reno report``
----------------------------------------------

``reno report`` emits reStructuredText for a Sphinx build. The marketing site is
Astro, and the notes have to survive machine translation string by string (so a
translation is cached per sentence, not per release). A structured artifact gives
both: the page renders typed data with the site's own components, and the
translator sees one note at a time.

Why the artifact is committed rather than generated at build time
-----------------------------------------------------------------

reno derives versions from git history, and the web Docker build has neither the
history (it copies a working tree) nor a Python toolchain. Generating on merge
and committing the result keeps the image build hermetic and offline.

Usage
-----

    python scripts/release_notes.py lint
    python scripts/release_notes.py publish [--check] [--no-translate]

reno itself is deliberately *not* a repo dependency — it is needed by two
commands and a workflow, not by the product — so the Taskfile runs this script
under ``uv run --no-project --with reno``. Everything except the git scan works
without it, which is also what keeps the unit tests reno-free.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import timedelta
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
RELNOTES_DIR = REPO_ROOT / "releasenotes"
NOTES_DIR = RELNOTES_DIR / "notes"
TRANSLATIONS_FILE = RELNOTES_DIR / "translations" / "de.json"
CHANGELOG_FILE = REPO_ROOT / "frontends" / "web" / "src" / "data" / "changelog.json"

SUMMARIES_FILE = RELNOTES_DIR / "summaries.yaml"

PRELUDE_SECTION = "prelude"

# Sections reno keeps and the public changelog never shows. The changelog on
# piloti.at is product news for the architect using Piloti, not a bug register,
# so three kinds of note are kept in the repository and off the page:
#
# * `operators`: only the people running the platform can act on it (model
#   defaults, the Platform area, deployment and migration steps);
# * `security`: a vulnerability, a hardening, a dependency bumped for a CVE. The
#   public page named a remote-code-execution flaw before this was internal;
# * `incident`: a severe fix, something that should never have happened (data
#   lost or kept after deletion, a permission or legal hold that did not hold,
#   an answer passed as checked when it was not, a false claim on the site).
#
# A customer who must hear about a security or incident fix is told directly,
# not by a changelog line. `task release:preview` still lists all three.
INTERNAL_SECTIONS = frozenset({"operators", "security", "incident"})

# German titles for the sections defined in releasenotes/config.yaml. The English
# side lives in that config (reno owns it); this is the other half. They are
# checked against each other by tests/test_release_notes.py, so adding a section
# to the config without a translation here fails the backend suite rather than
# shipping an untranslated heading.
SECTION_TITLES_DE = {
    "features": "Neue Funktionen",
    "improvements": "Verbesserungen",
    "fixes": "Fehlerbehebungen",
    "security": "Sicherheit",
    "incident": "Schwere Fehler",
    "deprecations": "Auslaufende Funktionen",
    "upgrade": "Hinweise zur Umstellung",
    "other": "Sonstiges",
    "operators": "Für Plattform-Betreiber",
}

# ── Authoring rules ─────────────────────────────────────────────────────────
#
# Every note is published verbatim to a public page, so the lint is about
# readability for a customer, not about YAML validity. Each rule below exists
# because the failure it prevents is invisible until it is on the website.

MIN_LENGTH = 20
MAX_LENGTH = 400
MAX_SENTENCES = 2
# A week's summary covers a dozen notes, so it gets a little more room than one.
SUMMARY_MAX_LENGTH = 500
SUMMARY_MAX_SENTENCES = 3
# An internal note may carry a migration step or the cause of an incident, so it
# gets two more sentences. Nobody outside the repository reads it.
INTERNAL_MAX_SENTENCES = 4

# The source language is English; German is generated from it. A note written
# in German is published as "English" on /en/changelog and translated from German
# into German for /changelog, which is how 344 German sentences reached the
# English page before this check existed. Function words decide it: they occur in
# every sentence, and the two sets do not overlap. Quoted UI labels are removed
# first, because an English note may quote „Von Piloti erstellt" verbatim.
# (A language-identification library was the alternative; the lint runs outside
# the project environment on every PR, and the question here is only ever
# "English or German", which this answers without a model download.)
GERMAN_FUNCTION_WORDS = frozenset(
    "der die das und ist nicht mit für auf werden wird sind ein eine einen einem einer "
    "im den dem des zu von sie jetzt auch nach bei wenn oder kann können aus als wie "
    "noch nur über statt bisher wieder dass sich es zum zur".split()
)
ENGLISH_FUNCTION_WORDS = frozenset(
    "the and is not with for on are a an of to from you now also after when or can in "
    "it that this by be as has have its your their which what no was were".split()
)
QUOTED = re.compile(r"„[^“\"”]*[“\"”]|\"[^\"]*\"|“[^”]*”|»[^«]*«")

# Phrasing that marks a note as written for the people who run the platform. The
# public changelog is for architects; these belong in the `operators` section.
OPERATOR_PATTERNS = re.compile(
    r"\b(platform operators?|operators? of the platform|whoever operates|platform staff"
    r"|platform support role|Platform\s*(→|->|>)|Platform (settings|area)|Plattform\s*→|Plattform-Betreiber"
    r"|environment variable|Umgebungsvariable|self-host\w*|(new|existing) (installations?|deployments?)"
    r"|search index volume|feature flag)",
    re.IGNORECASE,
)

# reStructuredText that reno tolerates and the changelog page would render as
# literal punctuation: directives, comments, roles, literal markup, code fences.
RST_PATTERNS = [
    (re.compile(r"^\s*\.\.\s"), "reStructuredText directive or comment (`.. `)"),
    (re.compile(r"::\s*$", re.MULTILINE), "reStructuredText literal block marker (`::`)"),
    (re.compile(r"```"), "code fence"),
    (re.compile(r"`"), "backtick (the changelog renders plain text)"),
    (re.compile(r":(ref|doc|class|func|meth|py:\w+):"), "reStructuredText role"),
]

# Internal references. A reader of piloti.at has no issue tracker, no repository
# and no module names — a note that mentions them was written for the reviewer.
INTERNAL_PATTERNS = [
    (re.compile(r"(?<![\w#])#\d+\b"), "issue or PR number"),
    # The lookahead demands a digit, so ordinary words that happen to be spelled
    # out of a-f ("defaced", "acceded") are not mistaken for a sha.
    (re.compile(r"\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b"), "commit sha"),
    (re.compile(r"\b\w+\.(py|ts|tsx|astro|yml|yaml|json|mjs)\b"), "file name"),
    (re.compile(r"\b(src|frontends|sources|configs|deploy)/"), "repository path"),
    (re.compile(r"https?://(?!(www\.)?piloti\.at)"), "link to something other than piloti.at"),
]

# Sentences shipped by the `reno new` template. A note still carrying one was
# created and never written.
TEMPLATE_MARKERS = [
    "say what is new, from the reader's side",
    "say what got better about something they already had",
    "say what used to go wrong",
    "only for changes a customer must know about",
    "name what is going away",
    "only when the reader has to do something themselves",
    "anything genuinely user-visible",
    "only for the people running the platform; never published",
    "replace this text",
]


@dataclass
class Note:
    """One note file, as published: its sections and where it landed."""

    filename: str
    version: str
    date: str | None
    sections: dict[str, list[str]] = field(default_factory=dict)
    prelude: str | None = None


# ── Note loading ────────────────────────────────────────────────────────────


def read_config_sections(config_path: Path) -> list[tuple[str, str]]:
    """The `(key, English title)` pairs from reno's own config, in render order."""
    data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    sections = data.get("sections") or []
    # reno accepts `[key, title]` and `[key, title, level]`; only the first two
    # matter here.
    return [(entry[0], entry[1]) for entry in sections]


def load_notes_from_reno(repo_root: Path, relnotes_dir_name: str = "releasenotes") -> list[Note]:
    """Read every note through reno, so git history decides where a note belongs.

    Imported lazily: reno is a release-tooling dependency, and everything that
    can be unit tested here works on the structures this function returns rather
    than on reno itself.
    """
    from reno import config as reno_config
    from reno import loader as reno_loader

    conf = reno_config.Config(str(repo_root), relnotes_dir_name)
    added = note_added_dates(repo_root, f"{relnotes_dir_name}/notes")
    notes: list[Note] = []
    with reno_loader.Loader(conf) as ldr:
        for version in ldr.versions:
            for filename, sha in ldr[version]:
                body = ldr.parse_note_file(filename, sha)
                if not body:
                    continue
                sections = {
                    key: [value] if isinstance(value, str) else list(value)
                    for key, value in body.items()
                    if key != PRELUDE_SECTION
                }
                notes.append(
                    Note(
                        filename=filename,
                        version=version,
                        date=added.get(Path(filename).name) or _note_date(repo_root, sha),
                        sections=sections,
                        prelude=body.get(PRELUDE_SECTION),
                    )
                )
    return notes


def note_added_dates(repo_root: Path, notes_path: str) -> dict[str, str]:
    """The day each note file first entered history, keyed by its file name.

    reno hands back the sha of a note's *latest* revision, so dating a note by
    that sha moved it to the day somebody last corrected it: fixing a typo in an
    August note republished it under this week. The first commit that added the
    file is the day it shipped. Renames carry the original date over, because
    reno treats a renamed note (same unique id) as the same note.
    """
    try:
        out = subprocess.run(
            ["git", "log", "--reverse", "-M", "--name-status", "--format=@%cI", "--", notes_path],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except (subprocess.CalledProcessError, OSError):
        return {}
    return parse_added_dates(out)


def parse_added_dates(log: str) -> dict[str, str]:
    """Fold `git log --reverse --name-status --format=@%cI` output into first-add dates."""
    added: dict[str, str] = {}
    day = ""
    for line in log.splitlines():
        if line.startswith("@"):
            day = line[1:11]
            continue
        parts = line.split("\t")
        status = parts[0][:1]
        if status == "A" and len(parts) == 2:
            added.setdefault(Path(parts[1]).name, day)
        elif status == "R" and len(parts) == 3:
            added.setdefault(Path(parts[2]).name, added.get(Path(parts[1]).name, day))
    return added


def _note_date(repo_root: Path, sha: bytes | str | None) -> str | None:
    """The day a commit landed: the fallback when a note's first add is unknown.

    `sha` is None for a note that is staged but not yet committed (reno reports
    those under a `*working-copy*` version), which is the normal state during a
    local preview.
    """
    if not sha:
        return None
    rev = sha.decode() if isinstance(sha, bytes) else sha
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cI", rev],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
        )
    except (subprocess.CalledProcessError, OSError):
        return None
    stamp = out.stdout.strip()
    return stamp[:10] if stamp else None


# ── Grouping ────────────────────────────────────────────────────────────────


def group_notes(
    notes: list[Note],
    section_order: list[str],
    summaries: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Group notes into the releases the page renders, newest first.

    Two shapes, because the repo has both futures in it:

    * a **version** group, once release tagging starts — reno hands us the tag
      and every note that shipped under it;
    * a **week** group, which is what the repo produces today: nothing is
      tagged, so reno files everything under one unreleased version. The repo
      merges many times a day, and grouping by day gave the reader 29 headings in
      six weeks, some holding one note and some fifty; an ISO week is the unit a
      reader can take in.

    Only sections in `section_order` survive, which is how the internal
    sections (`INTERNAL_SECTIONS`) stay off the public page. A group's summary comes from
    `summaries` (releasenotes/summaries.yaml, keyed by group id) and falls back
    to a reno prelude.
    """
    summaries = summaries or {}
    groups: dict[str, dict[str, Any]] = {}
    for note in notes:
        if not any(section in section_order for section in note.sections) and not note.prelude:
            continue
        group = groups.setdefault(*_group_for(note))
        if note.prelude and not group["summary"]:
            group["summary"] = _clean(note.prelude)
        for section, entries in note.sections.items():
            if section in section_order:
                group["sections"].setdefault(section, []).extend(_clean(entry) for entry in entries)

    ordered = sorted(groups.values(), key=lambda g: g["_sort"], reverse=True)
    for group in ordered:
        del group["_sort"]
        if group["id"] in summaries:
            group["summary"] = _clean(summaries[group["id"]])
        group["sections"] = [
            {"key": key, "notes": group["sections"][key]} for key in section_order if key in group["sections"]
        ]
    return [group for group in ordered if group["sections"] or group["summary"]]


def _group_for(note: Note) -> tuple[str, dict[str, Any]]:
    """The group id a note belongs to, and the empty group to start it with."""
    if _is_release_version(note.version):
        group_id, kind, start, end, sort = note.version, "version", note.date, None, ("1", note.version)
    elif note.date:
        group_id, start, end = week_of(note.date)
        kind, sort = "week", ("0", start)
    else:
        group_id, kind, start, end, sort = "unreleased", "week", None, None, ("0", "9999-99-99")
    return group_id, {
        "id": group_id,
        "kind": kind,
        "version": note.version if kind == "version" else None,
        "date": start,
        "dateEnd": end,
        "summary": None,
        "sections": {},
        "_sort": sort,
    }


def week_of(day: str) -> tuple[str, str, str]:
    """`2026-09-26` -> (`2026-W39`, Monday `2026-09-21`, Sunday `2026-09-27`)."""
    when = date.fromisoformat(day)
    year, week, weekday = when.isocalendar()
    monday = when - timedelta(days=weekday - 1)
    return f"{year}-W{week:02d}", monday.isoformat(), (monday + timedelta(days=6)).isoformat()


def _is_release_version(version: str) -> bool:
    """True for a real tag; false for reno's unreleased placeholders.

    Untagged repositories get `0.0.0`, a working tree gets `*working-copy*`, and
    commits after a tag get `<tag>-<n>` — none of those is something to print as
    a release heading.
    """
    if version.startswith("*") or "-" in version:
        return False
    return version != "0.0.0"


def _clean(text: str) -> str:
    """Collapse the YAML folding artefacts so the page gets one clean sentence."""
    return " ".join(text.split()).strip()


# ── Translation ─────────────────────────────────────────────────────────────

TRANSLATION_MODEL = os.environ.get("RELEASE_NOTES_TRANSLATION_MODEL", "openai/gpt-6-luna")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

TRANSLATION_SYSTEM_PROMPT = (
    "You translate product release notes for Piloti, an AI platform for Austrian "
    "architecture and planning offices, from English into German.\n"
    "Rules:\n"
    "- Austrian business German, formal address (Sie), present tense.\n"
    "- Translate meaning, not words. Keep it as short as the English.\n"
    "- Keep product names (Piloti), standards and legal terms (OIB-Richtlinien, "
    "Landesbauordnung) exactly as they are.\n"
    "- Keep the English loanwords Austrian professionals actually use — Changelog, "
    "Login, Update, Upload, Dashboard — instead of inventing a German equivalent.\n"
    "- Add nothing, explain nothing, drop nothing.\n"
    "- Answer with the German sentence only — no quotes, no preamble."
)


def text_key(text: str) -> str:
    """In-memory cache key for one English string: content-addressed and cheap.

    Never written to disk. The file stores `{"en": …, "de": …}` pairs and this is
    recomputed on load — a 16-hex-character digest sitting in a JSON file reads
    as a credential to every secret scanner that looks at it, and there is no way
    to mark a false positive inline in JSON. Deriving it removes the question
    instead of answering it, and the file is more readable for the human who has
    to correct a translation.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def load_translations(path: Path) -> dict[str, dict[str, str]]:
    """The on-disk pairs, keyed for lookup by the English text they translate."""
    if not path.exists():
        return {}
    entries = json.loads(path.read_text(encoding="utf-8"))
    return {text_key(entry["en"]): entry for entry in entries if entry.get("en")}


def save_translations(path: Path, translations: dict[str, dict[str, str]]) -> None:
    """Write the pairs back, sorted by the English text so diffs stay stable."""
    entries = sorted(
        ({"en": entry["en"], "de": entry["de"]} for entry in translations.values()),
        key=lambda entry: entry["en"],
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def collect_strings(groups: list[dict[str, Any]]) -> list[str]:
    """Every English string the page will show, in a stable order."""
    strings: list[str] = []
    for group in groups:
        if group.get("summary"):
            strings.append(group["summary"])
        for section in group["sections"]:
            strings.extend(section["notes"])
    # dict.fromkeys: de-duplicate without losing the order (a translation is paid
    # for once even when the same sentence appears twice).
    return list(dict.fromkeys(strings))


def translate(text: str, api_key: str, model: str = TRANSLATION_MODEL, attempts: int = 3) -> str:
    """One English string to German via OpenRouter, or raise after `attempts`.

    stdlib only, on purpose: this runs in a throwaway CI environment that has
    reno and nothing else, and the call is a single JSON POST. urllib also reads
    HTTPS_PROXY, which `http.client` does not — the tooling has to work from a
    dev container and a corporate laptop as well as from a runner.
    """
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": TRANSLATION_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ],
    }
    request = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # OpenRouter attributes traffic by these; they are not credentials.
            "HTTP-Referer": "https://piloti.at",
            "X-Title": "Piloti release notes",
        },
        method="POST",
    )
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            # The scanners ask the same question about urllib — it will open
            # `file://` if handed a URL that something else chose. Nothing does:
            # OPENROUTER_URL is a module constant, and the only value that varies
            # is the note text, which travels in the body. Swapping this for
            # `http.client.HTTPSConnection` answers it in the type system but
            # trades the finding for `httpsconnection-detected` (unconditional,
            # even with an explicit verified SSL context) and loses proxy support.
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - constant https URL
                raw = response.read().decode("utf-8")
            german = json.loads(raw)["choices"][0]["message"]["content"].strip()
            if not german:
                raise ValueError("empty translation")
            return german
        except (urllib.error.URLError, KeyError, IndexError, ValueError, TimeoutError) as exc:
            last_error = exc
            if attempt < attempts - 1:
                time.sleep(2**attempt)
    raise RuntimeError(f"translation failed after {attempts} attempts: {last_error}")


def resolve_translations(
    strings: list[str],
    translations: dict[str, dict[str, str]],
    *,
    enabled: bool,
    require: bool,
) -> tuple[dict[str, str], list[str]]:
    """Map every English string to German, filling the cache with what is missing.

    Returns the mapping plus the strings that stayed English. A missing
    translation is a warning rather than a failure by default: the changelog
    showing an English sentence to a German reader is worse than nothing only if
    it is permanent, and the next run with a key in the environment fixes it.
    `require` turns it into a failure for the publish workflow, which does have
    the key and should not silently ship English.
    """
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    mapping: dict[str, str] = {}
    untranslated: list[str] = []
    for text in strings:
        key = text_key(text)
        cached = translations.get(key)
        if cached and cached.get("de"):
            mapping[text] = cached["de"]
            continue
        if not (enabled and api_key):
            mapping[text] = text
            untranslated.append(text)
            continue
        german = translate(text, api_key)
        translations[key] = {"en": text, "de": german}
        mapping[text] = german
    if untranslated and require:
        raise SystemExit(
            f"{len(untranslated)} note(s) have no German translation and "
            "--require-translations was given. Is OPENROUTER_API_KEY set?"
        )
    return mapping, untranslated


def prune_translations(translations: dict[str, dict[str, str]], strings: list[str]) -> dict[str, dict[str, str]]:
    """Drop cache entries no note refers to any more, so the file stays readable."""
    live = {text_key(text) for text in strings}
    return {key: value for key, value in translations.items() if key in live}


# ── Rendering ───────────────────────────────────────────────────────────────


def build_changelog(
    groups: list[dict[str, Any]],
    sections: list[tuple[str, str]],
    german: dict[str, str],
) -> dict[str, Any]:
    """The artifact the Astro page consumes: bilingual, ordered, self-describing."""

    def bilingual(text: str) -> dict[str, str]:
        return {"en": text, "de": german.get(text, text)}

    return {
        "$comment": (
            "GENERATED FILE — do not edit. Written by scripts/release_notes.py from "
            "releasenotes/notes/ and committed by .github/workflows/release-notes.yml "
            "on merge to develop. Regenerate with `task release:changelog`."
        ),
        "sectionTitles": {key: {"en": title, "de": SECTION_TITLES_DE.get(key, title)} for key, title in sections},
        "releases": [
            {
                "id": group["id"],
                "kind": group["kind"],
                "version": group["version"],
                "date": group["date"],
                "dateEnd": group.get("dateEnd"),
                "summary": bilingual(group["summary"]) if group["summary"] else None,
                "sections": [
                    {"key": section["key"], "notes": [bilingual(note) for note in section["notes"]]}
                    for section in group["sections"]
                ],
            }
            for group in groups
        ],
    }


def dump_json(data: dict[str, Any]) -> str:
    """Deterministic serialisation — the file is diffed and committed by a bot."""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


# ── Lint ────────────────────────────────────────────────────────────────────


def lint_note(filename: str, raw: str, valid_sections: set[str]) -> list[str]:
    """House-rule violations in one note file, each with the fix spelled out."""
    try:
        content = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        return [f"{filename}: not valid YAML ({exc}). Fix: compare it with the template `task release:note` writes."]
    if not isinstance(content, dict):
        return [f"{filename}: the file must be a YAML mapping of section -> list of entries."]
    if not content:
        return [f"{filename}: the file is empty. Fix: write the note, or delete the file."]

    problems: list[str] = []
    for section, body in content.items():
        entries, problem = _section_entries(section, body, valid_sections)
        if problem:
            problems.append(f"{filename}: {problem}")
            continue
        for entry in entries:
            if not isinstance(entry, str):
                problems.append(f"{filename}: section `{section}` has an entry that is not text.")
                continue
            public = section not in INTERNAL_SECTIONS
            limit = MAX_SENTENCES if public else INTERNAL_MAX_SENTENCES
            issues = lint_text(entry, public=public, max_sentences=limit)
            problems.extend(f"{filename} ({section}): {issue}" for issue in issues)
    return problems


def _section_entries(section: str, body: Any, valid_sections: set[str]) -> tuple[list[Any], str | None]:
    """A section's entries, or the structural problem that stops them being read."""
    if section == PRELUDE_SECTION:
        if isinstance(body, str):
            return [body], None
        return [], f"`{PRELUDE_SECTION}` must be one block of text, not a list."
    if section not in valid_sections:
        allowed = ", ".join(sorted(valid_sections))
        return [], f"unknown section `{section}`. Fix: use one of {allowed}."
    if not isinstance(body, list):
        return [], f"section `{section}` must be a list of entries (`- >` before each one)."
    if not body:
        return [], f"section `{section}` is empty. Fix: delete the section."
    return body, None


def lint_text(
    entry: str,
    *,
    public: bool = True,
    max_length: int = MAX_LENGTH,
    max_sentences: int = MAX_SENTENCES,
) -> list[str]:
    """The published-prose rules, applied to one entry. Every message names the fix."""
    text = _clean(entry)
    if not text:
        return ["the entry is blank. Fix: write it, or delete the entry."]
    lowered = text.lower()
    if any(marker in lowered for marker in TEMPLATE_MARKERS):
        return ["the entry still holds the `reno new` template text. Fix: replace it with your note."]

    issues: list[str] = []
    if looks_german(text):
        issues.append(
            "reads as German. Fix: write the note in English; the German page is translated from it. "
            "German you already wrote is not lost: once the English is final, put the pair into "
            "releasenotes/translations/de.json as the `de` side of your English sentence."
        )
    if public and OPERATOR_PATTERNS.search(text):
        issues.append(
            "reads as a note for the people who run the platform. Fix: move it to the `operators` "
            "section, which stays off the public changelog; or rewrite it for the architect using Piloti."
        )
    if len(text) < MIN_LENGTH:
        issues.append(f"too short ({len(text)} chars) to mean anything to a reader. Fix: say what changed for them.")
    if len(text) > max_length:
        issues.append(
            f"too long ({len(text)} chars, limit {max_length}). Fix: keep what changed for the reader; "
            "the mechanism belongs in the PR description."
        )
    count = sentence_count(text)
    if count > max_sentences:
        issues.append(
            f"{count} sentences, limit {max_sentences}. Fix: one sentence for what changed, one for why "
            "it matters; split an unrelated change into its own entry."
        )
    if text[-1] not in ".!?":
        issues.append("does not end with punctuation. Fix: write it as a full sentence.")
    for pattern, label in RST_PATTERNS:
        if pattern.search(entry):
            issues.append(f"contains a {label}. Fix: remove the markup; the changelog renders plain text.")
    for pattern, label in INTERNAL_PATTERNS:
        if pattern.search(text):
            issues.append(f"mentions a {label}. Fix: describe the effect on the reader, not the change to the code.")
    return issues


def _unquoted(text: str) -> str:
    """The text with quoted labels removed: „Von Piloti erstellt" is a UI string, not prose."""
    return QUOTED.sub("X", text)


def looks_german(text: str) -> bool:
    """True when the prose outside quotation marks is German rather than English."""
    words = re.findall(r"[a-zäöüß]+", _unquoted(text).lower())
    german = sum(word in GERMAN_FUNCTION_WORDS for word in words)
    english = sum(word in ENGLISH_FUNCTION_WORDS for word in words)
    return german >= 2 and german > english


# A sentence ends at . ! ? or … followed by a space and a capital letter or an
# opening quote. A digit does not start a sentence, so "Pkt. 3.5.2" and "S. 7"
# stay one; neither does a lower-case word, so "e.g. a plan" stays one.
_SENTENCE_END = re.compile(r"[.!?…](?=\s+[„“\"'(]?[A-ZÄÖÜ])")


def sentence_count(text: str) -> int:
    """How many sentences a reader sees in the entry, quoted labels not counted."""
    return len(_SENTENCE_END.findall(_unquoted(text))) + 1


SUMMARY_KEY = re.compile(r"^(\d{4}-W\d{2}|\d+\.\d+\.\d+)$")


def lint_summaries(raw: str) -> list[str]:
    """The rules for releasenotes/summaries.yaml: known group ids, and short English prose."""
    try:
        content = yaml.safe_load(raw) or {}
    except yaml.YAMLError as exc:
        return [f"summaries.yaml: not valid YAML ({exc})."]
    if not isinstance(content, dict):
        return ["summaries.yaml: must be a mapping of week (2026-W39) or version (1.2.0) -> summary."]
    problems: list[str] = []
    for key, body in content.items():
        if not SUMMARY_KEY.match(str(key)):
            problems.append(f"summaries.yaml: `{key}` is not a week like 2026-W39 or a version like 1.2.0.")
            continue
        if not isinstance(body, str):
            problems.append(f"summaries.yaml ({key}): the summary must be one block of text.")
            continue
        issues = lint_text(body, max_length=SUMMARY_MAX_LENGTH, max_sentences=SUMMARY_MAX_SENTENCES)
        problems.extend(f"summaries.yaml ({key}): {issue}" for issue in issues)
    return problems


def load_summaries(path: Path) -> dict[str, str]:
    """The editorial summary of each week or version, keyed by its group id."""
    if not path.exists():
        return {}
    content = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return {str(key): value for key, value in content.items() if isinstance(value, str)}


def public_sections(sections: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The configured sections the changelog shows: all but the internal ones."""
    return [(key, title) for key, title in sections if key not in INTERNAL_SECTIONS]


def cmd_lint(args: argparse.Namespace) -> int:
    notes_dir = Path(args.notes_dir)
    config_path = Path(args.config)
    valid_sections = {key for key, _ in read_config_sections(config_path)}
    files = sorted(p for p in notes_dir.glob("*.yaml"))
    problems: list[str] = []
    for path in files:
        problems.extend(lint_note(path.name, path.read_text(encoding="utf-8"), valid_sections))
    summaries = Path(args.summaries)
    if summaries.exists():
        problems.extend(lint_summaries(summaries.read_text(encoding="utf-8")))

    if problems:
        print(f"\nRelease-note lint failed ({len(problems)}):\n", file=sys.stderr)
        for problem in problems:
            print(f"  ✗ {problem}", file=sys.stderr)
        print(
            "\nNotes are published to https://piloti.at/changelog, for the architect using\n"
            "Piloti. Good and bad examples: docs/contributing/release-notes.md.\n",
            file=sys.stderr,
        )
        return 1
    print(f"Release-note lint passed ({len(files)} notes).")
    return 0


# ── Publish ─────────────────────────────────────────────────────────────────


def cmd_publish(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root)
    sections = public_sections(read_config_sections(repo_root / "releasenotes" / "config.yaml"))
    notes = load_notes_from_reno(repo_root)
    summaries = load_summaries(Path(args.summaries))
    groups = group_notes(notes, [key for key, _ in sections], summaries)

    strings = collect_strings(groups)
    translations_path = Path(args.translations)
    translations = load_translations(translations_path)
    german, untranslated = resolve_translations(
        strings,
        translations,
        enabled=not args.no_translate,
        require=args.require_translations,
    )
    changelog = build_changelog(groups, sections, german)
    rendered = dump_json(changelog)

    output = Path(args.output)
    if args.check:
        current = output.read_text(encoding="utf-8") if output.exists() else ""
        if current != rendered:
            print(
                f"{output} is out of date with releasenotes/notes/. Run `task release:changelog`.",
                file=sys.stderr,
            )
            return 1
        print(f"{output} is up to date ({len(strings)} notes).")
        return 0

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    if not args.no_translate:
        save_translations(translations_path, prune_translations(translations, strings))

    for text in untranslated:
        print(f"  ! no German translation, published in English: {text[:80]}…", file=sys.stderr)
    print(f"Wrote {output} — {len(changelog['releases'])} release(s), {len(strings)} note(s).")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    lint = sub.add_parser("lint", help="check the notes against the house rules")
    lint.add_argument("--notes-dir", default=str(NOTES_DIR))
    lint.add_argument("--config", default=str(RELNOTES_DIR / "config.yaml"))
    lint.add_argument("--summaries", default=str(SUMMARIES_FILE))
    lint.set_defaults(func=cmd_lint)

    publish = sub.add_parser("publish", help="regenerate the changelog artifact for the website")
    publish.add_argument("--repo-root", default=str(REPO_ROOT))
    publish.add_argument("--output", default=str(CHANGELOG_FILE))
    publish.add_argument("--translations", default=str(TRANSLATIONS_FILE))
    publish.add_argument("--summaries", default=str(SUMMARIES_FILE))
    publish.add_argument(
        "--no-translate",
        action="store_true",
        help="use the cached translations only; never call the translation API",
    )
    publish.add_argument(
        "--require-translations",
        action="store_true",
        help="fail instead of publishing an English sentence to the German page",
    )
    publish.add_argument(
        "--check",
        action="store_true",
        help="verify the committed artifact matches the notes; write nothing",
    )
    publish.set_defaults(func=cmd_publish)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
