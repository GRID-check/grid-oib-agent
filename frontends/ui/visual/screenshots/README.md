# Screenshot evidence

Committed UI evidence produced by the screenshot harness (`npm run screenshots`).
Each `<id>.<light|dark>.png` corresponds to a target in `../registry.mjs`, captured
from its backend-free `/dev/*` preview route.

Regenerate after a UI change and commit the updated PNGs alongside it — this is the
UI evidence the `definition-of-done` skill requires. See
[`docs/ux/visual-screenshots.md`](../../../../docs/ux/visual-screenshots.md).
