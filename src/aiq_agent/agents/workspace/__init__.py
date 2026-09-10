"""Büro (workspace) tools — the office above the projects (ADR-0054).

``find_projects`` searches the Projektregister: which projects this office has
and what they are. Register hits are navigation and structured facts, never
document content — reading a project's files needs the project mounted, which
is the other tool this package will hold.
"""
