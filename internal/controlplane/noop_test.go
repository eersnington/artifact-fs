package controlplane

import (
	"context"
	"testing"
)

func TestNoopCoordinatorIsInert(t *testing.T) {
	c := NewNoop()
	ctx := context.Background()

	desired, err := c.DesiredRepos(ctx, HostInfo{Root: "/tmp/state", MountRoot: "/tmp/mnt"})
	if err != nil {
		t.Fatalf("DesiredRepos returned error: %v", err)
	}
	if len(desired.Repos) != 0 {
		t.Fatalf("DesiredRepos returned %d repos, want 0", len(desired.Repos))
	}
	if desired.Authoritative {
		t.Fatalf("DesiredRepos returned authoritative=true, want false")
	}

	if err := c.RecordEvent(ctx, RuntimeEvent{Kind: EventMountReady}); err != nil {
		t.Fatalf("RecordEvent returned error: %v", err)
	}

	plan, err := c.WarmupPlan(ctx, WarmupRequest{RepoName: "repo"})
	if err != nil {
		t.Fatalf("WarmupPlan returned error: %v", err)
	}
	if len(plan.Tasks) != 0 {
		t.Fatalf("WarmupPlan returned %d tasks, want 0", len(plan.Tasks))
	}

	cred, err := c.CredentialEnv(ctx, CredentialRequest{RepoName: "repo"})
	if err != nil {
		t.Fatalf("CredentialEnv returned error: %v", err)
	}
	if cred.SafeRemoteURL != "" || len(cred.Env) != 0 || !cred.ExpiresAt.IsZero() {
		t.Fatalf("CredentialEnv returned non-empty credentials: %#v", cred)
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
}
