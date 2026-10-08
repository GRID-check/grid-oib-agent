#!/usr/bin/env python3

"""Local AIQ Research API client.

This helper assumes a local AIQ server running with REQUIRE_AUTH=false.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Iterator
from typing import Any

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")
_JOB_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _int_const(value: str) -> int:
    """Return a named integer constant without embedding raw numeric literals."""
    return int(value)


AGENT_TYPE_MIN_LENGTH = 1
AGENT_TYPE_MAX_LENGTH = _int_const("128")
_AGENT_TYPE_RE = re.compile(rf"^[a-zA-Z0-9_.-]{{{AGENT_TYPE_MIN_LENGTH},{AGENT_TYPE_MAX_LENGTH}}}$")
_ALLOWED_METHODS = frozenset({"GET", "POST"})

DEFAULT_SERVER_URL = "http://localhost:8000"
AIQ_SERVER_URL = os.environ.get("AIQ_SERVER_URL", DEFAULT_SERVER_URL)
# `chat` asks over the chat socket (/websocket, wire v2), the one route a turn runs through. Only the chat
# role serves it (ADR-0082); the api role on AIQ_SERVER_URL does not.
DEFAULT_CHAT_URL = "http://localhost:8001"
AIQ_CHAT_URL = os.environ.get("AIQ_CHAT_URL", DEFAULT_CHAT_URL)

_HEADLESS_HEADERS = {"Content-Type": "application/json", "X-AIQ-Mode": "headless"}
DEFAULT_AGENT_TYPE = "researcher"
_LOCAL_BACKEND_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "host.docker.internal"})

URL_MAX_LENGTH = _int_const("2048")
API_PATH_MAX_LENGTH = _int_const("4096")
ERROR_BODY_PREVIEW_CHARS = _int_const("1000")
HEALTH_TIMEOUT_SECONDS = _int_const("10")
DEFAULT_API_TIMEOUT_SECONDS = _int_const("120")
DEFAULT_LONG_HTTP_TIMEOUT_SECONDS = _int_const("3600")
JOB_POLL_INTERVAL_SECONDS = _int_const("15")
STATUS_CHECK_MAX_ATTEMPTS = _int_const("3")
POLL_MAX_CONSECUTIVE_ERRORS = _int_const("3")
JSON_INDENT_SPACES = 2
EXIT_FAILURE = 1
FIRST_ARG_POSITION = 0
OPTIONAL_AGENT_TYPE_POSITION = 1
MIN_COMMAND_ARG_COUNT = 2
COMMAND_NAME_POSITION = 1
COMMAND_ARGS_START_POSITION = 2
DATA_PREFIX = "data:"
EVENT_PREFIX = "event:"
NO_CONSECUTIVE_ERRORS = 0
ERROR_INCREMENT = 1
FIRST_RETRY_ATTEMPT = 1

_DONE_JOB_STATES = frozenset({"completed", "success", "failed", "cancelled", "failure"})
_SUCCESS_JOB_STATES = frozenset({"completed", "success"})
_FAILED_JOB_STATES = frozenset({"failed", "failure", "cancelled"})
_STREAM_TERMINAL_EVENTS = frozenset({"complete", "error", "done"})

# The chat socket: wire v2 (the backend's docs/api/websocket-protocol.md) over RFC 6455, standard library only.
CHAT_SOCKET_PATH = "/websocket"
WIRE_VERSION = 2
# The clarifier's own skip word: a headless caller cannot answer a question the turn stops to ask.
CLARIFICATION_ANSWER = "skip"
_WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_WS_KEY_BYTES = _int_const("16")
_WS_MASK_BYTES = _int_const("4")
_WS_FIN = _int_const("128")
_WS_MASKED = _int_const("128")
_WS_OPCODE_MASK = _int_const("15")
_WS_LENGTH_MASK = _int_const("127")
_WS_LENGTH_16 = _int_const("126")
_WS_LENGTH_64 = _int_const("127")
_WS_MAX_7BIT = _int_const("125")
_WS_MAX_16BIT = _int_const("65535")
_WS_CONTINUATION = 0
_WS_TEXT = 1
_WS_CLOSE = _int_const("8")
_WS_PING = _int_const("9")
_WS_PONG = _int_const("10")
_HTTP_HEAD_END = b"\r\n\r\n"
_HTTP_SWITCHING_PROTOCOLS = " 101 "
_HTTPS_PORT = _int_const("443")
_HTTP_PORT = _int_const("80")


def _validate_base_url(url: str) -> str:
    """Validate and normalize the configured AI-Q server base URL."""
    raw = (url or "").strip()
    if not raw:
        raise RuntimeError("AIQ_SERVER_URL is empty")
    if len(raw) > URL_MAX_LENGTH or _CONTROL_CHAR_RE.search(raw):
        raise RuntimeError("AIQ_SERVER_URL is invalid")
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise RuntimeError("AIQ_SERVER_URL must be an http or https URL with a host")
    if parsed.username is not None or parsed.password is not None:
        raise RuntimeError("AIQ_SERVER_URL must not include user:password@")
    if parsed.scheme == "http" and parsed.hostname not in _LOCAL_BACKEND_HOSTS:
        raise RuntimeError("Non-local AIQ_SERVER_URL values must use https")
    return raw.rstrip("/")


def _resolve_base_url(base_url: str | None) -> str:
    """Return the role's base URL, or the api role's AIQ_SERVER_URL when no role is named."""
    return _validate_base_url(AIQ_SERVER_URL if base_url is None else base_url)


def _show_query_target(api_path: str, base_url: str | None = None) -> None:
    """Disclose the destination before transmitting user-provided query text."""
    print(
        f"Sending user query text to configured AI-Q backend: {_resolve_base_url(base_url)}{api_path}",
        file=sys.stderr,
    )


def _validate_api_path(path: str) -> None:
    """Reject unsafe or malformed API paths before building a request URL."""
    if not path.startswith("/") or path.startswith("//"):
        raise RuntimeError("Invalid API path")
    if len(path) > API_PATH_MAX_LENGTH or ".." in path or _CONTROL_CHAR_RE.search(path):
        raise RuntimeError("Invalid API path")


def _validate_job_id(job_id: str) -> str:
    """Validate an async job identifier and return its normalized value."""
    value = job_id.strip()
    if not _JOB_UUID_RE.fullmatch(value):
        raise RuntimeError("job_id must be a UUID")
    return value


def _validate_agent_type(agent_type: str) -> str:
    """Validate an async agent type name accepted by the AI-Q job API."""
    value = agent_type.strip()
    if not _AGENT_TYPE_RE.fullmatch(value):
        raise RuntimeError("Invalid agent_type")
    return value


def _api_request(
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: int = DEFAULT_API_TIMEOUT_SECONDS,
    base_url: str | None = None,
) -> dict[str, Any]:
    """Send a JSON API request to the configured AI-Q backend (or the given role's base URL)."""
    if method not in _ALLOWED_METHODS:
        raise RuntimeError(f"Unsupported HTTP method: {method!r}")
    _validate_api_path(path)

    url = f"{_resolve_base_url(base_url)}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    if method == "POST":
        request_payload = {"url": url, "headers": dict(_HEADLESS_HEADERS), "method": method, "data": data}
    else:
        request_payload = {"url": url, "method": method}
    req = urllib.request.Request(**request_payload)

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {error_body[:ERROR_BODY_PREVIEW_CHARS]}", file=sys.stderr)
        raise RuntimeError(f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        print(f"Connection failed for {url}: {exc.reason}", file=sys.stderr)
        raise RuntimeError(f"Connection failed: {exc.reason}") from exc

    if not payload:
        return {}
    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON in API response: {payload[:ERROR_BODY_PREVIEW_CHARS]!r}", file=sys.stderr)
        raise RuntimeError(f"Invalid JSON in API response: {exc}") from exc


def _stream_request(path: str, *, timeout: int = DEFAULT_LONG_HTTP_TIMEOUT_SECONDS) -> Iterator[str]:
    """Yield stripped text lines from an AI-Q streaming endpoint."""
    _validate_api_path(path)
    url = f"{_validate_base_url(AIQ_SERVER_URL)}{path}"
    req = urllib.request.Request(url, method="GET")

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw_line in resp:
                yield raw_line.decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {error_body[:ERROR_BODY_PREVIEW_CHARS]}", file=sys.stderr)
        raise RuntimeError(f"HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        print(f"Connection failed for {url}: {exc.reason}", file=sys.stderr)
        raise RuntimeError(f"Connection failed: {exc.reason}") from exc


def health() -> dict[str, Any]:
    """Return the AI-Q api role's health response."""
    return _api_request("GET", "/health", timeout=HEALTH_TIMEOUT_SECONDS)


def list_agents() -> dict[str, Any]:
    """List async agent types registered by the AI-Q backend."""
    return _api_request("GET", "/v1/jobs/async/agents")


def submit_job(query: str, agent_type: str = DEFAULT_AGENT_TYPE) -> dict[str, Any]:
    """Submit an explicit async research job to AI-Q."""
    body = {"agent_type": _validate_agent_type(agent_type), "input": query}
    _show_query_target("/v1/jobs/async/submit")
    return _api_request("POST", "/v1/jobs/async/submit", body=body, timeout=DEFAULT_LONG_HTTP_TIMEOUT_SECONDS)


def get_job_status(job_id: str) -> dict[str, Any]:
    """Fetch the top-level status for an async AI-Q job."""
    return _api_request("GET", f"/v1/jobs/async/job/{_validate_job_id(job_id)}")


def get_job_state(job_id: str) -> dict[str, Any]:
    """Fetch event-store artifacts for an async AI-Q job."""
    return _api_request("GET", f"/v1/jobs/async/job/{_validate_job_id(job_id)}/state")


def get_report(job_id: str) -> dict[str, Any]:
    """Fetch the final report for a completed async AI-Q job."""
    return _api_request("GET", f"/v1/jobs/async/job/{_validate_job_id(job_id)}/report")


def cancel_job(job_id: str) -> dict[str, Any]:
    """Request cancellation for a running async AI-Q job."""
    return _api_request("POST", f"/v1/jobs/async/job/{_validate_job_id(job_id)}/cancel")


def stream_job(job_id: str) -> None:
    """Print server-sent event payloads for an async AI-Q job."""
    for line in _stream_request(f"/v1/jobs/async/job/{_validate_job_id(job_id)}/stream"):
        if line.startswith(DATA_PREFIX):
            data = line[len(DATA_PREFIX) :].strip()
            if data:
                print(data, flush=True)
        elif line.startswith(EVENT_PREFIX) and line[len(EVENT_PREFIX) :].strip() in _STREAM_TERMINAL_EVENTS:
            break


def list_data_sources() -> dict[str, Any]:
    """List the data sources the AI-Q backend registers."""
    return _api_request("GET", "/v1/data_sources")


class _ChatSocket:
    """A minimal RFC 6455 client: JSON text messages in and out, which is all the chat socket carries."""

    def __init__(self, url: str, timeout: int) -> None:
        parsed = urllib.parse.urlparse(url)
        secure = parsed.scheme == "https"
        port = parsed.port or (_HTTPS_PORT if secure else _HTTP_PORT)
        raw = socket.create_connection((parsed.hostname, port), timeout)
        self._sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname) if secure else raw
        key = base64.b64encode(os.urandom(_WS_KEY_BYTES)).decode("ascii")
        target = f"{parsed.path}?{parsed.query}" if parsed.query else parsed.path
        self._sock.sendall(
            (
                f"GET {target} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii")
        )
        status, *lines = self._read_head().split("\r\n")
        headers = {name.strip().lower(): value.strip() for name, _, value in (line.partition(":") for line in lines)}
        expected = base64.b64encode(hashlib.sha1((key + _WS_ACCEPT_GUID).encode("ascii")).digest()).decode("ascii")
        if _HTTP_SWITCHING_PROTOCOLS not in f"{status} " or headers.get("sec-websocket-accept") != expected:
            self._sock.close()
            raise RuntimeError(f"Chat socket refused the upgrade: {status}")

    def __enter__(self) -> _ChatSocket:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _read_head(self) -> str:
        head = b""
        while not head.endswith(_HTTP_HEAD_END):
            head += self._read_exact(1)
        return head.decode("latin-1")

    def _read_exact(self, size: int) -> bytes:
        data = b""
        while len(data) < size:
            chunk = self._sock.recv(size - len(data))
            if not chunk:
                raise RuntimeError("Chat socket closed by the server")
            data += chunk
        return data

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(_WS_MASK_BYTES)
        size = len(payload)
        if size <= _WS_MAX_7BIT:
            header = struct.pack("!BB", _WS_FIN | opcode, _WS_MASKED | size)
        elif size <= _WS_MAX_16BIT:
            header = struct.pack("!BBH", _WS_FIN | opcode, _WS_MASKED | _WS_LENGTH_16, size)
        else:
            header = struct.pack("!BBQ", _WS_FIN | opcode, _WS_MASKED | _WS_LENGTH_64, size)
        masked = bytes(byte ^ mask[index % _WS_MASK_BYTES] for index, byte in enumerate(payload))
        self._sock.sendall(header + mask + masked)

    def send_json(self, message: dict[str, Any]) -> None:
        self._send_frame(_WS_TEXT, json.dumps(message).encode("utf-8"))

    def recv_json(self) -> dict[str, Any]:
        """The next JSON message, answering pings and joining fragments on the way."""
        message = b""
        while True:
            first, second = self._read_exact(2)
            size = second & _WS_LENGTH_MASK
            if size == _WS_LENGTH_16:
                (size,) = struct.unpack("!H", self._read_exact(2))
            elif size == _WS_LENGTH_64:
                (size,) = struct.unpack("!Q", self._read_exact(_int_const("8")))
            payload = self._read_exact(size)
            opcode = first & _WS_OPCODE_MASK
            if opcode == _WS_PING:
                self._send_frame(_WS_PONG, payload)
            elif opcode == _WS_CLOSE:
                raise RuntimeError("Chat socket closed by the server")
            elif opcode in (_WS_TEXT, _WS_CONTINUATION):
                message += payload
                if first & _WS_FIN:
                    return json.loads(message.decode("utf-8"))

    def close(self) -> None:
        try:
            self._send_frame(_WS_CLOSE, b"")
        except OSError:
            pass
        self._sock.close()


def _chat_socket_url(conversation_id: str) -> str:
    """The chat role's socket for one conversation, asking for wire v2."""
    query = urllib.parse.urlencode({"v": WIRE_VERSION, "conversationId": conversation_id})
    return f"{_resolve_base_url(AIQ_CHAT_URL)}{CHAT_SOCKET_PATH}?{query}"


def chat_request(query: str) -> dict[str, Any]:
    """Ask one question over the chat socket and return the finished turn: its outcome and result.

    The socket is the one route a turn runs through. Every data source the backend
    lists is offered, as the product does. A clarifying question the turn stops to
    ask is answered with the clarifier's skip word, so the turn answers as asked.
    """
    sources = [str(source["id"]) for source in list_data_sources().get("data_sources", []) if source.get("id")]
    conversation_id = f"aiq-skill-{uuid.uuid4().hex[:12]}"
    message_id = f"aiq-skill-{uuid.uuid4().hex}"
    _show_query_target(CHAT_SOCKET_PATH, AIQ_CHAT_URL)
    with _ChatSocket(_chat_socket_url(conversation_id), DEFAULT_LONG_HTTP_TIMEOUT_SECONDS) as chat_socket:
        hello = chat_socket.recv_json()
        if hello.get("v") != WIRE_VERSION or hello.get("name") != "hello":
            raise RuntimeError("The chat role did not open with a wire v2 hello; check AIQ_CHAT_URL")
        envelope = {"v": WIRE_VERSION, "conversation_id": conversation_id}
        chat_socket.send_json(
            {**envelope, "type": "user_message", "message_id": message_id, "text": query, "data_sources": sources}
        )
        while True:
            event = chat_socket.recv_json()
            if event.get("turn_id") != message_id:
                continue
            kind = event.get("name") if event.get("type") == "CUSTOM" else event.get("type")
            if kind == "interaction_request":
                interaction_id = event.get("value", {}).get("interaction_id")
                chat_socket.send_json(
                    {
                        **envelope,
                        "type": "interaction_response",
                        "turn_id": message_id,
                        "interaction_id": interaction_id,
                        "answer": {"text": CLARIFICATION_ANSWER},
                    }
                )
            elif kind == "rejected":
                raise RuntimeError(f"Chat socket refused the question: {event.get('value', {}).get('code')}")
            elif kind == "RUN_ERROR":
                raise RuntimeError(f"Turn failed: {event.get('code')}: {event.get('message')}")
            elif kind == "RUN_FINISHED":
                return {"outcome": event.get("outcome"), **(event.get("result") or {})}


def poll_until_complete(
    job_id: str,
    *,
    timeout: int = DEFAULT_LONG_HTTP_TIMEOUT_SECONDS,
    max_consecutive_errors: int = POLL_MAX_CONSECUTIVE_ERRORS,
) -> dict[str, Any]:
    """Poll a job until it reaches a terminal state or timeout."""
    deadline = time.time() + timeout
    consecutive_errors = NO_CONSECUTIVE_ERRORS
    while time.time() < deadline:
        try:
            status = get_job_status(job_id)
            consecutive_errors = NO_CONSECUTIVE_ERRORS
        except RuntimeError as exc:
            consecutive_errors += ERROR_INCREMENT
            if consecutive_errors >= max_consecutive_errors:
                print(f"  Status check failed {consecutive_errors} times in a row: {exc}", file=sys.stderr)
                raise
            print(
                f"  Status check failed ({exc}), retrying... ({consecutive_errors}/{max_consecutive_errors})",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(JOB_POLL_INTERVAL_SECONDS)
            continue

        state = status.get("status", "UNKNOWN").lower()
        if state in _DONE_JOB_STATES:
            return status
        print(f"  Status: {state}", file=sys.stderr, flush=True)
        time.sleep(JOB_POLL_INTERVAL_SECONDS)

    print("  Timed out waiting for job.", file=sys.stderr)
    return {"status": "TIMEOUT"}


def _poll_until_success_or_exit(job_id: str) -> None:
    """Poll a job, print its report on success, and exit on failure."""
    try:
        final = poll_until_complete(job_id)
    except KeyboardInterrupt:
        print(f"\nInterrupted. Job {job_id} is still running server-side.", file=sys.stderr)
        print(f"Resume later: aiq.py research_poll {job_id}", file=sys.stderr)
        sys.exit(EXIT_FAILURE)

    if final.get("status", "").lower() not in _SUCCESS_JOB_STATES:
        print(f"Job did not complete: {final.get('status')}", file=sys.stderr)
        print(json.dumps(final, indent=JSON_INDENT_SPACES))
        sys.exit(EXIT_FAILURE)

    print(json.dumps(get_report(job_id), indent=JSON_INDENT_SPACES))


def _print_usage() -> None:
    """Print CLI usage information."""
    print("Usage: aiq.py <command> [args]")
    print()
    print("Commands:")
    print("  health                        Check the local AIQ server")
    print("  chat <query>                  Ask over the chat socket on AIQ_CHAT_URL (chat role), print the turn")
    print("  agents                        List available async agent types")
    print("  submit <query> [agent_type]   Submit an async job")
    print("  status <job_id>               Job status plus /state artifacts")
    print("  state <job_id>                Event-store artifacts for one async job")
    print("  stream <job_id>               Stream SSE events from an async job")
    print("  report <job_id>               Get final report from an async job")
    print("  research <query> [agent_type] Submit async job, poll, and return report")
    print("  research_poll <job_id>        Resume polling an existing async job")
    print("  cancel <job_id>               Cancel a running async job")
    print()
    print(f"Environment: AIQ_SERVER_URL defaults to {DEFAULT_SERVER_URL} (api role; every command but chat)")
    print(f"             AIQ_CHAT_URL defaults to {DEFAULT_CHAT_URL} (chat role; the chat command only)")


def _require_arg(args: list[str], usage: str, *, position: int = FIRST_ARG_POSITION) -> str:
    """Return a required command argument or exit with usage."""
    if len(args) <= position:
        print(usage, file=sys.stderr)
        sys.exit(EXIT_FAILURE)
    return args[position]


def _command_health(_args: list[str]) -> None:
    print(json.dumps(health(), indent=JSON_INDENT_SPACES))


def _command_chat(args: list[str]) -> None:
    query = _require_arg(args, "Usage: aiq.py chat <query>")
    print(json.dumps(chat_request(query), indent=JSON_INDENT_SPACES, ensure_ascii=False))


def _command_agents(_args: list[str]) -> None:
    print(json.dumps(list_agents(), indent=JSON_INDENT_SPACES))


def _command_submit(args: list[str]) -> None:
    query = _require_arg(args, "Usage: aiq.py submit <query> [agent_type]")
    agent_type = args[OPTIONAL_AGENT_TYPE_POSITION] if len(args) > OPTIONAL_AGENT_TYPE_POSITION else DEFAULT_AGENT_TYPE
    print(json.dumps(submit_job(query, agent_type=agent_type), indent=JSON_INDENT_SPACES))


def _command_status(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py status <job_id>")
    job_status = get_job_status(job_id)
    try:
        job_state = get_job_state(job_id)
    except RuntimeError as exc:
        job_state = {"_fetch_error": str(exc)}
    print(json.dumps({"job_status": job_status, "job_state": job_state}, indent=JSON_INDENT_SPACES))


def _command_state(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py state <job_id>")
    print(json.dumps(get_job_state(job_id), indent=JSON_INDENT_SPACES))


def _command_stream(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py stream <job_id>")
    stream_job(job_id)


def _command_report(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py report <job_id>")
    print(json.dumps(get_report(job_id), indent=JSON_INDENT_SPACES))


def _command_research(args: list[str]) -> None:
    query = _require_arg(args, "Usage: aiq.py research <query> [agent_type]")
    agent_type = args[OPTIONAL_AGENT_TYPE_POSITION] if len(args) > OPTIONAL_AGENT_TYPE_POSITION else DEFAULT_AGENT_TYPE
    print(f"Submitting {agent_type} job...", file=sys.stderr)
    result = submit_job(query, agent_type=agent_type)
    job_id = result.get("job_id")
    if not job_id:
        print(f"ERROR: No job_id in response: {result}", file=sys.stderr)
        sys.exit(EXIT_FAILURE)
    print(f"Job submitted: {job_id}", file=sys.stderr)
    _poll_until_success_or_exit(job_id)


def _command_research_poll(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py research_poll <job_id>")
    status = _checked_job_status(job_id)
    state = status.get("status", "UNKNOWN").lower()
    print(f"Current status: {state}", file=sys.stderr)
    if state in _SUCCESS_JOB_STATES:
        print(json.dumps(get_report(job_id), indent=JSON_INDENT_SPACES))
    elif state in _FAILED_JOB_STATES:
        print(f"Job {job_id} ended with status: {state}", file=sys.stderr)
        print(json.dumps(status, indent=JSON_INDENT_SPACES))
        sys.exit(EXIT_FAILURE)
    else:
        print("Job still running, polling...", file=sys.stderr)
        _poll_until_success_or_exit(job_id)


def _checked_job_status(job_id: str) -> dict[str, Any]:
    """Fetch job status with bounded retries."""
    for attempt in range(FIRST_RETRY_ATTEMPT, STATUS_CHECK_MAX_ATTEMPTS + ERROR_INCREMENT):
        try:
            return get_job_status(job_id)
        except RuntimeError as exc:
            if attempt == STATUS_CHECK_MAX_ATTEMPTS:
                print(f"Status check failed after {STATUS_CHECK_MAX_ATTEMPTS} attempts: {exc}", file=sys.stderr)
                sys.exit(EXIT_FAILURE)
            print(
                f"Status check failed ({exc}), retrying in {JOB_POLL_INTERVAL_SECONDS}s... "
                f"({attempt}/{STATUS_CHECK_MAX_ATTEMPTS})",
                file=sys.stderr,
            )
            time.sleep(JOB_POLL_INTERVAL_SECONDS)
    raise RuntimeError("unreachable")


def _command_cancel(args: list[str]) -> None:
    job_id = _require_arg(args, "Usage: aiq.py cancel <job_id>")
    print(json.dumps(cancel_job(job_id), indent=JSON_INDENT_SPACES))


def main() -> None:
    """Dispatch the command-line interface."""
    if len(sys.argv) < MIN_COMMAND_ARG_COUNT:
        _print_usage()
        sys.exit(EXIT_FAILURE)

    cmd = sys.argv[COMMAND_NAME_POSITION]
    commands = {
        "health": _command_health,
        "chat": _command_chat,
        "agents": _command_agents,
        "submit": _command_submit,
        "status": _command_status,
        "state": _command_state,
        "stream": _command_stream,
        "report": _command_report,
        "research": _command_research,
        "research_poll": _command_research_poll,
        "cancel": _command_cancel,
    }
    handler = commands.get(cmd)
    if handler is None:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        _print_usage()
        sys.exit(EXIT_FAILURE)
    try:
        handler(sys.argv[COMMAND_ARGS_START_POSITION:])
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(EXIT_FAILURE)


if __name__ == "__main__":
    main()
