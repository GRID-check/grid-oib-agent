"""``canvas``: Piloti's hands on a document, as a NAT function group.

Nine tools, the way a person works a document on the review canvas: ``look``
at a page or a box on it, see who is in the ``room`` and where, ``point`` and
``highlight`` to show what is meant, read the ``marks``, set a ``mark`` (a
proposal a person takes over, or open when the person asked for exactly that
mark), ``update`` or ``delete`` one when the person asks, and ``reply`` in a
mark's thread. The model calls them as ``canvas__look`` and so on; one group,
because they share the client,
the target resolution and the restricted-folder rule, and because NAT can serve
a function group over MCP as it stands, so a second client never means a second
implementation (ADR-0055).

## Which document, and as whom

Every tool takes an optional ``document`` (a file name from the inventory, or
an id) and otherwise acts on the document open on the canvas, then on the
conversation's subject (``target.py``). The BFF checks the document against the
asker's own access and the turn's signed scope, and acts as the person the
signed envelope names (echo, never sign: ``tools/AGENTS.md``). A thread question
is answered when the model calls ``reply``, which the prompt asks it to do; when
it does not, the turn's answer goes into the thread once the turn has ended
(``aiq_agent.turn.annotation_reply``), so ``reply``, ``update`` with its note and
``delete`` each note the mark they spoke in.

## What everyone sees

``mark``, ``update``, ``delete``, ``reply``, ``highlight`` and a labelled
``point`` are read by everyone who opens the document, so each passes
``policy.shared_write_refusal`` first. ``point`` and ``highlight`` are
ephemeral; the turn harness takes them down when the answer is out
(``presence.py``). ``mark``, ``update``, ``delete`` and ``reply`` put what the
BFF confirmed on the turn's ``canvas_activity`` card (``cards.py``).

## Parity, with light reporting

What the person asks for, Piloti does under that person's rights, through the
same service a person's PATCH runs (``lib/annotations/agent.ts``): set a mark
open, resolve, reopen, dismiss, take over, assign, date, reword, delete one
the person set. Each change posts the model's ``note`` as Piloti's reply in the
mark's thread, and the card lists it with an undo. Findings of its own stay
proposals.

Parity is the office's choice: with the organization switch ``piloti-acts``
off (the default), the BFF refuses ``create``, ``update`` and ``delete`` with
``piloti-acts-off``, and the result tells the model to propose the mark, or
that the person makes the change themselves (``calls.refusal_for``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pydantic import Field

from aiq_agent.turn.annotation_reply import note_thread_post
from nat.plugin_api import Builder
from nat.plugin_api import FunctionGroup
from nat.plugin_api import FunctionGroupBaseConfig
from nat.plugin_api import register_function_group

from .calls import Refused
from .calls import call
from .calls import document_of
from .calls import envelope
from .calls import observe
from .cards import record_canvas_activity
from .look import look_at
from .marks import MAX_PROPOSALS_PER_CALL
from .marks import AnnotationProposal
from .marks import annotation_entry
from .marks import annotation_number
from .marks import changed_item
from .marks import create_payload
from .marks import created_items
from .marks import deleted_item
from .marks import marks_observation
from .marks import propose_payload
from .marks import proposed_items
from .marks import render_created
from .marks import render_deleted
from .marks import render_list
from .marks import render_proposed
from .marks import render_replied
from .marks import render_updated
from .marks import replied_item
from .marks import reply_body
from .marks import update_payload
from .policy import shared_write_refusal
from .presence import note_presence
from .presence import show_reading
from .room import highlight_payload
from .room import point_payload
from .room import render_room
from .room import room_observation
from .target import Target
from .target import Unresolved
from .target import is_uuid
from .target import resolve_target

logger = logging.getLogger(__name__)

#: The instance name the config gives the group: the model sees ``canvas__<tool>``.
GROUP = "canvas"

_DOCUMENT = (
    "`document` (optional): der Dateiname aus der Übersicht oder die id; ohne ihn das im Canvas geöffnete "
    "Dokument, sonst das Dokument dieses Chats."
)
_FRAME = "Orte als Anteil der Seite, wie sie gezeigt wird: 0 bis 1, Ursprung oben links, keine Pixel."

DESCRIPTIONS = {
    "look": (
        "Zeigt dir eine Seite eines Dokuments als Bild, mit `region=[x, y, w, h]` nur diesen Ausschnitt, schärfer. "
        "Sieh hin, bevor du etwas über eine Zeichnung sagst, eine Stelle zeigst oder eine Anmerkung setzt: Wo "
        "etwas liegt („beim Treppenhaus“), liest du am Bild ab, nie aus dem Text. "
        f"{_FRAME} {_DOCUMENT}"
    ),
    "room": (
        "Wer das Dokument gerade offen hat: Seite und Ausschnitt jeder Person, welche Anmerkung sie ausgewählt "
        "hat, welchen Rahmen sie gerade aufzieht, und wie viele Anmerkungen offen sind. Nimm es, wenn „hier“, "
        f"„das“ oder „diese Stelle“ nicht schon durch den Fokusbereich geklärt ist. {_DOCUMENT}"
    ),
    "point": (
        "Bewegt deinen Zeiger für alle im Dokument an `page`, `x`, `y`, mit kurzem `label` (höchstens 80 "
        f"Zeichen). Verschwindet, wenn deine Antwort fertig ist. {_FRAME} {_DOCUMENT}"
    ),
    "highlight": (
        "Zeigt allen im Dokument einen Rahmen `page`, `x`, `y`, `w`, `h` mit `label`, z. B. „Hier: Fluchtweg "
        "1,10 m“. Für das, worauf deine Antwort sich bezieht; verschwindet, wenn sie fertig ist. Vorher mit "
        f"`look` hinsehen. {_FRAME} {_DOCUMENT}"
    ),
    "marks": (
        "Liest die Anmerkungen eines Dokuments mit Nummer, Seite, Art, Status, Text, Grundlage, Zuständigkeit, "
        "Frist und Antworten. Vor einem Protokoll, einer Antwort im Verlauf und vor `mark` lesen, damit nichts "
        f"doppelt markiert wird. {_DOCUMENT}"
    ),
    "mark": (
        "Setzt `proposals` als VORSCHLÄGE von Piloti; nichts davon gilt, bis eine Person den Vorschlag im Dokument "
        "übernimmt oder verwirft. Sag nie, ein Mangel sei eingetragen. `open=true` nur, wenn die Person genau diese "
        "Anmerkung zu setzen verlangt (dann gleich offen, in ihrem Namen; lässt das Büro Piloti nur vorschlagen, wird "
        "das abgelehnt, dann ohne `open`); eigene Befunde, auch einer erbetenen Durchsicht, bleiben Vorschläge. "
        "Vorher mit `look` die Seite ansehen und die Stelle dort abschätzen. Je Vorschlag: `page` (ab 1); `shape` "
        "`region` (bevorzugt: ein enger Rahmen "
        "um das Bauteil) oder `point`; `x`/`y` die linke obere Ecke, bei `region` dazu `w`/`h` (x+w und y+h "
        "höchstens 1); `kind` `hint`, `question` oder `defect`; `body` im Deutsch des Büros, konkret und kurz "
        "(höchstens 2000 Zeichen); `basis` mit der Fundstelle, wenn der Befund auf einer Norm beruht. Höchstens "
        f"{MAX_PROPOSALS_PER_CALL} pro Aufruf, das Wichtigste zuerst. Die Datei heißt Dokument oder Fassung, nie "
        f"Plan. {_FRAME} {_DOCUMENT}"
    ),
    "update": (
        "Ändert die Anmerkung `annotation` (Nummer oder id) im Namen der Person, nur wenn sie diese Änderung an "
        "dieser Anmerkung verlangt. Nur Geändertes angeben: `status` `open` (übernehmen, wieder öffnen), "
        "`resolved` oder `dismissed` (Vorschlag verwerfen); `assignee` (Name); `due_on` (JJJJ-MM-TT); `kind`; "
        "`body`; `-` leert `assignee`/`due_on`. `note` (Pflicht): ein Satz, was du getan hast, z. B. „Erledigt: "
        "Lichte Breite im Schnitt B-B mit 1,25 m kotiert.“; steht als Antwort von Piloti im Verlauf. Nenne in "
        "der Antwort die Nummer. Lässt das Büro Piloti nur vorschlagen, wird es abgelehnt: dann ändert die Person es "
        f"selbst. {_DOCUMENT}"
    ),
    "delete": (
        "Löscht die Anmerkung `annotation` (Nummer oder id) samt Verlauf, endgültig. Nur auf ausdrückliche Bitte, "
        "und nur Anmerkungen, die die Person selbst gesetzt hat; lässt das Büro Piloti nur vorschlagen, löscht sie "
        f"selbst. {_DOCUMENT}"
    ),
    "reply": (
        "Schreibt `body` als Antwort von Piloti in den Verlauf der Anmerkung `annotation` (ihre id oder Nummer). "
        "Alle, die das Dokument öffnen, lesen sie sofort: kurz, für sich verständlich, ohne Quellenmarken wie "
        "[1], höchstens 2000 Zeichen. Nimm es, wenn du im Verlauf gefragt wurdest oder darum gebeten wirst. "
        f"{_DOCUMENT}"
    ),
}


class DocumentCanvasConfig(FunctionGroupBaseConfig, name="document_canvas"):
    """Configuration for the ``canvas`` function group."""

    max_dim: int = Field(default=2048, description="Long edge (px) of what `look` renders.")
    timeout: float = Field(default=30.0, description="Render timeout of `look`, in seconds.")


async def _target(document: str) -> tuple[Target, Any]:
    signed = envelope()
    target = await resolve_target(document, signed)
    if isinstance(target, Unresolved):
        raise Refused(target.message, "unresolved_document")
    return target, signed


def _shared_write_allowed(step: str) -> None:
    if (refusal := shared_write_refusal()) is not None:
        observe(step, {"step": step}, {"refused": "restricted"})
        raise Refused(refusal, "restricted")


async def _refusing(step: str, run: Any) -> Any:
    """Run one tool body; a :class:`Refused` becomes its sentence, recorded by its code."""
    try:
        return await run()
    except Refused as refused:
        if refused.code != "restricted":
            observe(step, {"step": step}, {"refused": refused.code})
        return refused.message


async def run_look(
    page: int = 1, region: list[float] | None = None, document: str = "", *, limits: Any = None
) -> list[dict] | str:
    """Look at a page of the document, or at the box ``region`` on it."""

    async def body() -> list[dict] | str:
        target, signed = await _target(document)
        # Telling the room and reading are independent: the glow costs the look no round trip.
        _, result = await asyncio.gather(
            show_reading(target.body(), target.document_id, signed, page, region),
            look_at(target, signed, page=page, region=region, limits=limits),
        )
        observe("look", {"page": page, "region": region is not None}, {"viewed": isinstance(result, list)})
        return result

    return await _refusing("look", body)


async def run_room(document: str = "") -> str:
    """Who has the document open, and where."""

    async def body() -> str:
        target, signed = await _target(document)
        result = await call({"op": "room"}, target, signed)
        observe("room", {"step": "room"}, room_observation(result))
        return render_room(result)

    return await _refusing("room", body)


async def run_point(page: int, x: float, y: float, label: str = "", document: str = "") -> str:
    """Move Piloti's pointer, for everyone in the document."""

    async def body() -> str:
        payload = point_payload(page, x, y, label)
        if "label" in payload:
            _shared_write_allowed("point")
        target, signed = await _target(document)
        await call(payload, target, signed)
        note_presence(target.document_id)
        observe("point", {"page": payload["page"], "label": "label" in payload}, {"ok": True})
        return (
            f"Dein Zeiger steht auf S. {payload['page']}, für alle im Dokument sichtbar, bis deine Antwort fertig ist."
        )

    return await _refusing("point", body)


async def run_highlight(page: int, x: float, y: float, w: float, h: float, label: str, document: str = "") -> str:
    """Show everyone in the document a labelled box."""

    async def body() -> str:
        payload = highlight_payload(page, x, y, w, h, label)
        _shared_write_allowed("highlight")
        target, signed = await _target(document)
        await call(payload, target, signed)
        note_presence(target.document_id)
        observe("highlight", {"page": payload["page"]}, {"ok": True})
        return (
            f"Der Rahmen „{payload['label']}“ auf S. {payload['page']} ist für alle im Dokument sichtbar, bis deine "
            "Antwort fertig ist."
        )

    return await _refusing("highlight", body)


async def run_marks(document: str = "") -> str:
    """Read the marks on the document."""

    async def body() -> str:
        target, signed = await _target(document)
        result = await call({"op": "list"}, target, signed)
        observe("marks", {"step": "marks"}, marks_observation("list", result))
        return render_list(result)

    return await _refusing("marks", body)


async def run_mark(proposals: list[AnnotationProposal] | None = None, document: str = "", open: bool = False) -> str:  # noqa: A002 - the model's word
    """Propose marks on the document, or set them open when the person asked for exactly these."""

    async def body() -> str:
        items = list(proposals or [])
        payload = create_payload(items) if open else propose_payload(items)
        _shared_write_allowed("mark")
        target, signed = await _target(document)
        result = await call(payload, target, signed)
        operation = "create" if open else "propose"
        made = created_items(result) if open else proposed_items(result)
        record_canvas_activity(document_of(result, target), made)
        count = len(payload["marks" if open else "proposals"])
        observe("mark", {"proposals": count, "open": open}, marks_observation(operation, result))
        return render_created(result) if open else render_proposed(result)

    return await _refusing("mark", body)


async def _annotation_ref(annotation: str, target: Target, signed: Any, tool: str) -> tuple[str, str | None]:
    """The id to act on, and the status read with it: as given (no status), or looked up by its number."""
    ref = (annotation or "").strip()
    if is_uuid(ref):
        return ref, None
    number = annotation_number(ref)
    if number is None:
        raise Refused(f"Fehler: `{tool}` braucht `annotation`: die id oder die Nummer aus `marks`.")
    entry = annotation_entry(await call({"op": "list"}, target, signed), number)
    status = entry.get("status")
    return entry["id"], status if isinstance(status, str) else None


async def run_update(
    annotation: str,
    note: str,
    status: str = "",
    assignee: str = "",
    due_on: str = "",
    kind: str = "",
    body: str = "",
    document: str = "",
) -> str:
    """Change a mark the person named, in their name, and say so in its thread."""

    async def run() -> str:
        change = update_payload(status=status, assignee=assignee, due_on=due_on, kind=kind, body=body, note=note)
        _shared_write_allowed("update")
        target, signed = await _target(document)
        annotation_id, seen = await _annotation_ref(annotation, target, signed, "update")
        # A mark looked up by its number is changed only if it still stands as it was read.
        guard = {"expectedStatus": seen} if seen else {}
        result = await call({"op": "update", "annotationId": annotation_id, **change, **guard}, target, signed)
        if result.get("noted"):
            record_canvas_activity(document_of(result, target), [changed_item(result, change["note"])])
            note_thread_post(annotation_id)  # the note is Piloti's reply in that thread
        observe("update", {"fields": sorted(set(change) - {"note"})}, marks_observation("update", result))
        return render_updated(result)

    return await _refusing("update", run)


async def run_delete(annotation: str, document: str = "") -> str:
    """Delete a mark the person set, at their explicit request."""

    async def run() -> str:
        _shared_write_allowed("delete")
        target, signed = await _target(document)
        annotation_id, _ = await _annotation_ref(annotation, target, signed, "delete")
        result = await call({"op": "delete", "annotationId": annotation_id}, target, signed)
        record_canvas_activity(document_of(result, target), [deleted_item(result)])
        note_thread_post(annotation_id)  # no thread is left to answer in
        observe("delete", {"step": "delete"}, marks_observation("delete", result))
        return render_deleted(result)

    return await _refusing("delete", run)


async def run_reply(annotation: str, body: str, document: str = "") -> str:
    """Answer in a mark's thread."""

    async def run() -> str:
        text = reply_body(body)
        _shared_write_allowed("reply")
        target, signed = await _target(document)
        annotation_id, _ = await _annotation_ref(annotation, target, signed, "reply")
        result = await call({"op": "reply", "annotationId": annotation_id, "body": text}, target, signed)
        record_canvas_activity(document_of(result, target), [replied_item(result, text)])
        note_thread_post(annotation_id)
        observe("reply", {"step": "reply"}, marks_observation("reply", result))
        return render_replied(result)

    return await _refusing("reply", run)


@register_function_group(config_type=DocumentCanvasConfig)
async def document_canvas(config: DocumentCanvasConfig, _builder: Builder):
    """The canvas tools, as one group."""
    from knowledge_layer.view_image import ViewLimits

    limits = ViewLimits(max_dim=config.max_dim, timeout=config.timeout)

    async def look(page: int = 1, region: list[float] | None = None, document: str = "") -> list[dict] | str:
        return await run_look(page, region, document, limits=limits)

    group = FunctionGroup(config=config)
    for name, fn in (
        ("look", look),
        ("room", run_room),
        ("point", run_point),
        ("highlight", run_highlight),
        ("marks", run_marks),
        ("mark", run_mark),
        ("update", run_update),
        ("delete", run_delete),
        ("reply", run_reply),
    ):
        group.add_function(name, fn, description=DESCRIPTIONS[name])
    yield group
