package controlplane

import (
	"context"
	"time"

	"github.com/cloudflare/artifact-fs/internal/model"
)

// Coordinator is ArtifactFS' durable coordination seam. Implementations may
// observe runtime events or provide desired repo and warmup metadata, but local
// daemon state remains authoritative for filesystem correctness.
type Coordinator interface {
	DesiredRepos(ctx context.Context, host HostInfo) ([]model.RepoConfig, error)
	RecordEvent(ctx context.Context, event RuntimeEvent) error
	WarmupPlan(ctx context.Context, req WarmupRequest) (WarmupPlan, error)
	CredentialEnv(ctx context.Context, req CredentialRequest) (CredentialEnv, error)
	Close() error
}

type HostInfo struct {
	Root      string
	MountRoot string
}

type RuntimeEventKind string

const (
	EventRepoDesired       RuntimeEventKind = "repo.desired"
	EventMountAttempted    RuntimeEventKind = "mount.attempted"
	EventMountReady        RuntimeEventKind = "mount.ready"
	EventMountFailed       RuntimeEventKind = "mount.failed"
	EventFetchSucceeded    RuntimeEventKind = "fetch.succeeded"
	EventFetchFailed       RuntimeEventKind = "fetch.failed"
	EventHeadChanged       RuntimeEventKind = "head.changed"
	EventSnapshotPublished RuntimeEventKind = "snapshot.published"
	EventOverlayDirty      RuntimeEventKind = "overlay.dirty"
	EventOverlayClean      RuntimeEventKind = "overlay.clean"
	EventHydrationQueued   RuntimeEventKind = "hydration.queued"
	EventHydrationComplete RuntimeEventKind = "hydration.complete"
)

type RuntimeEvent struct {
	ID         string
	RepoID     model.RepoID
	RepoName   string
	Kind       RuntimeEventKind
	At         time.Time
	HeadOID    string
	HeadRef    string
	Generation int64
	Path       string
	ObjectOID  string
	SizeBytes  int64
	Error      string
}

type WarmupRequest struct {
	RepoID      model.RepoID
	RepoName    string
	HeadOID     string
	HeadRef     string
	Generation  int64
	ToolProfile string
	MaxFiles    int
	MaxBytes    int64
}

type WarmupPlan struct {
	Tasks []model.HydrationTask
}

type CredentialRequest struct {
	RepoID    model.RepoID
	RepoName  string
	RemoteURL string
	SecretRef string
}

type CredentialEnv struct {
	SafeRemoteURL string
	Env           []string
	ExpiresAt     time.Time
}
