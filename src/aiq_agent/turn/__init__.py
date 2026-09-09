"""The per-turn request harness for the chat workflow.

Everything that runs once per chat turn and is NOT the answering agent lives
here: parsing what the request states about the turn, loading its context and
document inventory, binding the per-turn registries, admitting the turn
against capacity and budget, lifting the finished graph state onto the wire
response, and streaming it. The workflow entry point
(``aiq_agent.agents.chat_researcher.register``) composes these units; each is a
small tested function with an explicit signature, so a fix in one can be tested
without standing up a NAT workflow.

Every import of ``aiq_api`` from this package goes through
:mod:`aiq_agent.turn.api_seam`, the one place that names the inverted
dependency.
"""
