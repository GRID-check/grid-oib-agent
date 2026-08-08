"""Scrub presigned object-storage URLs out of log records, at the sink.

## Why this is a filter and not a rule

A presigned S3 URL is a live bearer credential: anyone holding the string can
fetch (or overwrite) the object until it expires, with no user, org or IP
binding. It also carries the tenant path — org, project and document ids — in
plain sight.

The previous defence was a convention: *never log ``file_ref``*. Conventions
hold at the call sites someone checked. They do not hold at the call sites that
arrive later, and they never held at the ones that log an exception rather than a
URL — ``str(httpx.HTTPStatusError)`` embeds the full request URL, so
``logger.error("failed: %s", e)`` leaked the credential without ever naming it,
and ``exc_info=True`` put it in the traceback too.

A leak here produces no symptom, so the number of holes only grows. This module
moves the guarantee from "everyone remembers" to "the sink refuses": install the
filter on the handlers and no call site has to be careful, including the ones
nobody has written yet.

It is a floor, not a licence. Call sites should still log the document id and the
byte count rather than the URL — a filter can only catch shapes it knows, and the
cheapest URL to keep out of a log is the one that was never put there.

## What counts as presigned

Any ``http(s)://`` run whose query string carries a SigV4 or SigV2 signature
parameter. The WHOLE url is replaced rather than just the signature value,
because a half-redacted URL still publishes the tenant path, and because a
partial scrub invites reasoning about which half was sensitive.

Lives beside :func:`aiq_agent.common.db_utils.redact_db_url` for the same reason
that one exists: redaction belongs in one place per secret shape, importable by
every tier (``aiq_api`` already imports ``redact_db_url`` from here).
"""

from __future__ import annotations

import logging
import re
from typing import Any

__all__ = [
    "PRESIGNED_REDACTED",
    "PresignedUrlFilter",
    "install_presigned_url_scrubbing",
    "scrub_presigned_urls",
]

#: What a redacted URL becomes. Deliberately not an empty string: a log line that
#: reads "failed to download " leaves the reader wondering whether the URL was
#: missing or removed.
PRESIGNED_REDACTED = "<presigned-url-redacted>"

#: Query parameters that mark a URL as a signed, self-authorising request.
#: SigV4 (``X-Amz-Signature`` and friends) and SigV2 (``Signature``,
#: ``AWSAccessKeyId``), matched case-insensitively because SeaweedFS, MinIO and
#: AWS do not agree on casing.
_SIGNATURE_PARAMS = (
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "awsaccesskeyid",
    "signature",
)

#: A URL run. Stops at whitespace, quotes, and the characters that commonly
#: close a URL inside prose or a repr — so a URL at the end of a sentence does
#: not swallow the sentence.
_URL_RE = re.compile(r"https?://[^\s\"'<>\\]+")


def _is_signed(url: str) -> bool:
    query = url.partition("?")[2].lower()
    if not query:
        return False
    # Parameter NAMES only: matching anywhere in the query would also fire on a
    # key that happens to contain the word "signature", which is a filename a
    # tenant can choose.
    return any(f"{name}=" in query for name in _SIGNATURE_PARAMS)


def _strip_trailing_punctuation(url: str) -> tuple[str, str]:
    """Split a matched run into the URL and any prose punctuation it absorbed."""
    trailing = ""
    while url and url[-1] in ".,;:!?)]}":
        trailing = url[-1] + trailing
        url = url[:-1]
    return url, trailing


def scrub_presigned_urls(text: str) -> str:
    """Replace every signed object-storage URL in ``text`` with a marker.

    Unsigned URLs pass through untouched: a collector endpoint or a docs link in
    a log line is not a credential, and redacting it would make the logs less
    useful for no gain.
    """
    if "http" not in text:
        return text

    def replace(match: re.Match[str]) -> str:
        url, trailing = _strip_trailing_punctuation(match.group(0))
        return (PRESIGNED_REDACTED + trailing) if _is_signed(url) else match.group(0)

    return _URL_RE.sub(replace, text)


def _scrub_value(value: Any) -> Any:
    return scrub_presigned_urls(value) if isinstance(value, str) else value


class PresignedUrlFilter(logging.Filter):
    """Rewrites records so no handler downstream can emit a presigned URL.

    Attached to HANDLERS rather than to loggers, and that is load-bearing: a
    filter on a logger only sees records created by that logger, not the ones
    propagated up from its children, so a logger-level filter would miss almost
    everything. A handler sees every record that reaches it.

    Three fields carry text: the format string, its arguments, and the formatted
    exception. ``record.msg`` and ``record.args`` are scrubbed in place. For the
    exception, the traceback is rendered and scrubbed here rather than left to
    the formatter, because ``str(httpx.HTTPStatusError)`` is exactly where the
    URLs that nobody logged on purpose live.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = scrub_presigned_urls(record.msg)

        if isinstance(record.args, dict):
            record.args = {key: _scrub_value(value) for key, value in record.args.items()}
        elif isinstance(record.args, tuple):
            record.args = tuple(_scrub_value(value) for value in record.args)

        if record.exc_info and record.exc_info[0] is not None:
            # Render once, scrub, and hand the formatter a plain string. Setting
            # `exc_text` is what `logging.Formatter` consults before formatting
            # `exc_info` itself, so the scrubbed version is the one emitted.
            if not record.exc_text:
                import traceback

                record.exc_text = "".join(traceback.format_exception(*record.exc_info))
            record.exc_text = scrub_presigned_urls(record.exc_text)

        # Never drops a record. Redaction that silences a log line trades one
        # invisible failure for another.
        return True


def install_presigned_url_scrubbing(logger: logging.Logger | None = None) -> None:
    """Attach the filter to every handler on ``logger`` (root by default).

    Idempotent: re-running after a handler is added covers the new one and
    leaves the rest alone, which is what makes it safe to call from more than
    one entry point.
    """
    target = logger if logger is not None else logging.getLogger()
    for handler in target.handlers:
        if not any(isinstance(existing, PresignedUrlFilter) for existing in handler.filters):
            handler.addFilter(PresignedUrlFilter())
