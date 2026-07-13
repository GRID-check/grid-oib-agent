package policy

import (
	"context"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Caching wraps a policy.Client with a shared, Redis-protocol decision cache.
//
// This is the SAME Dragonfly instance the BFF uses for its hot-path lookups
// (ADR-0020, which explicitly anticipates "FGA check memoization (short TTL)" as
// a tenant). Reusing it — rather than a per-process in-memory map — makes
// decisions consistent across gateway replicas and across the web app, and is
// clean reuse: FGA decisions are reconstructible, JSON-tiny booleans, safe to
// evict. Keys are namespaced `fga:<subject>|<relation>|<object>`.
//
// The gateway's authz.Engine keeps its own in-process L1 (with grace +
// singleflight) in front of this L2, so a Dragonfly blip degrades to a direct
// upstream call and never takes a request down.
type Caching struct {
	inner  Client
	rdb    *redis.Client
	ttl    time.Duration
	prefix string
	log    *slog.Logger
}

// NewCaching returns a caching wrapper. If redisURL is empty it returns inner
// unchanged (the engine's in-process cache still applies).
func NewCaching(inner Client, redisURL string, ttl time.Duration, log *slog.Logger) (Client, error) {
	if redisURL == "" {
		return inner, nil
	}
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	// Tight timeouts: a cache must never hang a file operation.
	opt.DialTimeout = 500 * time.Millisecond
	opt.ReadTimeout = 300 * time.Millisecond
	opt.WriteTimeout = 300 * time.Millisecond
	opt.MaxRetries = 1
	return &Caching{
		inner:  inner,
		rdb:    redis.NewClient(opt),
		ttl:    ttl,
		prefix: "fga:",
		log:    log,
	}, nil
}

func (c *Caching) key(subject Subject, relation, object string) string {
	return c.prefix + subject.OrgID + "|" + subject.ID + "|" + relation + "|" + object
}

func (c *Caching) Check(ctx context.Context, subject Subject, relation, object string) (bool, error) {
	k := c.key(subject, relation, object)
	if v, err := c.rdb.Get(ctx, k).Result(); err == nil {
		return v == "1", nil
	} else if err != redis.Nil {
		// Cache unavailable — degrade to the upstream, don't fail the request.
		c.log.Warn("fga cache read failed; bypassing", "err", err)
	}

	allow, err := c.inner.Check(ctx, subject, relation, object)
	if err != nil {
		return false, err
	}
	c.store(ctx, k, allow)
	return allow, nil
}

func (c *Caching) BatchCheck(ctx context.Context, subject Subject, relation string, objects []string) (map[string]bool, error) {
	out := make(map[string]bool, len(objects))
	var missing []string

	// Try the cache for each object; collect misses.
	if len(objects) > 0 {
		keys := make([]string, len(objects))
		for i, o := range objects {
			keys[i] = c.key(subject, relation, o)
		}
		vals, err := c.rdb.MGet(ctx, keys...).Result()
		if err != nil {
			c.log.Warn("fga cache mget failed; bypassing", "err", err)
			missing = objects
		} else {
			for i, o := range objects {
				if s, ok := vals[i].(string); ok {
					out[o] = s == "1"
				} else {
					missing = append(missing, o)
				}
			}
		}
	}

	if len(missing) > 0 {
		res, err := c.inner.BatchCheck(ctx, subject, relation, missing)
		if err != nil {
			return nil, err
		}
		for o, allow := range res {
			out[o] = allow
			c.store(ctx, c.key(subject, relation, o), allow)
		}
	}
	return out, nil
}

func (c *Caching) store(ctx context.Context, key string, allow bool) {
	v := "0"
	if allow {
		v = "1"
	}
	if err := c.rdb.Set(ctx, key, v, c.ttl).Err(); err != nil {
		c.log.Warn("fga cache write failed", "err", err)
	}
}
