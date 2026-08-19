"""Retrieval evaluation harness for the OIB corpus.

Scoring logic lives in NAT-free modules (:mod:`metrics`, :mod:`qrels`, :mod:`structure`,
:mod:`lexical`, :mod:`dense`) so it is unit-testable offline; :mod:`register` is the NAT
plugin entry point. See ``README.md`` for what this harness measures and what it does not.
"""
