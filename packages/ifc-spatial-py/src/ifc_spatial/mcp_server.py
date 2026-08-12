"""The MCP binding, and the ``ifc-spatial-mcp`` console entry point.

Thin on purpose: everything the tools DO lives in :mod:`ifc_spatial.tools`,
which imports no protocol. This module only translates between that and MCP's
request shapes, so a host embedding the library directly and an agent talking to
the server get identical answers rather than two implementations that drift.

## Which SDK path this took

The official ``mcp`` Python SDK installs cleanly here (2.0.0, alongside
pydantic/starlette/uvicorn/httpx), so this is the real thing and not a
hand-rolled JSON-RPC loop. The low-level ``Server`` is used rather than the
decorator-flavoured ``McpServer``: our tool definitions already ARE JSON Schema,
hand-written so the German description text — which is the part that decides
whether an agent reaches for the right operator — can be authored directly
rather than squeezed through a pydantic model's ``Field(description=…)``.
Handing that schema over unchanged keeps one source for it.

Two SDK generations are supported, because 2.0 replaced the decorator handlers
with constructor callbacks and a host may well have either: the 2.0 shape is
tried first and the 1.x decorators are the fallback. Both wire up the same two
functions.

## stdout belongs to the protocol

A stdio MCP server has one rule that costs an afternoon when broken: anything
written to stdout lands in the middle of a JSON-RPC frame and the client reports
a malformed message rather than a noisy one. This matters here because
IfcOpenShell's geometry iterator and ``ifcopenshell.draw`` both write progress
to stdout from C++. The 2.0 SDK's ``stdio_server`` already points fd 1 at stderr
for the life of the session and restores it afterwards, which covers the C++
side too — a Python-level ``sys.stdout`` swap would not have. On the 1.x path
this module does the redirect itself.

## Blocking work does not run on the event loop

Reading a 150 MB IFC, tessellating it and drawing a plan are seconds of
synchronous C++. Running them in the handler coroutine would freeze the
session's heartbeat and every other in-flight request; they go to a worker
thread. The library itself is thread-safe for this use because the cache's
single-flight table is a real lock — see :mod:`ifc_spatial.cache`.

## What this server deliberately does not do

No authentication, no tenancy, no rate limiting. A host that exposes it to more
than one customer's models owns those, and putting a half-measure here would
invite someone to trust it. The unit of isolation is the process: it holds only
the models it was handed.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

from .cache import SpatialCache
from .tools import ToolDef, ToolError, call, create_tools

SERVER_NAME = "ifc-spatial"
SERVER_VERSION = "0.1.0"

#: What the agent is told about the server as a whole, before it reads a single
#: tool description. The one sentence that has to survive: an empty result and
#: an undecidable are different answers.
INSTRUCTIONS = (
    "Räumliche Fragen an ein IFC-Modell. Zuerst open_model — das Briefing nennt die Geschoßnamen, das "
    "Property-Vokabular dieser Datei und die blinden Flecken. Jede Antwort trägt ihre Herkunft "
    "(declared/computed/inferred), eine Toleranz und den Rechenweg. `decidable: false` heißt „diese Datei "
    "kann das nicht sagen\" und nennt in `missing`, was es beheben würde — das ist ein Befund über den "
    "Export, nicht über das Gebäude. Ein Fehler heißt, dass die Frage nicht gestellt werden konnte "
    "(unbekannte GlobalId, kein geöffnetes Modell)."
)


def _tool_error_text(tools: list[ToolDef], error: BaseException) -> str:
    if isinstance(error, ToolError):
        return str(error)
    return f"{type(error).__name__}: {error}"


def _render(result: Any) -> str:
    return json.dumps(result, indent=2, ensure_ascii=False)


def create_server(cache: Optional[SpatialCache] = None) -> tuple[Any, list[ToolDef]]:
    """The MCP server and the tool list behind it.

    Returns both so a caller can serve the tools over another transport, or
    assert on their descriptions in a test, without starting anything.
    """
    import anyio.to_thread
    import mcp.types as types

    tools = create_tools(cache)
    by_name = {tool.name: tool for tool in tools}

    def descriptors() -> list[Any]:
        out = []
        for tool in tools:
            try:
                out.append(
                    types.Tool(
                        name=tool.name,
                        title=tool.title,
                        description=tool.description,
                        inputSchema=tool.input_schema,
                    )
                )
            except TypeError:  # pragma: no cover — field naming differs by SDK generation
                out.append(
                    types.Tool(
                        name=tool.name,
                        title=tool.title,
                        description=tool.description,
                        input_schema=tool.input_schema,
                    )
                )
        return out

    async def invoke(name: str, arguments: dict[str, Any]) -> tuple[str, bool]:
        """Run one tool off the event loop, and say whether it failed.

        ``is_error`` rather than a thrown protocol error: the model has to SEE
        the reason to correct itself, and a transport-level failure is reported
        to the host instead. A wrong GlobalId is a fixable mistake, not an
        outage.
        """
        tool = by_name.get(name)
        if tool is None:
            return (
                f'Unbekanntes Werkzeug "{name}". Verfügbar: {", ".join(by_name)}',
                True,
            )
        try:
            result = await anyio.to_thread.run_sync(lambda: call(tools, name, arguments or {}))
        except Exception as error:  # noqa: BLE001 — reported to the model, not raised at the transport
            return _tool_error_text(tools, error), True
        return _render(result), False

    # ── the 2.0 shape: handlers as constructor callbacks ────────────────────
    try:
        from mcp.server.lowlevel import Server

        async def on_list_tools(_context: Any, _params: Any = None) -> Any:
            return types.ListToolsResult(tools=descriptors())

        async def on_call_tool(_context: Any, params: Any) -> Any:
            text, failed = await invoke(params.name, getattr(params, "arguments", None) or {})
            return types.CallToolResult(
                content=[types.TextContent(type="text", text=text)], isError=failed
            )

        server = Server(
            SERVER_NAME,
            version=SERVER_VERSION,
            instructions=INSTRUCTIONS,
            on_list_tools=on_list_tools,
            on_call_tool=on_call_tool,
        )
        return server, tools
    except TypeError:  # pragma: no cover — SDK 1.x
        pass

    # ── the 1.x shape: decorators ───────────────────────────────────────────
    from mcp.server.lowlevel import Server  # noqa: F811

    server = Server(SERVER_NAME, version=SERVER_VERSION, instructions=INSTRUCTIONS)

    @server.list_tools()  # type: ignore[attr-defined]
    async def _list_tools() -> list[Any]:
        return descriptors()

    @server.call_tool()  # type: ignore[attr-defined]
    async def _call_tool(name: str, arguments: dict[str, Any]) -> list[Any]:
        text, failed = await invoke(name, arguments)
        if failed:
            raise RuntimeError(text)
        return [types.TextContent(type="text", text=text)]

    return server, tools


async def serve_stdio(cache: Optional[SpatialCache] = None) -> None:
    """Run the server over stdio until the client disconnects."""
    from mcp.server.stdio import stdio_server

    server, _tools = create_server(cache)
    async with stdio_server() as (read_stream, write_stream):
        sys.stderr.write("ifc-spatial MCP server bereit (stdio)\n")
        sys.stderr.flush()
        await server.run(read_stream, write_stream, server.create_initialization_options())


def main() -> None:
    """``ifc-spatial-mcp`` — the console entry point."""
    import anyio

    anyio.run(serve_stdio)


if __name__ == "__main__":  # pragma: no cover
    main()
