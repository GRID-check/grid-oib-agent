package policy

import (
	"context"
	"strings"
)

// Warrants is the in-process equivalent of the WorkOS FGA warrant graph. In
// production this lives in WorkOS; here it lets unit tests exercise the full
// allow/deny matrix (including the write path) without any network.
type Warrants struct {
	// subject -> set of orgs the subject belongs to.
	Orgs map[string]map[string]bool
	// subject -> org -> role at org level ("viewer"|"editor").
	OrgRoles map[string]map[string]string
	// subject -> "org/project" -> role ("viewer"|"editor").
	ProjectRoles map[string]map[string]string
}

// Mock is an in-process Client resolving the OIB-core -> org -> project layering.
type Mock struct{ W Warrants }

func NewMock(w Warrants) *Mock { return &Mock{W: w} }

// objectPath strips the "document:" resource-type prefix.
func objectPath(object string) string {
	if i := strings.IndexByte(object, ':'); i >= 0 {
		return object[i+1:]
	}
	return object
}

func (m *Mock) Check(_ context.Context, subject, relation, object string) (bool, error) {
	path := objectPath(object)
	if path == "" {
		return false, nil
	}
	parts := strings.Split(path, "/")
	top := parts[0]

	// OIB core: shared, read-only ground truth. Any known subject may view.
	if top == "oib-core" {
		_, known := m.W.Orgs[subject]
		return known && relation == "viewer", nil
	}

	org := top
	if !m.W.Orgs[subject][org] {
		return false, nil
	}

	// Project subtree: must be assigned to the project.
	if len(parts) >= 2 && strings.HasPrefix(parts[1], "project-") {
		project := strings.TrimPrefix(parts[1], "project-")
		role := m.W.ProjectRoles[subject][org+"/"+project]
		if role == "" {
			return false, nil
		}
		if relation == "editor" {
			return role == "editor", nil
		}
		return true, nil
	}

	// Org-level file: members view; editors edit.
	if relation == "editor" {
		return m.W.OrgRoles[subject][org] == "editor", nil
	}
	return true, nil
}

func (m *Mock) BatchCheck(ctx context.Context, subject, relation string, objects []string) (map[string]bool, error) {
	out := make(map[string]bool, len(objects))
	for _, o := range objects {
		a, err := m.Check(ctx, subject, relation, o)
		if err != nil {
			return nil, err
		}
		out[o] = a
	}
	return out, nil
}
