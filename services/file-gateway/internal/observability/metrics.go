// Package observability provides Prometheus metrics for the gateway. The Metrics
// type satisfies authz.Metrics, so the core emits metrics without importing
// Prometheus (ADR-6).
package observability

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"gridnas/gateway/internal/audit"
)

type Metrics struct {
	checks       *prometheus.CounterVec
	latency      *prometheus.HistogramVec
	degraded     prometheus.Gauge
	policyErrors prometheus.Counter
	reg          *prometheus.Registry
}

func NewMetrics() *Metrics {
	reg := prometheus.NewRegistry()
	reg.MustRegister(prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	f := promauto.With(reg)
	return &Metrics{
		reg: reg,
		checks: f.NewCounterVec(prometheus.CounterOpts{
			Name: "authz_checks_total",
			Help: "Authorization checks by source and decision.",
		}, []string{"source", "decision"}),
		latency: f.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "authz_check_latency_seconds",
			Help:    "Authorization check latency by source.",
			Buckets: prometheus.DefBuckets,
		}, []string{"source"}),
		degraded: f.NewGauge(prometheus.GaugeOpts{
			Name: "authz_degraded",
			Help: "1 when serving stale-allow decisions during a policy outage.",
		}),
		policyErrors: f.NewCounter(prometheus.CounterOpts{
			Name: "authz_policy_errors_total",
			Help: "Upstream policy-check failures (an availability signal, distinct from a legitimate deny).",
		}),
	}
}

// PolicyError satisfies authz.Metrics.
func (m *Metrics) PolicyError() { m.policyErrors.Inc() }

func (m *Metrics) Registry() *prometheus.Registry { return m.reg }

// CheckObserved satisfies authz.Metrics.
func (m *Metrics) CheckObserved(source audit.Source, allow bool, latency time.Duration) {
	decision := "deny"
	if allow {
		decision = "allow"
	}
	m.checks.WithLabelValues(string(source), decision).Inc()
	m.latency.WithLabelValues(string(source)).Observe(latency.Seconds())
}

// Degraded satisfies authz.Metrics.
func (m *Metrics) Degraded(active bool) {
	if active {
		m.degraded.Set(1)
	} else {
		m.degraded.Set(0)
	}
}
