package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/cloudflare/artifact-fs/internal/controlplane"
	"github.com/cloudflare/artifact-fs/internal/model"
)

type fakeCoordinator struct {
	desired     []model.RepoConfig
	desiredErr  error
	events      chan controlplane.RuntimeEvent
	recordDelay time.Duration
	recordErr   error
	closed      bool
}

func (f *fakeCoordinator) DesiredRepos(context.Context, controlplane.HostInfo) ([]model.RepoConfig, error) {
	if f.desiredErr != nil {
		return nil, f.desiredErr
	}
	return f.desired, nil
}

func (f *fakeCoordinator) RecordEvent(ctx context.Context, event controlplane.RuntimeEvent) error {
	if f.recordDelay > 0 {
		select {
		case <-time.After(f.recordDelay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if f.recordErr != nil {
		return f.recordErr
	}
	if f.events != nil {
		select {
		case f.events <- event:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (f *fakeCoordinator) WarmupPlan(context.Context, controlplane.WarmupRequest) (controlplane.WarmupPlan, error) {
	return controlplane.WarmupPlan{}, nil
}

func (f *fakeCoordinator) CredentialEnv(context.Context, controlplane.CredentialRequest) (controlplane.CredentialEnv, error) {
	return controlplane.CredentialEnv{}, nil
}

func (f *fakeCoordinator) Close() error {
	f.closed = true
	return nil
}

func TestSyncDesiredReposAddsReposToLocalRegistry(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()

	mountRoot := filepath.Join(t.TempDir(), "mnt")
	svc.SetMountRoot(mountRoot)
	svc.SetCoordinator(&fakeCoordinator{desired: []model.RepoConfig{
		{
			Name:            "actor-repo",
			ID:              "actor-repo",
			RemoteURL:       "https://user:secret@example.invalid/repo.git",
			Branch:          "main",
			RefreshInterval: time.Minute,
			Enabled:         true,
		},
	}})

	svc.syncDesiredRepos(ctx)

	repo, err := svc.registry.GetRepo(ctx, "actor-repo")
	if err != nil {
		t.Fatalf("GetRepo returned error: %v", err)
	}
	if repo.MountPath != filepath.Join(mountRoot, "actor-repo") {
		t.Fatalf("MountPath = %q, want under %q", repo.MountPath, mountRoot)
	}
	if repo.RemoteURLRedacted == "" || repo.RemoteURLRedacted == "https://user:secret@example.invalid/repo.git" {
		t.Fatalf("RemoteURLRedacted = %q, want redacted value", repo.RemoteURLRedacted)
	}
	if !repo.Enabled {
		t.Fatalf("Enabled = false, want true")
	}
}

func TestSyncDesiredReposFailureKeepsLocalRegistryUsable(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()

	local := model.RepoConfig{
		Name:            "local-repo",
		ID:              "local-repo",
		RemoteURL:       "https://example.invalid/local.git",
		Branch:          "main",
		RefreshInterval: time.Minute,
		Enabled:         true,
	}
	svc.fillPaths(&local)
	if err := svc.registry.AddRepo(ctx, local); err != nil {
		t.Fatalf("AddRepo returned error: %v", err)
	}
	svc.SetCoordinator(&fakeCoordinator{desiredErr: errors.New("actor unavailable")})

	svc.syncDesiredRepos(ctx)

	if _, err := svc.registry.GetRepo(ctx, "local-repo"); err != nil {
		t.Fatalf("local registry entry was not preserved: %v", err)
	}
	if _, err := svc.registry.GetRepo(ctx, "actor-repo"); err == nil {
		t.Fatalf("unexpected actor-repo in local registry after desired repo failure")
	}
}

func TestRecordEventIsBestEffortAndPopulatesDefaults(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()

	events := make(chan controlplane.RuntimeEvent, 1)
	svc.SetCoordinator(&fakeCoordinator{events: events})

	svc.recordEvent(controlplane.RuntimeEvent{
		RepoID:   "repo",
		RepoName: "repo",
		Kind:     controlplane.EventMountReady,
	})

	select {
	case event := <-events:
		if event.ID == "" {
			t.Fatalf("event ID was not populated")
		}
		if event.At.IsZero() {
			t.Fatalf("event At was not populated")
		}
		if event.Kind != controlplane.EventMountReady {
			t.Fatalf("event Kind = %q, want %q", event.Kind, controlplane.EventMountReady)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for event")
	}
}

func TestRecordEventDoesNotBlockOnSlowCoordinator(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	svc.SetCoordinator(&fakeCoordinator{recordDelay: time.Second})

	start := time.Now()
	svc.recordEvent(controlplane.RuntimeEvent{RepoID: "repo", RepoName: "repo", Kind: controlplane.EventMountReady})
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		t.Fatalf("recordEvent blocked for %s", elapsed)
	}
}

func newTestService(t *testing.T, ctx context.Context) *Service {
	t.Helper()
	svc, err := New(ctx, t.TempDir(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	return svc
}
