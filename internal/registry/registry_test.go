package registry

import (
	"context"
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

func newTestStore(t *testing.T, ctx context.Context) *Store {
	t.Helper()
	store, err := New(ctx, filepath.Join(t.TempDir(), "repos.sqlite"))
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}
