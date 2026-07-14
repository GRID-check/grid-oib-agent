// Command gateway is the Grid file-gateway: a WebDAV front for S3-compatible
// storage that authorizes every file operation, per access, against WorkOS FGA
// (via the BFF, the single authz brain). Mount identity is an SSO-brokered
// device credential (ADR-0025). See internal/ for the ports-and-adapters
// layout; other protocol fronts (SMB/Kerberos, NFSv4) slot in behind the same
// Guard without touching the authorization core (ADR-0024).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"gridnas/gateway/internal/audit"
	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/config"
	"gridnas/gateway/internal/holds"
	"gridnas/gateway/internal/observability"
	"gridnas/gateway/internal/policy"
	protowebdav "gridnas/gateway/internal/proto/webdav"
	"gridnas/gateway/internal/storage"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := config.Load()
	if err := cfg.Validate(); err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(2)
	}
	log.Info("starting grid-file-gateway",
		"env", cfg.Env, "webdav", cfg.ListenWebDAV, "admin", cfg.ListenAdmin,
		"data", cfg.DataDir, "webdav_identity", cfg.WebDAVIdentity)

	// --- adapters (edges) ---
	// The BFF is the single authz brain (WorkOS FGA + org membership); it already
	// memoizes decisions in the shared Dragonfly cache AND invalidates them on
	// role change, so the gateway adds no cache of its own beyond the engine's
	// short in-process L1 (a second, differently-keyed copy would keep serving
	// stale allows after a revocation the BFF already cleared).
	metrics := observability.NewMetrics()
	policyClient := policy.NewBFF(cfg.BFFEndpoint, cfg.InternalToken, cfg.PolicyTimeout)
	sink := audit.NewSlogSink(log)

	engine, err := authz.New(policyClient, sink, metrics, authz.Config{
		CacheSize:  cfg.CacheSize,
		CacheTTL:   cfg.CacheTTL,
		CacheGrace: cfg.CacheGrace,
	})
	if err != nil {
		log.Error("build authz engine", "err", err)
		os.Exit(1)
	}

	backend := storage.NewBillyFUSEBackend(cfg.DataDir)
	// Legal-hold gate for Guard.Remove (ADR-0024 §3): the BFF owns `legal_holds`;
	// fail-closed, so an unreachable BFF refuses deletes rather than destroying
	// possibly-held bytes.
	guard := storage.NewGuard(backend, engine,
		holds.NewBFF(cfg.BFFDeletableURL, cfg.InternalToken, cfg.PolicyTimeout))

	davResolver, err := buildWebDAVResolver(cfg)
	if err != nil {
		log.Error("build webdav resolver", "err", err)
		os.Exit(1)
	}

	// --- admin server: liveness, readiness, metrics ---
	var ready atomic.Bool
	admin := &http.Server{Addr: cfg.ListenAdmin, Handler: adminMux(&ready, backend, metrics, cfg)}
	go func() {
		if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("admin server", "err", err)
		}
	}()

	// --- WebDAV server (the drive) ---
	// Every request is authenticated per request (401 + Basic challenge pops the
	// native macOS/Windows dialog) and every file op is authorized per file
	// through the Guard.
	davSrv := &http.Server{
		Addr:    cfg.ListenWebDAV,
		Handler: protowebdav.NewHandler(guard, davResolver, log),
	}
	serveErr := make(chan error, 1)
	go func() {
		log.Info("webdav listening", "addr", cfg.ListenWebDAV, "resolver", davResolver.Name())
		err := davSrv.ListenAndServe()
		if !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
		}
	}()
	ready.Store(true)

	// --- graceful shutdown ---
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErr:
		log.Error("webdav server exited", "err", err)
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	}
	ready.Store(false)
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = davSrv.Shutdown(shutCtx)
	_ = admin.Shutdown(shutCtx)
	log.Info("stopped")
}

// buildWebDAVResolver selects the HTTP identity resolver for the WebDAV front
// (kept in lockstep with config.Validate):
//
//	header — dev-only X-Grid-* headers (spoofable; NewHeaderResolver also
//	         refuses outside dev as defence in depth).
//	basic  — PRODUCTION: WebDAV Basic credentials verified against the BFF
//	         mount-auth endpoint. The credential is minted inside a WorkOS-SSO'd
//	         web session (ADR-0025); every file op is still FGA-authorized.
func buildWebDAVResolver(cfg config.Config) (protowebdav.HTTPResolver, error) {
	switch cfg.WebDAVIdentity {
	case "header":
		return protowebdav.NewHeaderResolver(cfg.Env)
	case "basic":
		return protowebdav.NewBasicResolver(cfg.BFFMountAuthURL, cfg.InternalToken, cfg.Env, cfg.PolicyTimeout), nil
	default:
		return nil, errors.New("unsupported webdav identity: " + cfg.WebDAVIdentity)
	}
}

// bffReachable does a shallow GET to the BFF authz endpoint. It is POST-only, so
// any HTTP response (even 405) proves reachability; only a transport error means
// the authorization brain is down.
func bffReachable(endpoint string) error {
	client := &http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := client.Get(endpoint)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	return nil
}

func adminMux(ready *atomic.Bool, backend storage.Backend, m *observability.Metrics, cfg config.Config) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		// Ready requires: WebDAV listener up, storage root reachable, AND the
		// authorization brain reachable — every op fails closed without it, so a
		// gateway that can't reach the BFF must not report ready. Dragonfly is
		// intentionally NOT gated here: it is fail-open (ADR-0020).
		if !ready.Load() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		if _, err := backend.Stat("."); err != nil {
			http.Error(w, "storage unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		if err := bffReachable(cfg.BFFEndpoint); err != nil {
			http.Error(w, "authz brain unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.Handle("/metrics", promhttp.HandlerFor(m.Registry(), promhttp.HandlerOpts{}))
	return mux
}
