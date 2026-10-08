"""Turning a raw transcript into text a member would have typed.

The transcription model brings the punctuation and capitalisation. Whether it
also drops hesitation sounds is up to the model and, on OpenRouter, to a prompt
the provider may or may not honour (unverified, see
``docs/architecture/voice-dictation.md``). This module is the part that does not
depend on either: it removes the fillers a model left in, deterministically, so
the composer never receives "äh, also ähm".

Two rules shape the word list:

* **Only sounds that are never words.** ``äh``, ``ähm``, ``öhm``, ``uh``,
  ``uhm``, ``erm``, ``hmm``. ``eh`` stays (German "eh schon"), ``er`` stays
  (German "he"), ``mhm`` stays (it means yes).
* **"um" is a German preposition**, so it is removed only where the preposition
  cannot stand: as a sentence's first word followed by a comma or an ellipsis
  ("Um, I think …"), or as an aside between commas ("and, um, the"). "Es geht um
  die Fluchtwege" and "um, sagen wir, acht Uhr" keep it. ``umm`` with two or
  more m is never German and always goes.

Audio-event tags go too: ElevenLabs Scribe writes ``[pause]`` for room noise
(seen in a live test), and a bracketed note is never something a member meant
to type into a chat. A transcript that is only a known silence hallucination
(Whisper-class models write subtitle credits over silence) becomes empty, so
silence inserts nothing.
"""

from __future__ import annotations

import re

#: Hesitation sounds that are never a word in German or English, any case.
_FILLER = r"(?:ä+h+m*|ö+h+m*|e+h+m+|u+h+m*|e+r+m+|h+m{2,}|u+m{2,})"
#: What may trail a filler and goes with it: a comma, an ellipsis, a dash.
_TRAIL = r"(?:\s*(?:,|…|\.{3}|\s[-–]))?"
#: A sentence start: the text's start, or whitespace after closing punctuation.
_SENTENCE_START = r"(?:^|(?<=[.!?…])\s+)"

_FILLER_RE = re.compile(
    rf"(?P<lead>{_SENTENCE_START})?(?P<comma>,\s*)?(?<![\w-]){_FILLER}(?![\w-]){_TRAIL}\s*(?P<next>\w)?",
    re.IGNORECASE,
)
#: "Um," opening a sentence. The German preposition never takes a comma there.
_UM_OPENING_RE = re.compile(rf"(?P<lead>{_SENTENCE_START})um(?:,|…|\.{{3}})\s*(?P<next>\w)?", re.IGNORECASE)
#: ", um," as an aside. Both commas are required, so "um, sagen wir" keeps it.
_UM_ASIDE_RE = re.compile(r"(?P<comma>,\s*)(?<![\w-])um\s*,\s*(?P<next>\w)?", re.IGNORECASE)

#: Words a German comma stands before. A filler set off by commas ("ich glaube,
#: äh, dass") keeps the first comma when one of these follows; anywhere else the
#: commas belonged to the filler ("I think, uh, that" reads "I think that").
_KEEP_COMMA_BEFORE = frozenset(
    {"dass", "ob", "weil", "wenn", "als", "obwohl", "damit", "sodass", "bevor", "nachdem", "während", "falls"}
    | {"sondern", "aber", "denn", "welche", "welcher", "welches", "wie", "wo", "was", "wer"}
)

#: An audio-event tag. Any short ``[...]`` without digits (``[pause]``, ``[MUSIC]``):
#: nobody dictates square brackets. In round brackets only the known event
#: words, because "(Statik)" may be an aside the member meant.
_AUDIO_EVENT_RE = re.compile(
    r"\[[^\[\]\d]{1,30}\]"
    r"|\((?:laughs?|laughter|coughs?|music|applause|silence|pause|noise|inaudible|lacht|hustet|musik|stille|pause)\)",
    re.IGNORECASE,
)

#: Phrases Whisper-class models write over silence, matched against the whole
#: transcript only, lowercased and stripped of punctuation.
_SILENCE_HALLUCINATIONS = (
    "untertitel im auftrag des zdf",
    "untertitel der amaraorg-community",
    "untertitelung des zdf",
    "untertitelung aufgrund der amaraorg-community",
    "thanks for watching",
    "thank you for watching",
)


def _next_word(match: re.Match[str]) -> str:
    """The whole word whose first letter the match consumed, lowercased."""
    word = re.match(r"\w+", match.string[match.start("next") :])
    return word.group(0).lower() if word else ""


def _drop_filler(match: re.Match[str]) -> str:
    """The text a filler leaves behind: nothing, and a capital where it opened a sentence."""
    groups = match.groupdict()
    following = groups.get("next") or ""
    if groups.get("lead") is not None:
        return groups["lead"] + following.upper()
    if not following:
        return ""
    if groups.get("comma") and _next_word(match) in _KEEP_COMMA_BEFORE:
        return f", {following}"
    return f" {following}"


def _tidy(text: str) -> str:
    """Repair the punctuation a removed filler leaves: doubled commas, a comma before a full stop."""
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    text = re.sub(r",(?:\s*,)+", ",", text)
    text = re.sub(r",\s*([.!?])", r"\1", text)
    text = re.sub(r"(^|[.!?]\s+),\s*", r"\1", text)
    return text.strip(" \t,")


def is_silence_hallucination(text: str) -> bool:
    """Whether the whole transcript is a known silence hallucination."""
    normalized = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return any(normalized.startswith(phrase) for phrase in _SILENCE_HALLUCINATIONS) and len(normalized) < 80


def clean_transcript(raw: str | None) -> str:
    """The transcript without fillers and silence hallucinations; ``""`` when nothing was said."""
    text = _AUDIO_EVENT_RE.sub(" ", raw or "").strip()
    if not text or is_silence_hallucination(text):
        return ""
    # A match consumes the first letter after it, so a filler straight after
    # another ("Ähm... hmm") is found on the next pass. Two passes cover any
    # run a person produces; the bound keeps a pathological input cheap.
    for _ in range(3):
        before = text
        for pattern in (_FILLER_RE, _UM_OPENING_RE, _UM_ASIDE_RE):
            text = pattern.sub(_drop_filler, text)
        if text == before:
            break
    text = _tidy(text)
    # A transcript of nothing but fillers ("Äh … ähm.") leaves punctuation only.
    return text if re.search(r"\w", text) else ""
