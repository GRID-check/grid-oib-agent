"""A fixture BFF for the precedent eval: the internal routes a cross-project turn reads, served from a fixture office.

The answer suite runs the real agent with no BFF, so it cannot ask a single
question about another project (docs/roadmap/office-experience.md, step A).
This serves exactly the routes that question needs, from
``frontends/ui/tests/fixtures/precedent/``:

- ``POST /api/internal/turn-context``: the current project's PROJECT_CONTEXT
  and the reference catalog, both as the production renderers wrote them
  (``rendered.json``, from ``reference-brief.fixture.spec.ts``);
- ``POST /api/internal/cross-project/{search,projects,brief}``: answered from
  ``office.json``, in the routes' wire shape.

Every OTHER internal route gets its connection dropped without an answer. That
is exactly what a suite run sees today, with no BFF at all, so a run differs
from the norm suite only by what this file serves. Search is lexical and
deliberately simple. The eval measures what the AGENT does with what the
lookup returns, not how well a vector search ranks: the BFF's own search is
tested in ``lib/cross-project/service.spec.ts``.

Every request is appended to ``requests.jsonl`` beside the run, so a check can
read which lookups a turn made and with what arguments.
"""

from __future__ import annotations

import json
import re
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "precedent"

#: As `CROSS_PROJECT_PAGE_PROJECTS` in `lib/cross-project/types.ts`.
PAGE_PROJECTS = 8
#: The office as `office.json` describes it; the other scenarios are named under its `scenarios`.
DEFAULT_SCENARIO = "default"
_WORD = re.compile(r"[a-z0-9]{4,}")


def _fold(text: str) -> str:
    """Lower-case, umlauts and ß spelled out, accents dropped: „Mödling" and „Moedling" are one word."""
    text = text.casefold().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def _words(text: str) -> set[str]:
    return set(_WORD.findall(_fold(text)))


def _stem(word: str) -> str:
    """The word without an inflection ending: „Fluchttreppen" and „Fluchttreppe" share „fluchttrepp".

    Only the last two letters go, never below five: a looser prefix made
    „Feuerwehraufzug" match „Feuerwiderstand", a precedent that does not exist.
    """
    return word[: max(5, len(word) - 2)]


def _score(query: str, document: dict[str, Any]) -> float:
    """The share of the query's words the document carries, inflections allowed."""
    wanted = _words(query)
    if not wanted:
        return 0.0
    have = _words(" ".join(str(document.get(key) or "") for key in ("title", "filename", "text")))
    hits = sum(1 for word in wanted if any(other.startswith(_stem(word)) for other in have))
    return round(hits / len(wanted), 3)


class FixtureOffice:
    """The fixture office and what the production renderers made of it."""

    def __init__(self, directory: Path = FIXTURES, scenario: str = DEFAULT_SCENARIO) -> None:
        self.office = json.loads((directory / "office.json").read_text(encoding="utf-8"))
        self._rendered = json.loads((directory / "rendered.json").read_text(encoding="utf-8"))["scenarios"]
        self.scenario = scenario
        if scenario not in self._rendered:
            raise KeyError(f"No scenario {scenario!r} in rendered.json: {sorted(self._rendered)}")
        spec = (self.office.get("scenarios") or {}).get(scenario) or {}
        self.current = spec.get("current") or self.office["current"]
        kept = spec.get("projects")
        every = self.office["projects"]
        office_projects = every if kept is None else [project for project in every if project["id"] in set(kept)]
        self.projects = {project["id"]: project for project in office_projects}
        self.rendered = self._rendered[scenario]

    def turn_context(self) -> dict[str, Any]:
        return {
            "data": {
                "projectContext": self.rendered["projectContext"],
                "projectMemory": None,
                "orgInstructions": None,
                "drewOnOtherProjects": False,
                "referenceProjects": self.rendered["referenceProjects"],
            }
        }

    def _ref(self, project: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": project["id"],
            "name": project["name"],
            "status": project["status"],
            "bundesland": (project.get("facts") or {}).get("bundesland"),
        }

    def _listed(self, project: dict[str, Any]) -> dict[str, Any]:
        return {
            **self._ref(project),
            "collection": project["collection"],
            "address": project.get("facts", {}).get("standort_adresse"),
            "period": {"start": project.get("startedOn") or "2013-01-01", "end": project.get("endedOn")},
            "current": project["id"] == self.current["id"],
        }

    def _in_scope(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        scope = body.get("scope") or "similar"
        if scope == "named":
            named = set(body.get("projectIds") or [])
            return [self.projects[pid] for pid in self.rendered["similarOrder"] if pid in named]
        ordered = [self.projects[pid] for pid in self.rendered["similarOrder"]]
        if scope == "closed":
            return [project for project in ordered if project["status"] == "closed"]
        return ordered

    def search(self, body: dict[str, Any]) -> dict[str, Any]:
        scope = self._in_scope(body)
        offset = int(body.get("offset") or 0)
        page = scope[offset : offset + PAGE_PROJECTS]
        types, disciplines = set(body.get("documentTypes") or []), set(body.get("disciplines") or [])
        hits = []
        for project in page:
            for document in project.get("documents") or []:
                tags = set(document.get("tags") or [])
                if (types and not types & tags) or (disciplines and not disciplines & tags):
                    continue
                score = _score(str(body.get("query") or ""), document)
                if score < 0.25:
                    continue
                hits.append(
                    {
                        "project": self._ref(project),
                        "documentId": document["documentId"],
                        "filename": document["filename"],
                        "title": document.get("title"),
                        "collection": project["collection"],
                        "page": document.get("page"),
                        "snippet": document["text"],
                        "score": score,
                        "tags": sorted(tags),
                        "uploadedAt": "2026-01-15T08:00:00.000Z",
                    }
                )
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        following = offset + len(page)
        return {
            "decisions": self._decisions(page, str(body.get("query") or "")),
            "hits": hits[: int(body.get("limit") or 10)],
            "projectsInScope": len(scope),
            "projectsSearched": len(page),
            "nextOffset": following if following < len(scope) else None,
            "statusKnown": True,
        }

    def _decisions(self, page: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
        """The page's recorded decisions sharing a word with the question, as the BFF's full-text search would."""
        found = []
        for project in page:
            for decision in project.get("decisions") or []:
                if _score(query, {"text": decision["content"]}) == 0:
                    continue
                found.append({"project": self._ref(project), "collection": project["collection"], **decision})
        return found[:6]

    def projects_listing(self, body: dict[str, Any]) -> dict[str, Any]:
        needle = _fold(str(body.get("query") or ""))

        def found(project: dict[str, Any]) -> bool:
            address = project.get("facts", {}).get("standort_adresse", "")
            if body.get("status") and project["status"] != body["status"]:
                return False
            return not needle or needle in _fold(f"{project['name']} {address}")

        matching = [project for project in [self.current, *self.projects.values()] if found(project)]
        listed = matching[: int(body.get("limit") or 10)]
        return {"projects": [self._listed(project) for project in listed], "total": len(matching), "statusKnown": True}

    def brief(self, body: dict[str, Any]) -> dict[str, Any] | None:
        project = self.projects.get(str(body.get("projectId") or ""))
        if project is None:
            return None
        return {
            "project": self._listed(project),
            "summary": project.get("summary"),
            "facts": self.rendered["briefs"].get(project["id"], ""),
        }


def _conversation_of(envelope: str | None) -> str | None:
    """The conversation a request's envelope names: which run asked, for the checks. Not verified: only read."""
    import base64

    if not envelope:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(envelope + "=" * (-len(envelope) % 4)).decode("utf-8"))
    except ValueError:
        return None
    conversation = payload.get("conversationId") if isinstance(payload, dict) else None
    return conversation if isinstance(conversation, str) else None


def lookups_served(log_path: Path, conversation_id: str) -> list[str]:
    """The cross-project lookups this fixture answered for one conversation, in order: `search`, `projects`, `brief`.

    What a turn READ, whoever asked for it: the model's own call, or the
    turn decision's round-0 prefetch, which no model call shows.
    """
    if not log_path.exists():
        return []
    served = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        path = str(entry.get("path") or "")
        if entry.get("served") and entry.get("conversation") == conversation_id and "/cross-project/" in path:
            served.append(path.rsplit("/", 1)[-1])
    return served


class FixtureBFF:
    """The fixture office behind a local HTTP server, on a free port, until :meth:`stop`."""

    def __init__(self, token: str, log_path: Path, office: FixtureOffice | None = None) -> None:
        self.office = office or FixtureOffice()
        self._offices = {self.office.scenario: self.office}
        self._scenario_of: dict[str, str] = {}
        self.token = token
        self.log_path = log_path
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> FixtureBFF:
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _log(self, entry: dict[str, Any]) -> None:
        with self._lock, self.log_path.open("a", encoding="utf-8") as sink:
            sink.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def assign(self, conversation_id: str, scenario: str) -> FixtureOffice:
        """Answer this conversation from a scenario's office: which project the chat sits in, which exist."""
        with self._lock:
            if scenario not in self._offices:
                self._offices[scenario] = FixtureOffice(scenario=scenario)
            self._scenario_of[conversation_id] = scenario
            return self._offices[scenario]

    def office_for(self, conversation_id: str | None) -> FixtureOffice:
        with self._lock:
            scenario = self._scenario_of.get(conversation_id or "")
            return self._offices.get(scenario or "", self.office)

    def _answer(self, path: str, body: dict[str, Any], office: FixtureOffice) -> tuple[int, dict[str, Any]] | None:
        if path == "/api/internal/turn-context":
            return 200, office.turn_context()
        if path == "/api/internal/cross-project/search":
            return 200, office.search(body)
        if path == "/api/internal/cross-project/projects":
            return 200, office.projects_listing(body)
        if path == "/api/internal/cross-project/brief":
            found = office.brief(body)
            return (200, found) if found is not None else (404, {"error": "Not found"})
        return None

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        bff = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:  # the run's log stays the agent's
                return

            def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    body = {}
                path = self.path.split("?", 1)[0]
                conversation = _conversation_of(self.headers.get("X-Grid-Request-Context"))
                trusted = self.headers.get("X-Grid-Internal-Token") == bff.token
                answer = bff._answer(path, body, bff.office_for(conversation)) if trusted else None
                bff._log({"path": path, "body": body, "served": answer is not None, "conversation": conversation})
                if answer is None:
                    # As unreachable as today's suite's BFF: no status line at all.
                    self.close_connection = True
                    return
                status, payload = answer
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST  # noqa: N815 - a GET to an unserved route is dropped like a POST

        return Handler
