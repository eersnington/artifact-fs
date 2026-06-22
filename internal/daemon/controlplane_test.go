package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cloudflare/artifact-fs/internal/controlplane"
	"github.com/cloudflare/artifact-fs/internal/fusefs"
	"github.com/cloudflare/artifact-fs/internal/hydrator"
	"github.com/cloudflare/artifact-fs/internal/model"
	"github.com/cloudflare/artifact-fs/internal/overlay"
	"github.com/cloudflare/artifact-fs/internal/snapshot"
)

type fakeCoordinator struct {
	desired       []model.RepoConfig
	desiredErr    error
	warmupPlan    controlplane.WarmupPlan
	warmupErr     error
	credential    controlplane.CredentialEnv
	credentialErr error
	events        chan controlplane.RuntimeEvent
	recordDelay   time.Duration
	recordErr     error
	closed        bool
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
	if f.warmupErr != nil {
		return controlplane.WarmupPlan{}, f.warmupErr
	}
	return f.warmupPlan, nil
}

func (f *fakeCoordinator) CredentialEnv(context.Context, controlplane.CredentialRequest) (controlplane.CredentialEnv, error) {
	if f.credentialErr != nil {
		return controlplane.CredentialEnv{}, f.credentialErr
	}
	return f.credential, nil
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

func TestWarmupAfterMountEnqueuesValidatedTasks(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	events := make(chan controlplane.RuntimeEvent, 4)
	svc.SetCoordinator(&fakeCoordinator{
		events: events,
		warmupPlan: controlplane.WarmupPlan{Tasks: []model.HydrationTask{
			{RepoID: "repo", Path: "/README.md", ObjectOID: "readme-oid", Priority: 900, Reason: "test"},
			{RepoID: "repo", Path: "missing.txt", ObjectOID: "missing-oid", Priority: 900},
			{RepoID: "other", Path: "src/main.go", ObjectOID: "main-oid", Priority: 900},
			{RepoID: "repo", Path: "src/main.go", ObjectOID: "wrong-oid", Priority: 900},
		}},
	})
	rt := newWarmupRuntime(t, ctx)

	svc.warmupAfterMount(ctx, rt)

	if depth := rt.hydrator.QueueDepth("repo"); depth != 1 {
		t.Fatalf("QueueDepth = %d, want 1", depth)
	}
	select {
	case event := <-events:
		if event.Kind != controlplane.EventHydrationQueued {
			t.Fatalf("event Kind = %q, want %q", event.Kind, controlplane.EventHydrationQueued)
		}
		if event.Path != "README.md" || event.ObjectOID != "readme-oid" || event.Generation != 1 {
			t.Fatalf("unexpected queued event: %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for hydration queued event")
	}
}

func TestWarmupAfterMountContinuesWhenCoordinatorFails(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	svc.SetCoordinator(&fakeCoordinator{warmupErr: errors.New("actor unavailable")})
	rt := newWarmupRuntime(t, ctx)

	svc.warmupAfterMount(ctx, rt)

	if depth := rt.hydrator.QueueDepth("repo"); depth != 0 {
		t.Fatalf("QueueDepth = %d, want 0", depth)
	}
}

func TestRepoWithCredentialLeaseUsesCoordinator(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	svc.SetCoordinator(&fakeCoordinator{credential: controlplane.CredentialEnv{
		SafeRemoteURL: "https://example.invalid/repo.git",
		Env:           []string{"GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_COUNT=1"},
	}})

	cfg, err := svc.repoWithCredentialLease(ctx, model.RepoConfig{
		ID:                 "repo",
		Name:               "repo",
		RemoteURLSecretRef: "secret/repo",
	})
	if err != nil {
		t.Fatalf("repoWithCredentialLease returned error: %v", err)
	}
	if cfg.GitSafeRemoteURL != "https://example.invalid/repo.git" {
		t.Fatalf("GitSafeRemoteURL = %q", cfg.GitSafeRemoteURL)
	}
	if len(cfg.GitCredentialEnv) != 2 {
		t.Fatalf("GitCredentialEnv len = %d, want 2", len(cfg.GitCredentialEnv))
	}
}

func TestRepoWithCredentialLeaseFailsWithoutSafeURL(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	svc.SetCoordinator(&fakeCoordinator{credential: controlplane.CredentialEnv{Env: []string{"GIT_TERMINAL_PROMPT=0"}}})

	_, err := svc.repoWithCredentialLease(ctx, model.RepoConfig{ID: "repo", Name: "repo", RemoteURLSecretRef: "secret/repo"})
	if err == nil {
		t.Fatalf("repoWithCredentialLease returned nil error")
	}
	if !strings.Contains(err.Error(), "safe remote URL") {
		t.Fatalf("error %q did not explain missing safe URL", err.Error())
	}
}

func TestRuntimeEventIDUsesStableKeys(t *testing.T) {
	queued := runtimeEventID(controlplane.RuntimeEvent{RepoID: "repo", Kind: controlplane.EventHydrationQueued, Generation: 3, ObjectOID: "abc"})
	if queued != "hydration.queued/repo/3/abc" {
		t.Fatalf("queued event ID = %q", queued)
	}
	status := runtimeEventID(controlplane.RuntimeEvent{RepoID: "repo", Kind: controlplane.EventStatusObserved, At: time.Now()})
	if status != "status.observed/repo" {
		t.Fatalf("status event ID = %q", status)
	}
}

func TestStatusRecordsObservedAndDirtyTransitions(t *testing.T) {
	ctx := context.Background()
	svc := newTestService(t, ctx)
	defer svc.Close()
	events := make(chan controlplane.RuntimeEvent, 8)
	svc.SetCoordinator(&fakeCoordinator{events: events})
	rt := newStatusRuntime(t, ctx, svc)

	if _, err := rt.overlay.CreateFile(ctx, "dirty.txt", 0o644); err != nil {
		t.Fatalf("CreateFile returned error: %v", err)
	}
	if _, err := svc.Status(ctx, rt.cfg.Name); err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	got := collectEvents(t, events, 2)
	if got[controlplane.EventOverlayDirty].ID != "overlay.dirty/repo" {
		t.Fatalf("dirty event = %#v", got[controlplane.EventOverlayDirty])
	}
	if got[controlplane.EventStatusObserved].ID != "status.observed/repo" {
		t.Fatalf("status event = %#v", got[controlplane.EventStatusObserved])
	}

	if err := rt.overlay.Remove(ctx, "dirty.txt"); err != nil {
		t.Fatalf("Remove returned error: %v", err)
	}
	if _, err := svc.Status(ctx, rt.cfg.Name); err != nil {
		t.Fatalf("Status returned error: %v", err)
	}
	got = collectEvents(t, events, 2)
	if got[controlplane.EventOverlayClean].ID != "overlay.clean/repo" {
		t.Fatalf("clean event = %#v", got[controlplane.EventOverlayClean])
	}
	if got[controlplane.EventStatusObserved].ID != "status.observed/repo" {
		t.Fatalf("status event = %#v", got[controlplane.EventStatusObserved])
	}
}

func newStatusRuntime(t *testing.T, ctx context.Context, svc *Service) *repoRuntime {
	t.Helper()
	cfg := model.RepoConfig{
		ID:                "repo",
		Name:              "repo",
		MountRoot:         filepath.Join(t.TempDir(), "mnt"),
		RemoteURL:         "https://example.invalid/repo.git",
		RemoteURLRedacted: "https://example.invalid/repo.git",
		Branch:            "main",
		RefreshInterval:   time.Minute,
		Enabled:           true,
	}
	svc.fillPaths(&cfg)
	if err := svc.registry.AddRepo(ctx, cfg); err != nil {
		t.Fatalf("AddRepo returned error: %v", err)
	}
	ov, err := overlay.New(ctx, cfg)
	if err != nil {
		t.Fatalf("overlay.New returned error: %v", err)
	}
	snap, err := snapshot.New(ctx, cfg.MetaDBPath)
	if err != nil {
		t.Fatalf("snapshot.New returned error: %v", err)
	}
	rt := &repoRuntime{
		cfg:      cfg,
		snapshot: snap,
		overlay:  ov,
		state:    newRuntimeState("repo", "head-oid", "main", 1),
	}
	svc.mu.Lock()
	svc.running[cfg.ID] = rt
	svc.mu.Unlock()
	return rt
}

func collectEvents(t *testing.T, events <-chan controlplane.RuntimeEvent, count int) map[controlplane.RuntimeEventKind]controlplane.RuntimeEvent {
	t.Helper()
	out := map[controlplane.RuntimeEventKind]controlplane.RuntimeEvent{}
	deadline := time.After(time.Second)
	for len(out) < count {
		select {
		case event := <-events:
			out[event.Kind] = event
		case <-deadline:
			t.Fatalf("timed out waiting for events, got %v", out)
		}
	}
	return out
}

func newWarmupRuntime(t *testing.T, ctx context.Context) *repoRuntime {
	t.Helper()
	snap, err := snapshot.New(ctx, filepath.Join(t.TempDir(), "snap.sqlite"))
	if err != nil {
		t.Fatalf("snapshot.New returned error: %v", err)
	}
	t.Cleanup(func() { snap.Close() })
	gen, err := snap.PublishGeneration(ctx, "head-oid", "main", []model.BaseNode{
		{RepoID: "repo", Path: ".", Type: "dir", Mode: 0o755, SizeState: "known"},
		{RepoID: "repo", Path: "README.md", Type: "file", Mode: 0o644, ObjectOID: "readme-oid", SizeState: "known", SizeBytes: 10},
		{RepoID: "repo", Path: "src", Type: "dir", Mode: 0o755, SizeState: "known"},
		{RepoID: "repo", Path: "src/main.go", Type: "file", Mode: 0o644, ObjectOID: "main-oid", SizeState: "known", SizeBytes: 20},
	})
	if err != nil {
		t.Fatalf("PublishGeneration returned error: %v", err)
	}
	resolver := &fusefs.Resolver{Snapshot: snap}
	resolver.SetGeneration(gen)
	return &repoRuntime{
		cfg:      model.RepoConfig{ID: "repo", Name: "repo"},
		snapshot: snap,
		hydrator: hydrator.New(nil),
		resolver: resolver,
		state:    newRuntimeState("repo", "head-oid", "main", gen),
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
