"""The two precedent checks a pattern cannot read, asked of a model.

„The references hold nothing comparable" and „that precedent was decided under
an older edition" are meanings, not words. A phrase list reads them wrong both
ways: it misses „kein dokumentierter Fall", and it takes a cited precedent's own
caveat („keine Vorgabe für Ihr Projekt") for „nothing found". Each phrase added
to fix one miss makes the next false pass likelier, which tunes the instrument
to the answers it grades.

So the judge gets the question, the answer and one yes/no question about
meaning, in English, whatever language the answer is in. It is checked the
way the patterns were (`tests/test_precedent_eval.py` holds the fake; the
validation against real answers is in the testing doc). A judge that cannot
answer returns None and the check is left out of the run, never guessed.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from aiq_agent.common.openrouter import PLATFORM_FIXED

JUDGE_MODEL = os.environ.get("SUITE_JUDGE_MODEL", "openai/gpt-6-luna")
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

#: One question per check, about what the answer MEANS. Neither names a phrase.
RUBRICS: dict[str, str] = {
    "says_none": (
        "Does the ANSWER tell the reader that the office's past or reference projects hold nothing "
        "comparable to what the QUESTION asks about (no such project, no documented solution or case)? "
        "Answer no when the answer presents a past project's solution as relevant, and no when its only "
        "negative statement is a caveat that a precedent it cites is not binding."
    ),
    "caveat": (
        "Does the ANSWER warn that a precedent it relies on was decided under an earlier edition of a rule, "
        "another law or another Bundesland, or that the rules may have changed since, so it must be checked "
        "before it is reused?"
    ),
}

_SYSTEM = (
    "You grade one answer of a building-law assistant against one yes/no question. "
    'Reply with exactly one word: "yes" or "no".'
)


def _api_key() -> str | None:
    return os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY") or None


def available() -> bool:
    """Whether a judge can be asked: a key is set."""
    return _api_key() is not None


def ask(kind: str, question: str, answer: str, *, timeout: float = 60.0) -> bool | None:
    """The judge's yes or no on one check, or None when it could not answer."""
    key = _api_key()
    if key is None or kind not in RUBRICS or not answer.strip():
        return None
    # Through the OpenRouter seam like every model call: pinned to zero data retention.
    body = PLATFORM_FIXED.apply(
        {
            "model": JUDGE_MODEL,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": f"{RUBRICS[kind]}\n\nQUESTION:\n{question}\n\nANSWER:\n{answer}"},
            ],
        }
    )
    request = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            reply = json.loads(response.read().decode("utf-8"))
        text = str(reply["choices"][0]["message"]["content"]).strip().casefold()
    except (urllib.error.URLError, TimeoutError, KeyError, IndexError, ValueError):
        return None
    if text.startswith("yes"):
        return True
    if text.startswith("no"):
        return False
    return None
