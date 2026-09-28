"""The handful of replies the agent sends without a model writing them.

Each reaches the reader verbatim as an assistant message, so each is written in
the product's voice: German, formal address, one sentence on what happened and
one on what to do next — the same register as the plan-cancellation receipt in
``agents/piloti/conversation.py``. They live in one leaf module because two
places must agree on them: the nodes that send them, and the post-answer gate
(``stages/memory_reflection.py``) that must not reflect on, or offer follow-ups
under, a turn that produced one. Building that gate's prefix list from these
names is what stops a rewording from silently unhooking it.
"""

#: A turn that failed on our side. Retry-able and never an escalation.
GENERIC_ERROR_MESSAGE = (
    "Bei der Recherche zu Ihrer Frage ist ein Fehler aufgetreten. Bitte versuchen Sie es noch einmal."
)

#: A data-source tool was queried and nothing citable came back.
NO_SOURCES_MESSAGE = (
    "Ich habe die verfügbaren Quellen durchsucht, aber nichts gefunden, worauf sich "
    "eine Antwort auf diese Frage stützen ließe. Das kann vorübergehend sein – "
    "versuchen Sie es bitte noch einmal oder formulieren Sie die Frage um."
)

#: The same miss inside a scope the user set (this file, this shelf): a valid
#: empty answer, so the advice is to widen the scope rather than to retry.
SCOPED_NO_SOURCES_MESSAGE = (
    "Ich habe die verfügbaren Quellen durchsucht, aber nichts gefunden, worauf sich "
    "eine Antwort stützen ließe. Stellen Sie die Frage gern weiter gefasst, oder "
    "ohne sie auf eine einzelne Datei einzugrenzen."
)

#: Some search tools failed their pre-flight check. The tool names and the
#: missing keys go to the log, never to the reader.
TOOLS_UNAVAILABLE_MESSAGE = (
    "Einige Suchfunktionen stehen derzeit nicht zur Verfügung. Bitte wenden Sie sich "
    "an Ihre Administration oder versuchen Sie es später noch einmal."
)

#: The chat response when the turn produced no assistant message at all.
NO_RESPONSE_TEXT = "Es wurde keine Antwort erzeugt."

#: What the post-answer gate matches on: an answer that STARTS with one of
#: these is a non-answer, and neither memory reflection nor follow-up
#: suggestions run on it.
NON_ANSWER_PREFIXES: tuple[str, ...] = (
    NO_RESPONSE_TEXT,
    GENERIC_ERROR_MESSAGE,
    NO_SOURCES_MESSAGE,
    SCOPED_NO_SOURCES_MESSAGE,
    TOOLS_UNAVAILABLE_MESSAGE,
)
