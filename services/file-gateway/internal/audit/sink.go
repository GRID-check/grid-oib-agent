// Package audit records one structured event per authorization decision. In a
// building-code / compliance context, "who accessed or was denied which document
// when" is itself a record worth keeping (ADR-6), so this is a first-class output
// of the gateway, not debug logging.
//
// This package is a leaf: it imports nothing from the rest of the gateway, so the
// authorization core can depend on it without creating an import cycle.
package audit

import (
	"context"
	"log/slog"
	"time"
)

// Source explains where a decision came from.
type Source string

const (
	SourceRemote Source = "remote" // fresh policy check
	SourceCache  Source = "cache"  // served from decision cache
	SourceGrace  Source = "grace"  // stale-allow during a policy outage (degraded)
)

// Decision is the immutable record of a single authorization decision.
type Decision struct {
	Time      time.Time
	Subject   string
	Relation  string
	Object    string
	Allow     bool
	Source    Source
	Reason    string
	LatencyMS float64
}

// Sink consumes decision records. Implementations must be safe for concurrent use.
type Sink interface {
	Record(ctx context.Context, d Decision)
}

// SlogSink writes decisions as structured JSON via slog. Default sink.
type SlogSink struct{ log *slog.Logger }

func NewSlogSink(l *slog.Logger) *SlogSink { return &SlogSink{log: l} }

func (s *SlogSink) Record(ctx context.Context, d Decision) {
	verb := "deny"
	if d.Allow {
		verb = "allow"
	}
	s.log.LogAttrs(ctx, slog.LevelInfo, "authz.decision",
		slog.String("decision", verb),
		slog.String("subject", d.Subject),
		slog.String("relation", d.Relation),
		slog.String("object", d.Object),
		slog.String("source", string(d.Source)),
		slog.String("reason", d.Reason),
		slog.Float64("latency_ms", d.LatencyMS),
	)
}

// NopSink discards records (useful in tests).
type NopSink struct{}

func (NopSink) Record(context.Context, Decision) {}
