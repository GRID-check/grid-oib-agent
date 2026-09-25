"""Record every model call a turn makes: the request as sent, the usage as billed.

Loaded by ``scripts/turn_census/census.py`` through ``PYTHONPATH`` (Python
imports ``sitecustomize`` at start-up), so the agent runs unmodified. It
wraps ``httpx``'s ``send`` for the model hosts only and appends one JSON line
per call to ``$REC_OUT``. Never loaded by the application itself.
"""

import itertools
import json
import os
import time

import httpx

_OUT = os.environ.get("REC_OUT", "")
_SEQ = itertools.count(1)
_HOSTS = ("openrouter.ai", "api.typesafe.ai", "api.openai.com")


def _write(entry):
    with open(_OUT, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _completed_response(text):
    """The full response a streamed Responses call closes with, or None.

    A streamed call (ADR-0066) has no JSON body: its ``response.completed``
    event carries the same object a buffered call returns, and the suite reads
    the answer out of it. Without this every streamed answer recorded as none.
    """
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        try:
            obj = json.loads(line[5:].strip())
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("type") == "response.completed":
            return obj.get("response")
    return None


def _usage_from_text(text):
    usage = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict):
            u = obj.get("usage") or (obj.get("response") or {}).get("usage")
            if u:
                usage = u
    return usage


class _Tee(httpx.AsyncByteStream):
    def __init__(self, inner, entry):
        self._inner, self._entry, self._buf = inner, entry, bytearray()

    async def __aiter__(self):
        async for chunk in self._inner:
            self._buf.extend(chunk)
            # When the first visible text left the model: what streaming changes.
            if "t_first_text" not in self._entry and b"response.output_text.delta" in chunk:
                self._entry["t_first_text"] = time.time()
            yield chunk

    async def aclose(self):
        await self._inner.aclose()
        text = self._buf.decode("utf-8", "replace")
        self._entry["usage"] = _usage_from_text(text)
        self._entry["resp_chars"] = len(text)
        if (completed := _completed_response(text)) is not None:
            self._entry["resp"] = completed
        self._entry["t_end"] = time.time()
        _write(self._entry)


_orig = httpx.AsyncClient.send


async def _send(self, request, *args, **kwargs):
    host = request.url.host or ""
    if not any(h in host for h in _HOSTS):
        return await _orig(self, request, *args, **kwargs)
    seq = next(_SEQ)
    body = request.content.decode("utf-8", "replace") if request.content else ""
    entry = {"seq": seq, "t_start": time.time(), "url": str(request.url), "req_chars": len(body)}
    try:
        entry["req"] = json.loads(body)
    except Exception:
        entry["req_raw"] = body[:2000]
    resp = await _orig(self, request, *args, **kwargs)
    entry["status"] = resp.status_code
    if kwargs.get("stream"):
        resp.stream = _Tee(resp.stream, entry)
        return resp
    try:
        await resp.aread()
        text = resp.text
        entry["usage"] = _usage_from_text(text)
        entry["resp_chars"] = len(text)
        try:
            entry["resp"] = json.loads(text)
        except Exception:
            pass
    except Exception as exc:
        entry["err"] = repr(exc)
    entry["t_end"] = time.time()
    _write(entry)
    return resp


if _OUT:  # only when the census asked for a record
    httpx.AsyncClient.send = _send

_orig_sync = httpx.Client.send


def _send_sync(self, request, *args, **kwargs):
    host = request.url.host or ""
    if not any(h in host for h in _HOSTS):
        return _orig_sync(self, request, *args, **kwargs)
    seq = next(_SEQ)
    body = request.content.decode("utf-8", "replace") if request.content else ""
    entry = {"seq": seq, "t_start": time.time(), "url": str(request.url), "req_chars": len(body), "sync": True}
    try:
        entry["req"] = json.loads(body)
    except Exception:
        entry["req_raw"] = body[:2000]
    resp = _orig_sync(self, request, *args, **kwargs)
    entry["status"] = resp.status_code
    if not kwargs.get("stream"):
        try:
            resp.read()
            entry["usage"] = _usage_from_text(resp.text)
            entry["resp_chars"] = len(resp.text)
            try:
                entry["resp"] = json.loads(resp.text)
            except Exception:
                pass
        except Exception as exc:
            entry["err"] = repr(exc)
    entry["t_end"] = time.time()
    _write(entry)
    return resp


if _OUT:  # only when the census asked for a record
    httpx.Client.send = _send_sync
