"""NAT tools that are not agents.

A tool answers one bounded question and returns; it owns no graph, no
conversation state and no model of its own. Nothing is imported here: each
tool module is loaded by NAT through its own `nat.plugins` entry point, so a
tool whose optional dependencies are missing takes only itself down.
"""
