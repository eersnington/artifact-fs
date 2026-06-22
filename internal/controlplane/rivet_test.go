package controlplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRivetDesiredRepos(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/desired-repos" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Fatalf("method = %q", r.Method)
		}
		if got := r.Header.Get("authorization"); got != "Bearer test-token" {
			t.Fatalf("authorization = %q", got)
		}
		if got := r.URL.Query().Get("root"); got != "/state" {
			t.Fatalf("root query = %q", got)
		}
		if got := r.URL.Query().Get("mountRoot"); got != "/mnt" {
			t.Fatalf("mountRoot query = %q", got)
		}
		writeJSON(t, w, desiredReposResponse{Repos: []repoConfigWire{
			{
				ID:                     "repo-1",
				Name:                   "repo-1",
				RemoteURL:              "https://example.invalid/repo.git",
				RemoteURLSecretRef:     "secret/repo-1",
				Branch:                 "main",
				RefreshIntervalSeconds: 45,
				Enabled:                true,
			},
		}})
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "test-token", 0)
	repos, err := c.DesiredRepos(context.Background(), HostInfo{Root: "/state", MountRoot: "/mnt"})
	if err != nil {
		t.Fatalf("DesiredRepos returned error: %v", err)
	}
	if len(repos) != 1 {
		t.Fatalf("repo count = %d, want 1", len(repos))
	}
	repo := repos[0]
	if repo.ID != "repo-1" || repo.Name != "repo-1" || repo.Branch != "main" {
		t.Fatalf("unexpected repo: %#v", repo)
	}
	if repo.RemoteURLSecretRef != "secret/repo-1" {
		t.Fatalf("RemoteURLSecretRef = %q", repo.RemoteURLSecretRef)
	}
	if repo.RefreshInterval != 45*time.Second {
		t.Fatalf("RefreshInterval = %s, want 45s", repo.RefreshInterval)
	}
	if !repo.Enabled {
		t.Fatalf("Enabled = false, want true")
	}
}

func TestRivetRecordEventPostsJSON(t *testing.T) {
	eventAt := time.Date(2026, 6, 22, 12, 0, 0, 0, time.UTC)
	seen := make(chan runtimeEventWire, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/events" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q", r.Method)
		}
		if got := r.Header.Get("content-type"); got != "application/json" {
			t.Fatalf("content-type = %q", got)
		}
		var event runtimeEventWire
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			t.Fatalf("decode event: %v", err)
		}
		seen <- event
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "", 0)
	err := c.RecordEvent(context.Background(), RuntimeEvent{
		ID:         "event-1",
		RepoID:     "repo-1",
		RepoName:   "repo-1",
		Kind:       EventMountReady,
		At:         eventAt,
		HeadOID:    "abc123",
		HeadRef:    "main",
		Generation: 7,
	})
	if err != nil {
		t.Fatalf("RecordEvent returned error: %v", err)
	}
	select {
	case event := <-seen:
		if event.ID != "event-1" || event.RepoID != "repo-1" || event.Kind != string(EventMountReady) {
			t.Fatalf("unexpected event: %#v", event)
		}
		if !event.At.Equal(eventAt) {
			t.Fatalf("At = %v, want %v", event.At, eventAt)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for event")
	}
}

func TestRivetWarmupPlan(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/warmup-plan" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		var req warmupRequestWire
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode warmup request: %v", err)
		}
		if req.RepoID != "repo-1" || req.Generation != 9 || req.MaxFiles != 20 {
			t.Fatalf("unexpected warmup request: %#v", req)
		}
		writeJSON(t, w, warmupPlanWire{Tasks: []hydrationTaskWire{
			{RepoID: "repo-1", Path: "README.md", ObjectOID: "abc123", Priority: 700, Reason: "actor warmup"},
		}})
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "", 0)
	plan, err := c.WarmupPlan(context.Background(), WarmupRequest{
		RepoID:     "repo-1",
		RepoName:   "repo-1",
		HeadOID:    "head",
		HeadRef:    "main",
		Generation: 9,
		MaxFiles:   20,
	})
	if err != nil {
		t.Fatalf("WarmupPlan returned error: %v", err)
	}
	if len(plan.Tasks) != 1 {
		t.Fatalf("task count = %d, want 1", len(plan.Tasks))
	}
	task := plan.Tasks[0]
	if task.RepoID != "repo-1" || task.Path != "README.md" || task.ObjectOID != "abc123" || task.Priority != 700 {
		t.Fatalf("unexpected task: %#v", task)
	}
}

func TestRivetCredentialEnv(t *testing.T) {
	expiresAt := time.Date(2026, 6, 22, 13, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/credential-env" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		var req credentialRequestWire
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode credential request: %v", err)
		}
		if req.SecretRef != "secret/repo-1" {
			t.Fatalf("SecretRef = %q", req.SecretRef)
		}
		writeJSON(t, w, credentialEnvWire{
			SafeRemoteURL: "https://example.invalid/repo.git",
			Env:           []string{"GIT_TERMINAL_PROMPT=0"},
			ExpiresAt:     expiresAt,
		})
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "", 0)
	cred, err := c.CredentialEnv(context.Background(), CredentialRequest{
		RepoID:    "repo-1",
		RepoName:  "repo-1",
		RemoteURL: "https://example.invalid/repo.git",
		SecretRef: "secret/repo-1",
	})
	if err != nil {
		t.Fatalf("CredentialEnv returned error: %v", err)
	}
	if cred.SafeRemoteURL != "https://example.invalid/repo.git" || len(cred.Env) != 1 || !cred.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected credential env: %#v", cred)
	}
}

func TestRivetHTTPErrorRedactsResponseBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "clone failed https://user:secret@example.invalid/repo.git token=abc123", http.StatusBadGateway)
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "", 0)
	_, err := c.DesiredRepos(context.Background(), HostInfo{})
	if err == nil {
		t.Fatalf("DesiredRepos returned nil error")
	}
	msg := err.Error()
	if strings.Contains(msg, "secret") || strings.Contains(msg, "abc123") {
		t.Fatalf("error leaked secret material: %q", msg)
	}
	if !strings.Contains(msg, "REDACTED") {
		t.Fatalf("error did not include redacted marker: %q", msg)
	}
}

func TestRivetRequestTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(250 * time.Millisecond)
		writeJSON(t, w, desiredReposResponse{})
	}))
	defer server.Close()

	c := newTestRivet(t, server.URL, "", 10*time.Millisecond)
	start := time.Now()
	_, err := c.DesiredRepos(context.Background(), HostInfo{})
	if err == nil {
		t.Fatalf("DesiredRepos returned nil error")
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("request did not honor timeout, elapsed %s", elapsed)
	}
}

func TestNewRivetRejectsInvalidURL(t *testing.T) {
	if _, err := NewRivet(RivetOptions{}); err == nil {
		t.Fatalf("NewRivet accepted empty URL")
	}
	if _, err := NewRivet(RivetOptions{BaseURL: "127.0.0.1:8788"}); err == nil {
		t.Fatalf("NewRivet accepted URL without scheme")
	}
}

func newTestRivet(t *testing.T, baseURL string, token string, timeout time.Duration) *RivetCoordinator {
	t.Helper()
	c, err := NewRivet(RivetOptions{BaseURL: baseURL, Token: token, Timeout: timeout})
	if err != nil {
		t.Fatalf("NewRivet returned error: %v", err)
	}
	return c
}

func writeJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
