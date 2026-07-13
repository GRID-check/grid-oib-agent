package authz

import (
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
)

// decisionCache is a bounded, TTL'd cache of authorization decisions. It replaces
// the PoC's unbounded map (ADR-4): entries are LRU-evicted at a fixed capacity and
// carry an expiry, so long-lived processes with many distinct (subject,relation,
// object) triples cannot grow memory without bound.
//
// It also supports a bounded "grace" window: an entry that was ALLOWED can be
// served (as stale) after its TTL for up to `grace`, which lets the engine keep a
// working drive alive through a short policy-service outage without ever granting
// new access. A previously-denied entry is never graced.
type decisionCache struct {
	lru   *lru.Cache[string, cacheEntry]
	ttl   time.Duration
	grace time.Duration
	now   func() time.Time // injectable for tests
}

type cacheEntry struct {
	allow    bool
	storedAt time.Time
}

func newDecisionCache(size int, ttl, grace time.Duration) (*decisionCache, error) {
	c, err := lru.New[string, cacheEntry](size)
	if err != nil {
		return nil, err
	}
	return &decisionCache{lru: c, ttl: ttl, grace: grace, now: time.Now}, nil
}

type lookupResult int

const (
	miss    lookupResult = iota // not cached (or too old even for grace)
	fresh                       // cached and within TTL
	graceOK                     // expired but within grace AND was an allow
)

func (c *decisionCache) lookup(key string) (allow bool, res lookupResult) {
	e, ok := c.lru.Get(key)
	if !ok {
		return false, miss
	}
	age := c.now().Sub(e.storedAt)
	switch {
	case age <= c.ttl:
		return e.allow, fresh
	case e.allow && age <= c.ttl+c.grace:
		return true, graceOK
	default:
		return false, miss
	}
}

func (c *decisionCache) store(key string, allow bool) {
	c.lru.Add(key, cacheEntry{allow: allow, storedAt: c.now()})
}
