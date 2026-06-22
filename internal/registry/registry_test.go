package registry

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/cloudflare/artifact-fs/internal/model"
)

func TestRepoSecretRefRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	err := store.AddRepo(ctx, model.RepoConfig{
		ID:                 "repo",
		Name:               "repo",
		MountRoot:          "/mnt",
		MountPath:          "/mnt/repo",
		RemoteURLRedacted:  "https://example.invalid/repo.git",
		RemoteURLSecretRef: "secret/repo",
		Branch:             "main",
		RefreshInterval:    time.Minute,
		GitDir:             "/state/git",
		OverlayDir:         "/state/overlay",
		BlobCacheDir:       "/state/cache",
		MetaDBPath:         "/state/meta.sqlite",
		OverlayDBPath:      "/state/overlay.sqlite",
		Enabled:            true,
	})
	if err != nil {
		t.Fatalf("AddRepo returned error: %v", err)
	}

	repo, err := store.GetRepo(ctx, "repo")
	if err != nil {
		t.Fatalf("GetRepo returned error: %v", err)
	}
	if repo.RemoteURLSecretRef != "secret/repo" {
		t.Fatalf("RemoteURLSecretRef = %q, want secret/repo", repo.RemoteURLSecretRef)
	}
	if repo.RemoteURL != "" {
		t.Fatalf("RemoteURL = %q, want empty when secret ref is present", repo.RemoteURL)
	}
}

func TestPublicRemoteURLIsReconstructedFromRedactedURL(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	err := store.AddRepo(ctx, model.RepoConfig{
		ID:                "repo",
		Name:              "repo",
		MountRoot:         "/mnt",
		MountPath:         "/mnt/repo",
		RemoteURLRedacted: "https://example.invalid/repo.git",
		Branch:            "main",
		RefreshInterval:   time.Minute,
		GitDir:            "/state/git",
		OverlayDir:        "/state/overlay",
		BlobCacheDir:      "/state/cache",
		MetaDBPath:        "/state/meta.sqlite",
		OverlayDBPath:     "/state/overlay.sqlite",
		Enabled:           true,
	})
	if err != nil {
		t.Fatalf("AddRepo returned error: %v", err)
	}

	repo, err := store.GetRepo(ctx, "repo")
	if err != nil {
		t.Fatalf("GetRepo returned error: %v", err)
	}
	if repo.RemoteURL != "https://example.invalid/repo.git" {
		t.Fatalf("RemoteURL = %q, want reconstructed public URL", repo.RemoteURL)
	}
}

func TestRepoOwnershipRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t, ctx)

	err := store.AddRepo(ctx, model.RepoConfig{
		ID:                "repo",
		Name:              "repo",
		MountRoot:         "/mnt",
		MountPath:         "/mnt/repo",
		RemoteURLRedacted: "https://example.invalid/repo.git",
		Branch:            "main",
		RefreshInterval:   time.Minute,
		GitDir:            "/state/git",
		OverlayDir:        "/state/overlay",
		BlobCacheDir:      "/state/cache",
		MetaDBPath:        "/state/meta.sqlite",
		OverlayDBPath:     "/state/overlay.sqlite",
		Enabled:           true,
		ManagedBy:         model.RepoManagedByControlplane,
		DesiredOwner:      "rivet-artifact-sandbox",
	})
	if err != nil {
		t.Fatalf("AddRepo returned error: %v", err)
	}

	repo, err := store.GetRepo(ctx, "repo")
	if err != nil {
		t.Fatalf("GetRepo returned error: %v", err)
	}
	if repo.ManagedBy != model.RepoManagedByControlplane {
		t.Fatalf("ManagedBy = %q, want controlplane", repo.ManagedBy)
	}
	if repo.DesiredOwner != "rivet-artifact-sandbox" {
		t.Fatalf("DesiredOwner = %q, want rivet-artifact-sandbox", repo.DesiredOwner)
	}
}

func TestExistingRegistrySchemaGetsOwnershipDefaults(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "repos.sqlite")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open returned error: %v", err)
	}
	_, err = db.Exec(`CREATE TABLE repos (
		repo_id TEXT PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		mount_root TEXT NOT NULL,
		mount_path TEXT NOT NULL,
		remote_url_redacted TEXT NOT NULL,
		remote_url_secret_ref TEXT,
		branch TEXT NOT NULL,
		refresh_interval_seconds INTEGER NOT NULL,
		git_dir TEXT NOT NULL,
		overlay_dir TEXT NOT NULL,
		blob_cache_dir TEXT NOT NULL,
		meta_db_path TEXT NOT NULL,
		overlay_db_path TEXT NOT NULL,
		enabled INTEGER NOT NULL DEFAULT 1,
		created_at_ns INTEGER NOT NULL,
		updated_at_ns INTEGER NOT NULL
	);`)
	if err != nil {
		t.Fatalf("create old schema: %v", err)
	}
	_, err = db.Exec(`INSERT INTO repos (repo_id, name, mount_root, mount_path, remote_url_redacted, branch, refresh_interval_seconds, git_dir, overlay_dir, blob_cache_dir, meta_db_path, overlay_db_path, enabled, created_at_ns, updated_at_ns) VALUES ('repo', 'repo', '/mnt', '/mnt/repo', 'https://example.invalid/repo.git', 'main', 60, '/git', '/overlay', '/cache', '/meta.sqlite', '/overlay.sqlite', 1, 1, 1)`)
	if err != nil {
		t.Fatalf("insert old row: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("db.Close returned error: %v", err)
	}

	store, err := New(ctx, dbPath)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	defer store.Close()
	repo, err := store.GetRepo(ctx, "repo")
	if err != nil {
		t.Fatalf("GetRepo returned error: %v", err)
	}
	if repo.ManagedBy != model.RepoManagedByLocal {
		t.Fatalf("ManagedBy = %q, want local", repo.ManagedBy)
	}
	if repo.DesiredOwner != "" {
		t.Fatalf("DesiredOwner = %q, want empty", repo.DesiredOwner)
	}
}

func newTestStore(t *testing.T, ctx context.Context) *Store {
	t.Helper()
	store, err := New(ctx, filepath.Join(t.TempDir(), "repos.sqlite"))
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}
