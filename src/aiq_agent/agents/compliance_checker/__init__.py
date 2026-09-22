"""OIB compliance-check pipeline (RETIRED as a chat tool).

The staged Soll-Ist implementation in :mod:`agent`, :mod:`models` and
:mod:`report` stays importable, but importing this package must NOT register
the ``compliance_check_agent`` NAT function: no workflow config binds the tool
to any agent and the ``aiq_compliance_checker`` plugin entry point is removed.
Reach the registration explicitly via
``aiq_agent.agents.compliance_checker.register`` (tests do exactly that).
"""
