// Package holds implements the legal-hold gate the gateway consults before a
// drive `rm` destroys bytes (ADR-0024 §3). The BFF owns the `legal_holds` table,
// so the production checker delegates there — the same brain the purger re-checks
// before every destructive step — via a dedicated internal endpoint.
//
// It is separate from the policy package (which answers FGA relation questions)
// because a legal hold is an orthogonal, compliance concern with the opposite
// failure posture: a policy check fails closed by DENYING access, whereas this
// fails closed by REFUSING destruction (preserving the bytes).
package holds

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"gridnas/gateway/internal/authz"
)

// BFF is the production HoldChecker. It POSTs to the BFF file-deletable endpoint
// with the object's org/project/key and returns whether the delete is permitted
// (i.e. NOT under an active legal hold).
type BFF struct {
	endpoint string
	token    string
	http     *http.Client
}

func NewBFF(endpoint, token string, timeout time.Duration) *BFF {
	return &BFF{endpoint: endpoint, token: token, http: &http.Client{Timeout: timeout}}
}

// objectKeyFor normalizes a gateway path into the canonical S3 key: strip any
// "document:" prefix and leading/trailing slashes. path.Clean guards traversal.
func objectKeyFor(p string) string {
	p = strings.TrimPrefix(p, "document:")
	clean := path.Clean("/" + p)
	return strings.Trim(clean, "/")
}

// parseOrgProject extracts (org, project) from the canonical key layout
// org/<org>/project/<proj>/.../doc/<id>/<file>. Returns ok=false for keys outside
// that layout (the caller then fails closed).
func parseOrgProject(objectKey string) (orgID, projectID string, ok bool) {
	seg := strings.Split(objectKey, "/")
	if len(seg) >= 4 && seg[0] == "org" && seg[2] == "project" && seg[1] != "" && seg[3] != "" {
		return seg[1], seg[3], true
	}
	return "", "", false
}

type deletableReq struct {
	OrganizationID string `json:"organizationId"`
	ProjectID      string `json:"projectId"`
	ObjectKey      string `json:"objectKey"`
}

type deletableResp struct {
	Deletable bool `json:"deletable"`
}

// DeletionAllowed asks the BFF whether destroying path is permitted. Any error
// (unparseable key, tenancy mismatch, transport failure, non-200) is returned so
// Guard.Remove fails CLOSED and refuses the delete — bytes are never destroyed on
// an uncertain answer.
func (b *BFF) DeletionAllowed(ctx context.Context, subj authz.Subject, p string) (bool, error) {
	objectKey := objectKeyFor(p)
	orgID, projectID, ok := parseOrgProject(objectKey)
	if !ok {
		return false, fmt.Errorf("holds: cannot resolve org/project for %q", objectKey)
	}
	// Tenancy defense-in-depth: the mount's org must own the path. Editor authz
	// already enforced this upstream; refuse rather than query cross-tenant.
	if subj.OrgID != "" && subj.OrgID != orgID {
		return false, fmt.Errorf("holds: subject org %q does not own %q", subj.OrgID, objectKey)
	}

	body, _ := json.Marshal(deletableReq{OrganizationID: orgID, ProjectID: projectID, ObjectKey: objectKey})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-grid-internal-token", b.token)

	resp, err := b.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("holds: deletable check: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("holds: deletable check status %d", resp.StatusCode)
	}
	var out deletableResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, fmt.Errorf("holds: deletable decode: %w", err)
	}
	return out.Deletable, nil
}
