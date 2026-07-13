package authz

import (
	"context"
	"time"

	"golang.org/x/sync/singleflight"

	"gridnas/gateway/internal/audit"
	"gridnas/gateway/internal/policy"
)

// Metrics is the observability hook. A nil-safe no-op is used if unset, so the
// core never depends on Prometheus directly.
type Metrics interface {
	CheckObserved(source audit.Source, allow bool, latency time.Duration)
	Degraded(active bool)
}

type nopMetrics struct{}

func (nopMetrics) CheckObserved(audit.Source, bool, time.Duration) {}
func (nopMetrics) Degraded(bool)                                   {}

// Engine authorizes file operations. It is the ONLY component that decides
// allow/deny; every protocol/storage path must route through it.
type Engine struct {
	policy  policy.Client
	cache   *decisionCache
	audit   audit.Sink
	metrics Metrics
	group   singleflight.Group
	clock   func() time.Time
}

// Config parameters for the engine's cache and resilience behavior.
type Config struct {
	CacheSize  int
	CacheTTL   time.Duration
	CacheGrace time.Duration
}

func New(p policy.Client, sink audit.Sink, m Metrics, cfg Config) (*Engine, error) {
	if sink == nil {
		sink = audit.NopSink{}
	}
	if m == nil {
		m = nopMetrics{}
	}
	c, err := newDecisionCache(cfg.CacheSize, cfg.CacheTTL, cfg.CacheGrace)
	if err != nil {
		return nil, err
	}
	return &Engine{policy: p, cache: c, audit: sink, metrics: m, clock: time.Now}, nil
}

func cacheKey(op FileOp) string {
	// OrgID + Env are part of the decision identity: the same user id in a
	// different org/env must not collide on a cached decision.
	return op.Subject.Env + "|" + op.Subject.OrgID + "|" + op.Subject.ID + "|" +
		op.Relation.String() + "|" + op.Object
}

func policySubject(s Subject) policy.Subject {
	return policy.Subject{ID: s.ID, OrgID: s.OrgID}
}

// Authorize returns true iff the subject may perform the operation. Behaviour:
//   - the mount root is a traversal point and is always allowed (never gated);
//   - a fresh cached decision is returned without contacting the policy service;
//   - on a cache miss, identical concurrent checks collapse into one upstream call
//     (singleflight), preventing a thundering herd;
//   - on an upstream error, a previously-ALLOWED decision within the grace window
//     is served stale (degraded) so a brief policy outage doesn't down the drive;
//     everything else fails closed (deny).
func (e *Engine) Authorize(ctx context.Context, op FileOp) (bool, error) {
	if op.Object == "" { // mount root
		return true, nil
	}
	start := e.clock()
	key := cacheKey(op)

	if allow, res := e.cache.lookup(key); res == fresh {
		e.emit(ctx, op, allow, audit.SourceCache, "cache hit", start)
		return allow, nil
	}

	v, err, _ := e.group.Do(key, func() (interface{}, error) {
		return e.policy.Check(ctx, policySubject(op.Subject), op.Relation.String(), op.Object)
	})

	if err != nil {
		// Upstream failed. Try grace (stale-allow) before failing closed.
		if allow, res := e.cache.lookup(key); res == graceOK && allow {
			e.metrics.Degraded(true)
			e.emit(ctx, op, true, audit.SourceGrace, "policy unavailable: stale-allow within grace", start)
			return true, nil
		}
		e.emit(ctx, op, false, audit.SourceRemote, "policy unavailable: fail-closed", start)
		return false, nil
	}

	allow, ok := v.(bool)
	if !ok { // defensive: unexpected type from the policy layer → fail closed
		e.emit(ctx, op, false, audit.SourceRemote, "policy returned non-bool: fail-closed", start)
		return false, nil
	}
	e.cache.store(key, allow)
	e.metrics.Degraded(false)
	reason := "policy allow"
	if !allow {
		reason = "policy deny"
	}
	e.emit(ctx, op, allow, audit.SourceRemote, reason, start)
	return allow, nil
}

// FilterViewable returns the subset of children the subject may view, using one
// batched policy call (ADR-3) and warming the cache so a subsequent Open is a hit.
// objectByChild maps each child key to its logical object id.
func (e *Engine) FilterViewable(ctx context.Context, subj Subject, children []string, objectOf func(string) string) (map[string]bool, error) {
	objects := make([]string, 0, len(children))
	objToChild := make(map[string]string, len(children))
	for _, c := range children {
		obj := objectOf(c)
		objects = append(objects, obj)
		objToChild[obj] = c
	}
	res, err := e.policy.BatchCheck(ctx, policySubject(subj), Viewer.String(), objects)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(children))
	for obj, allow := range res {
		e.cache.store(cacheKey(FileOp{Subject: subj, Relation: Viewer, Object: obj}), allow)
		out[objToChild[obj]] = allow
	}
	return out, nil
}

func (e *Engine) emit(ctx context.Context, op FileOp, allow bool, src audit.Source, reason string, start time.Time) {
	lat := e.clock().Sub(start)
	e.metrics.CheckObserved(src, allow, lat)
	e.audit.Record(ctx, audit.Decision{
		Time:      start,
		Subject:   op.Subject.ID,
		Relation:  op.Relation.String(),
		Object:    op.Object,
		Allow:     allow,
		Source:    src,
		Reason:    reason,
		LatencyMS: float64(lat.Microseconds()) / 1000.0,
	})
}
