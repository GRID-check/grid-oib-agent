# Lifecycle matrix: <target>

<!-- Copy to <target>.md and add a row to README.md. Method:
     docs/contributing/lifecycle-matrix.md. State what should be true; defects
     with file and line go in the issue or PR, never here. -->

**Design of record:** <link to the doc the Expected column comes from>
**Owner area:** `<path>`
**Fixtures:** `<route>?scenario=…`, harness `<script>`

<!-- Fixture and check codes used in the tables, one line each. -->

## Phases

<!-- The state machine. One ambient loop per phase at most. -->

| # | Phase | Entered by (data) | Visible | Loop | Owner |
|---|---|---|---|---|---|
| P0 | | | | | |

## Edges

<!-- One row per transition, irregular ones included: error, stop, drop,
     reload, navigate away and back, second observer, reader toggles, a second
     action arriving quickly, reduced motion, phone, keyboard open, dark mode.
     An empty Fixture or Check cell is a gap; list it under Open gaps. -->

| # | Edge | Expected | Failure modes | Fixture | Check |
|---|---|---|---|---|---|
| L01 | | | | | |

## Events

<!-- Every event type the surface receives, including those with no visible
     effect. Cost per event where measured. -->

| # | Event | Appears | Where | Choreography | Cost |
|---|---|---|---|---|---|
| E01 | | | | | |

## Open gaps

<!-- Ranked by visibility x likelihood. Each entry names the fixture or check
     to add and leaves this list when it lands. -->

| Rank | Rows | Fixture to add | Assertion |
|---|---|---|---|
| G1 | | | |
