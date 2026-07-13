package policy

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// WorkOS is the production Client. It targets the WorkOS FGA "Check" API shape:
//
//	POST {endpoint}  {subject, relation, object} -> {allow: bool}
//
// In production `endpoint` is the WorkOS FGA Check endpoint and requests carry the
// WorkOS API key. In dev/CI the same adapter points at the in-cluster mock, which
// speaks the identical shape -- so nothing but config changes between them.
//
// Where the real WorkOS SDK call slots in (replacing the raw POST):
//
//	res, _ := workosClient.FGA.Check(ctx, fga.CheckOptions{Checks: []fga.WarrantCheck{{
//	    Subject:  fga.Subject{ResourceType: "user", ResourceID: subject},
//	    Relation: relation,
//	    Object:   fga.Object{ResourceType: "document", ResourceID: object},
//	}}})
//	return res.IsAuthorized(), nil
type WorkOS struct {
	endpoint string
	apiKey   string
	http     *http.Client
}

func NewWorkOS(endpoint, apiKey string, timeout time.Duration) *WorkOS {
	return &WorkOS{
		endpoint: endpoint,
		apiKey:   apiKey,
		http:     &http.Client{Timeout: timeout},
	}
}

type checkReq struct {
	Subject  string `json:"subject"`
	Relation string `json:"relation"`
	Object   string `json:"object"`
}

type checkResp struct {
	Allow bool `json:"allow"`
}

func (w *WorkOS) Check(ctx context.Context, subject, relation, object string) (bool, error) {
	body, _ := json.Marshal(checkReq{Subject: subject, Relation: relation, Object: object})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	if w.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+w.apiKey)
	}
	resp, err := w.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("policy check: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("policy check: status %d", resp.StatusCode)
	}
	var out checkResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return false, fmt.Errorf("policy check decode: %w", err)
	}
	return out.Allow, nil
}

// BatchCheck issues checks concurrently, bounded, returning per-object results.
// A single upstream error fails the whole batch (the caller decides the fallback).
func (w *WorkOS) BatchCheck(ctx context.Context, subject, relation string, objects []string) (map[string]bool, error) {
	type res struct {
		obj   string
		allow bool
		err   error
	}
	out := make(map[string]bool, len(objects))
	ch := make(chan res, len(objects))
	sem := make(chan struct{}, 8) // bound concurrency to the policy service
	for _, o := range objects {
		go func(o string) {
			sem <- struct{}{}
			defer func() { <-sem }()
			a, err := w.Check(ctx, subject, relation, o)
			ch <- res{o, a, err}
		}(o)
	}
	for range objects {
		r := <-ch
		if r.err != nil {
			return nil, r.err
		}
		out[r.obj] = r.allow
	}
	return out, nil
}
