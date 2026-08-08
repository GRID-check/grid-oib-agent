"""The presigned-URL sink filter.

A presigned S3 URL is a live bearer credential to a tenant's object plus the
tenant path (org / project / document ids). The convention "never log the URL"
held at the call sites someone checked; it never held where the URL arrived
inside an exception. `str(httpx.HTTPStatusError)` embeds the request URL, so
`logger.error("failed: %s", e)` leaked the credential without naming it.

These tests pin the guarantee at the sink: whatever a call site does, a handler
cannot emit a signed URL. The asymmetry that matters is that a false negative is
a leaked credential in a log aggregator, while a false positive is a slightly
less useful log line — so the filter errs toward redacting the whole URL.
"""

from __future__ import annotations

import logging

import pytest

from aiq_agent.common.log_redaction import PRESIGNED_REDACTED
from aiq_agent.common.log_redaction import PresignedUrlFilter
from aiq_agent.common.log_redaction import install_presigned_url_scrubbing
from aiq_agent.common.log_redaction import scrub_presigned_urls

SIGNED = (
    "http://seaweedfs:8333/grid-documents/org/org_01H8/project/p1/doc/report.pdf"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Credential=grid%2F20260808%2Fus-east-1%2Fs3%2Faws4_request"
    "&X-Amz-Date=20260808T120000Z&X-Amz-Expires=600"
    "&X-Amz-Signature=deadbeefcafebabe1234567890abcdef"
)


class TestScrub:
    def test_replaces_the_whole_signed_url_not_just_the_signature(self) -> None:
        scrubbed = scrub_presigned_urls(f"GET {SIGNED} failed")

        assert PRESIGNED_REDACTED in scrubbed
        # The signature is the credential; the path is the tenant. Neither
        # survives, because a half-redacted URL still publishes one of them.
        assert "deadbeefcafebabe" not in scrubbed
        assert "org_01H8" not in scrubbed
        assert scrubbed == f"GET {PRESIGNED_REDACTED} failed"

    @pytest.mark.parametrize(
        "param",
        [
            "X-Amz-Signature=abc",
            "x-amz-signature=abc",
            "X-Amz-Credential=grid%2F20260808",
            "X-Amz-Security-Token=tok",
            "AWSAccessKeyId=AKIA&Signature=abc",
        ],
    )
    def test_recognises_every_signing_scheme_and_casing(self, param: str) -> None:
        assert PRESIGNED_REDACTED in scrub_presigned_urls(f"http://host/bucket/key?{param}")

    @pytest.mark.parametrize(
        "text",
        [
            # An unsigned URL is not a credential. Redacting it would cost the
            # operator the one useful field and buy nothing.
            "posting to http://otel-collector:4318/v1/traces",
            "see https://docs.example.test/storage#quota",
            "http://seaweedfs:8333/grid-documents/org/o1/doc.pdf",
            "no url at all",
            "",
        ],
    )
    def test_leaves_unsigned_text_alone(self, text: str) -> None:
        assert scrub_presigned_urls(text) == text

    def test_does_not_fire_on_a_filename_containing_the_word_signature(self) -> None:
        # A tenant chooses its filenames. Matching the word anywhere in the
        # query would let one of them trigger redaction of an unsigned URL.
        url = "http://seaweedfs:8333/grid-documents/org/o1/signature-page.pdf?response-type=inline"
        assert scrub_presigned_urls(url) == url

    def test_keeps_trailing_punctuation_outside_the_marker(self) -> None:
        assert scrub_presigned_urls(f"failed on {SIGNED}.") == f"failed on {PRESIGNED_REDACTED}."

    def test_scrubs_each_of_several_urls(self) -> None:
        scrubbed = scrub_presigned_urls(f"{SIGNED} then {SIGNED}")
        assert scrubbed == f"{PRESIGNED_REDACTED} then {PRESIGNED_REDACTED}"


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


@pytest.fixture()
def sink() -> _Capture:
    handler = _Capture()
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(PresignedUrlFilter())
    logger = logging.getLogger("test.log_redaction")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    return handler


class TestFilter:
    def test_scrubs_a_url_passed_as_an_argument(self, sink: _Capture) -> None:
        logging.getLogger("test.log_redaction").info("downloading %s", SIGNED)
        assert sink.lines == [f"downloading {PRESIGNED_REDACTED}"]

    def test_scrubs_a_url_interpolated_into_the_message(self, sink: _Capture) -> None:
        logging.getLogger("test.log_redaction").info(f"downloading {SIGNED}")
        assert sink.lines == [f"downloading {PRESIGNED_REDACTED}"]

    def test_scrubs_a_url_in_a_dict_argument(self, sink: _Capture) -> None:
        logging.getLogger("test.log_redaction").info("%(url)s failed", {"url": SIGNED})
        assert sink.lines == [f"{PRESIGNED_REDACTED} failed"]

    # The leak that actually happened: nobody logged the URL, the exception did.
    def test_scrubs_the_traceback_of_an_exception_carrying_the_url(self, sink: _Capture) -> None:
        try:
            raise RuntimeError(f"Client error '403 Forbidden' for url '{SIGNED}'")
        except RuntimeError:
            logging.getLogger("test.log_redaction").exception("ingest failed")

        emitted = "\n".join(sink.lines)
        assert "deadbeefcafebabe" not in emitted
        assert "org_01H8" not in emitted
        assert PRESIGNED_REDACTED in emitted

    def test_never_drops_a_record(self, sink: _Capture) -> None:
        # Redaction that silences a line trades one invisible failure for
        # another; the filter always returns True.
        logging.getLogger("test.log_redaction").warning("something happened")
        assert sink.lines == ["something happened"]


class TestInstall:
    def test_attaches_to_every_handler_on_the_logger(self) -> None:
        logger = logging.getLogger("test.log_redaction.install")
        logger.handlers = [logging.NullHandler(), logging.NullHandler()]

        install_presigned_url_scrubbing(logger)

        assert all(any(isinstance(f, PresignedUrlFilter) for f in handler.filters) for handler in logger.handlers)

    def test_is_idempotent_so_a_second_call_covers_only_new_handlers(self) -> None:
        logger = logging.getLogger("test.log_redaction.idempotent")
        logger.handlers = [logging.NullHandler()]
        install_presigned_url_scrubbing(logger)
        install_presigned_url_scrubbing(logger)

        installed = [f for f in logger.handlers[0].filters if isinstance(f, PresignedUrlFilter)]
        assert len(installed) == 1
