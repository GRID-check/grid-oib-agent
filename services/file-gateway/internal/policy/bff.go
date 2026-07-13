package policy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// BFF delegates authorization to the Next.js BFF's internal endpoint, which is
// the single source of truth for access decisions in Grid (it already owns
// WorkOS identity, org-membership resolution, and the per-project FGA checks —
// see frontends/ui/src/lib/authz/projects.ts). The gateway does NOT re-implement
// FGA; it asks the same brain the web app uses, so a file on the mounted drive
// and the same file in the web UI are authorized identically.
//
// A document inherits access from its parent project (ADR-0004): the object key
// encodes org/project, and the BFF answers project:view / project:edit for the
// caller. The provisioned `document` FGA resource type reserves per-file grants
// for a future step without changing this call.
type BFF struct {
	endpoint string // e.g. http://frontend:3000/api/internal/file-access
	token    string // GRID_INTERNAL_API_TOKEN, shared across services
	http     *http.Client
}

func NewBFF(endpoint, token string, timeout time.Duration) *BFF {
	return &BFF{endpoint: endpoint, token: token, http: &http.Client{Timeout: timeout}}
}

// parseObject turns a gateway object id into (orgID, projectID). The object is
// the S3 key layout used by the BFF: org/<orgId>/project/<projectId>/.../doc/<id>/<file>
// (optionally prefixed with "document:"). Returns ok=false for keys outside that
// layout so the caller can fail closed.
func parseObject(object string) (orgID, projectID string, ok bool) {
	object = strings.TrimPrefix(object, "document:")
	seg := strings.Split(strings.Trim(object, "/"), "/")
	if len(seg) >= 4 && seg[0] == "org" && seg[2] == "project" && seg[1] != "" && seg[3] != "" {
		return seg[1], seg[3], true
	}
	return "", "", false
}

func relationToPermission(relation string) string {
	if relation == "editor" {
		return "project:edit"
	}
	return "project:view"
}

type bffReq struct {
	UserID         string `json:"userId"`
	OrganizationID string `json:"organizationId"`
	ProjectID      string `json:"projectId"`
	Permission     string `json:"permission"`
}

type bffResp struct {
	Allow bool `json:"allow"`
}

// isOwnOrgTraversalPrefix reports whether object is a directory ABOVE a project
// in the canonical key layout (org/<org>/project/<proj>/...), scoped to the
// subject's org. An NFS client must Lstat each ancestor to descend to a project,
// so these prefixes must resolve — but only within the caller's own org, so a
// listing never reveals another tenant's orgs/projects:
//
//	org               -> the top level (List then filters children to own org)
//	org/<org>         -> only the subject's own org
//	org/<org>/project -> only the subject's own org
func isOwnOrgTraversalPrefix(subjectOrgID, object string) bool {
	object = strings.TrimPrefix(object, "document:")
	seg := strings.Split(strings.Trim(object, "/"), "/")
	switch len(seg) {
	case 1:
		return seg[0] == "org"
	case 2:
		return seg[0] == "org" && seg[1] != "" && seg[1] == subjectOrgID
	case 3:
		return seg[0] == "org" && seg[2] == "project" && seg[1] == subjectOrgID
	default:
		return false
	}
}

func (b *BFF) checkOne(ctx context.Context, subjectUserID, subjectOrgID, relation, object string) (bool, error) {
	orgID, projectID, ok := parseObject(object)
	if !ok {
		// Not a full project path. Allow VIEWER traversal of the org/project
		// scaffolding above a project, within the subject's own org, so the drive
		// can descend to a project (where the real per-file check runs). Writes on
		// a traversal dir, and any other-org prefix, fall through to deny.
		if relation == "viewer" && isOwnOrgTraversalPrefix(subjectOrgID, object) {
			return true, nil
		}
		return false, nil
	}
	// Tenancy: the mount's org must own the path. A mismatch is a hard deny and
	// never reaches the BFF.
	if subjectOrgID != "" && subjectOrgID != orgID {
		return false, nil
	}
	body, _ := json.Marshal(bffReq{
		UserID:         subjectUserID,
		OrganizationID: orgID,
		ProjectID:      projectID,
		Permission:     relationToPermission(relation),
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	// Grid's internal endpoints authenticate on x-grid-internal-token, NOT a
	// Bearer header (see frontends/ui/src/lib/internal-auth.ts). Sending Bearer
	// made every check 403 → deny → the drive was deny-all in bff mode.
	req.Header.Set("x-grid-internal-token", b.token)
	resp, err := b.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("bff authz: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// The internal endpoint returns 200 {allow} for BOTH grant and deny; any
		// non-200 is an auth/transport failure. Surface it as an error so it
		// fails closed WITH a signal (audit + metric + grace) rather than a
		// silent deny-all — the exact failure mode that hid the wrong-header bug.
		return false, fmt.Errorf("bff authz: status %d", resp.StatusCode)
	}
	var out bffResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, fmt.Errorf("bff authz decode: %w", err)
	}
	return out.Allow, nil
}

func (b *BFF) Check(ctx context.Context, subject Subject, relation, object string) (bool, error) {
	return b.checkOne(ctx, subject.ID, subject.OrgID, relation, object)
}

// BatchCheck fans out with bounded concurrency (a directory listing must not be
// N serial round-trips to the BFF).
func (b *BFF) BatchCheck(ctx context.Context, subject Subject, relation string, objects []string) (map[string]bool, error) {
	type res struct {
		obj   string
		allow bool
		err   error
	}
	out := make(map[string]bool, len(objects))
	ch := make(chan res, len(objects))
	sem := make(chan struct{}, 8)
	for _, o := range objects {
		go func(o string) {
			sem <- struct{}{}
			defer func() { <-sem }()
			a, err := b.checkOne(ctx, subject.ID, subject.OrgID, relation, o)
			ch <- res{o, a, err}
		}(o)
	}
	var firstErr error
	for range objects {
		r := <-ch
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		out[r.obj] = r.allow
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}
