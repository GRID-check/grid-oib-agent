#!/usr/bin/env python3
"""
Mock WorkOS FGA "Check" endpoint.

This stands in for a *real* WorkOS FGA call. It is deliberately behind the exact
same interface the gateway would use against production:

    POST /check  { "subject": "alice", "relation": "viewer", "object": "document:org-acme/project-atlas/plan.pdf" }
    -> 200      { "allow": true }

WHERE THE REAL WORKOS CALL SLOTS IN
-----------------------------------
Replace `decide()` below with a WorkOS FGA warrant check:

    from workos import WorkOSClient
    wos = WorkOSClient(api_key=..., client_id=...)
    res = wos.fga.check(checks=[{
        "resource_type": "document", "resource_id": object_id,
        "relation": relation,
        "subject": {"resource_type": "user", "resource_id": subject},
    }])
    return res.is_authorized()

The warrant graph (who is in which org / on which project) lives in WorkOS, not
here. This mock encodes an equivalent graph in warrants.json so the *mechanism*
is proven without touching any real tenant. The knowledge layering
OIB core -> organization -> project -> session is modelled as resource-type
parents; WorkOS FGA resolves inheritance server-side.

NOTHING here contacts a real WorkOS tenant. No production credentials are used.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WARRANTS_PATH = os.environ.get("WARRANTS", "/app/warrants.json")


def load_warrants():
    with open(WARRANTS_PATH) as f:
        return json.load(f)


def decide(warrants, subject, relation, object_id):
    """Return True if `subject` has `relation` on `object_id`.

    object_id looks like "document:org-acme/project-atlas/plan.pdf".
    This resolves the OIB-core / org / project layering:

      * oib-core/*                      -> any authenticated subject may VIEW
                                           (read-only shared ground truth)
      * <org>/...                       -> subject must be a member of <org>
      * <org>/project-<p>/...           -> subject must also be assigned to
                                           project <p>
      * editor relation                 -> subject must additionally have write
                                           on that org/project
    """
    subj = warrants["subjects"].get(subject)
    if subj is None:
        return False  # unknown identity -> deny

    _, _, path = object_id.partition(":")
    parts = path.split("/")
    top = parts[0] if parts else ""

    # OIB core: shared, read-only ground truth. Everyone authenticated can view.
    if top == "oib-core":
        return relation == "viewer"

    # Otherwise the first segment is the org. Must be a member.
    org = top
    if org not in subj.get("orgs", []):
        return False

    # If addressing a project subtree, must be assigned to that project.
    if len(parts) >= 2 and parts[1].startswith("project-"):
        project = parts[1][len("project-"):]
        role = subj.get("projects", {}).get(f"{org}/{project}")
        if role is None:
            return False
        if relation == "editor":
            return role == "editor"
        return True  # viewer

    # Org-level (non-project) file: members can view; editors can edit.
    if relation == "editor":
        return subj.get("org_roles", {}).get(org) == "editor"
    return True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quieter logs
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/check":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "bad json"})
            return
        warrants = load_warrants()
        allow = decide(
            warrants,
            req.get("subject", ""),
            req.get("relation", "viewer"),
            req.get("object", ""),
        )
        print(f"CHECK subject={req.get('subject')} relation={req.get('relation')} "
              f"object={req.get('object')} -> {'ALLOW' if allow else 'DENY'}", flush=True)
        self._json(200, {"allow": allow})

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"mock-workos-fga listening on :{port}, warrants={WARRANTS_PATH}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
