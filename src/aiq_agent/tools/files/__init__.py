"""Write-side workspace tool: one verb that proposes and never writes.

``propose_file_change`` with an ``operation`` of ``move``, ``rename``,
``create_folder`` or ``assign``. It renders one ``file_operation_proposal``
card and returns text saying nothing has changed; the reader's Accept executes
it through the routes the Files pane already uses, in their own session.

See ``src/aiq_agent/tools/AGENTS.md`` for why that is the only shape a write
from this tier may take.
"""
