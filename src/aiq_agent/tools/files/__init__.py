"""Write-side workspace tools: five verbs that propose and never write.

``move_document``, ``rename_document``, ``create_folder``, ``set_doc_class``
and ``assign_document``. Each renders one ``file_operation_proposal`` card and
returns text saying nothing has changed; the reader's Accept executes it
through the routes the Files pane already uses, in their own session.

See ``src/aiq_agent/tools/AGENTS.md`` for why that is the only shape a write
from this tier may take.
"""
