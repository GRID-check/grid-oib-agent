// Command gateway is grid-nas-gateway: a file-protocol front (NFSv3 in phase 1)
// for S3-compatible storage that authorizes every file operation, per access,
// against WorkOS FGA. See internal/ for the ports-and-adapters layout.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	nfs "github.com/willscott/go-nfs"

	"gridnas/gateway/internal/audit"
	"gridnas/gateway/internal/authz"
	"gridnas/gateway/internal/config"
	"gridnas/gateway/internal/holds"
	"gridnas/gateway/internal/identity"
	"gridnas/gateway/internal/observability"
	"gridnas/gateway/internal/policy"
	protonfs "gridnas/gateway/internal/proto/nfs"
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
		"env", cfg.Env, "nfs", cfg.ListenNFS, "admin", cfg.ListenAdmin,
		"data", cfg.DataDir, "resolver", cfg.IdentityResolver,
		"policy_mode", cfg.PolicyMode, "shared_cache", cfg.RedisURL != "")

	// --- adapters (edges) ---
	metrics := observability.NewMetrics()
	policyClient, err := buildPolicyClient(cfg, log)
	if err != nil {
		log.Error("build policy client", "err", err)
		os.Exit(1)
	}
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
	guard := storage.NewGuard(backend, engine, buildHoldChecker(cfg, log))

	resolver, err := buildResolver(cfg)
	if err != nil {
		log.Error("build identity resolver", "err", err)
		os.Exit(1)
	}

	handler := protonfs.NewHandler(guard, resolver, log)

	// --- admin server: liveness, readiness, metrics ---
	var ready atomic.Bool
	admin := &http.Server{Addr: cfg.ListenAdmin, Handler: adminMux(&ready, backend, metrics, cfg)}
	go func() {
		if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("admin server", "err", err)
		}
	}()

	// --- WebDAV server (optional, additive to NFS) ---
	// A SECOND protocol front behind the SAME Guard: every WebDAV request is
	// authenticated per request and every file op authorized per file, proving the
	// authz core plugs behind identity-carrying HTTP. Disabled unless a listen
	// address is configured.
	var davSrv *http.Server
	if cfg.ListenWebDAV != "" {
		davResolver, err := buildWebDAVResolver(cfg)
		if err != nil {
			log.Error("build webdav resolver", "err", err)
			os.Exit(1)
		}
		davSrv = &http.Server{
			Addr:    cfg.ListenWebDAV,
			Handler: protowebdav.NewHandler(guard, davResolver, log),
		}
		go func() {
			log.Info("webdav listening", "addr", cfg.ListenWebDAV, "resolver", davResolver.Name())
			if err := davSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Error("webdav server", "err", err)
			}
		}()
	}

	// --- NFS server ---
	ln, err := net.Listen("tcp", cfg.ListenNFS)
	if err != nil {
		log.Error("listen nfs", "err", err)
		os.Exit(1)
	}
	log.Info("nfs listening", "addr", ln.Addr().String())
	ready.Store(true)

	serveErr := make(chan error, 1)
	go func() { serveErr <- nfs.Serve(ln, handler) }()

	// --- graceful shutdown ---
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-serveErr:
		log.Error("nfs server exited", "err", err)
	case <-ctx.Done():
		log.Info("shutdown signal received, draining")
	}
	ready.Store(false)
	_ = ln.Close()
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if davSrv != nil {
		_ = davSrv.Shutdown(shutCtx)
	}
	_ = admin.Shutdown(shutCtx)
	log.Info("stopped")
}

// buildPolicyClient selects the authorization source and wraps it with the
// shared Dragonfly decision cache (no-op if REDIS_URL is unset).
func buildPolicyClient(cfg config.Config, log *slog.Logger) (policy.Client, error) {
	switch cfg.PolicyMode {
	case "bff":
		// Delegate to the BFF — the single authz brain (WorkOS FGA + org membership).
		// The BFF ALREADY memoizes decisions in the shared Dragonfly cache AND
		// invalidates them on role change, so the gateway must NOT add its own L2
		// Dragonfly cache here: a second, differently-keyed copy would keep serving
		// stale allows after a revocation the BFF already cleared. The engine's
		// short in-process L1 (with grace) is the only gateway-side cache in bff mode.
		return policy.NewBFF(cfg.BFFEndpoint, cfg.InternalToken, cfg.PolicyTimeout), nil
	case "workos":
		// Direct-to-WorkOS: there is no BFF cache to share, so the gateway's own
		// shared L2 (Dragonfly) is useful here.
		inner := policy.NewWorkOS(cfg.PolicyEndpoint, cfg.PolicyAPIKey, cfg.PolicyTimeout)
		return policy.NewCaching(inner, cfg.RedisURL, cfg.SharedCacheTTL, log)
	default:
		return nil, errors.New("unsupported policy mode: " + cfg.PolicyMode)
	}
}

// buildHoldChecker selects the legal-hold gate for Guard.Remove. In bff mode the
// BFF owns `legal_holds`, so we delegate there (fail-closed: an unreachable BFF
// refuses deletes rather than destroying possibly-held bytes). In workos mode
// there is no hold source, so deletes are permitted with a warning — the same
// posture as the purger when no hold table is reachable.
func buildHoldChecker(cfg config.Config, log *slog.Logger) storage.HoldChecker {
	if cfg.PolicyMode == "bff" {
		return holds.NewBFF(cfg.BFFDeletableURL, cfg.InternalToken, cfg.PolicyTimeout)
	}
	log.Warn("legal-hold gate disabled: policy mode has no BFF legal_holds source; drive deletes are NOT hold-checked",
		"policy_mode", cfg.PolicyMode)
	return storage.AllowAllHolds{}
}

func buildResolver(cfg config.Config) (identity.Resolver, error) {
	switch cfg.IdentityResolver {
	case "dirpath":
		return identity.NewDirpathResolver(cfg.Env), nil
	// case "mounttoken", "kerberos", "smb": wired in a follow-up (signed mount
	// token → user+org; then NFSv4+Kerberos or SMB session for authenticated identity).
	default:
		return nil, errors.New("unsupported identity resolver: " + cfg.IdentityResolver)
	}
}

// buildWebDAVResolver selects the HTTP identity resolver for the WebDAV front.
// Only the dev-only header resolver exists today; config.Validate already refuses
// to enable WebDAV with it outside dev, and NewHeaderResolver fails closed as a
// second guard. Production identity (validated Bearer/WorkOS token or a signed
// mount token) is a follow-up that slots into the same HTTPResolver seam.
func buildWebDAVResolver(cfg config.Config) (protowebdav.HTTPResolver, error) {
	return protowebdav.NewHeaderResolver(cfg.Env)
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
		// Ready requires: NFS listener up, storage root reachable, AND (in bff
		// mode) the authorization brain reachable — every op fails closed without
		// it, so a gateway that can't reach the BFF must not report ready.
		// Dragonfly is intentionally NOT gated here: it is fail-open (ADR-0020).
		if !ready.Load() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		if _, err := backend.Stat("."); err != nil {
			http.Error(w, "storage unreachable: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		if cfg.PolicyMode == "bff" {
			if err := bffReachable(cfg.BFFEndpoint); err != nil {
				http.Error(w, "authz brain unreachable: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})
	mux.Handle("/metrics", promhttp.HandlerFor(m.Registry(), promhttp.HandlerOpts{}))
	return mux
}
