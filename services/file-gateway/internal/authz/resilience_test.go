package authz_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"gridnas/gateway/internal/authz"
)

// flakyPolicy returns a fixed decision until it is "broken", then errors.
type flakyPolicy struct {
	allow  bool
	broken atomic.Bool
	calls  atomic.Int64
}

func (f *flakyPolicy) Check(_ context.Context, _, _, _ string) (bool, error) {
	f.calls.Add(1)
	if f.broken.Load() {
		return false, errors.New("policy service down")
	}
	return f.allow, nil
}

func (f *flakyPolicy) BatchCheck(context.Context, string, string, []string) (map[string]bool, error) {
	return nil, errors.New("unused")
}

func TestGraceServesStaleAllowThenFailsClosed(t *testing.T) {
	fp := &flakyPolicy{allow: true}
	e, err := authz.New(fp, nil, nil, authz.Config{
		CacheSize: 100, CacheTTL: 20 * time.Millisecond, CacheGrace: 60 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	op := authz.FileOp{Subject: authz.Subject{ID: "alice"}, Relation: authz.Viewer, Object: "document:org-acme/x"}

	// 1. Warm the cache with an allow.
	if ok, _ := e.Authorize(ctx, op); !ok {
		t.Fatal("expected initial allow")
	}
	// 2. Break the policy service and expire the TTL (but stay within grace).
	fp.broken.Store(true)
	time.Sleep(30 * time.Millisecond)
	if ok, _ := e.Authorize(ctx, op); !ok {
		t.Fatal("within grace, a previously-allowed decision must be served stale")
	}
	// 3. Exceed the grace window -> must fail closed (deny).
	time.Sleep(80 * time.Millisecond)
	if ok, _ := e.Authorize(ctx, op); ok {
		t.Fatal("past grace with policy down must fail closed (deny)")
	}
}

func TestFailClosedWhenNeverCached(t *testing.T) {
	fp := &flakyPolicy{allow: true}
	fp.broken.Store(true) // down from the start
	e, _ := authz.New(fp, nil, nil, authz.Config{CacheSize: 100, CacheTTL: time.Second, CacheGrace: time.Second})
	op := authz.FileOp{Subject: authz.Subject{ID: "alice"}, Relation: authz.Editor, Object: "document:org-acme/project-atlas/plan.pdf"}
	if ok, _ := e.Authorize(context.Background(), op); ok {
		t.Fatal("an uncached op with policy down must be denied (fail closed)")
	}
}
