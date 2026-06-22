package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/cloudflare/artifact-fs/internal/controlplane"
	"github.com/cloudflare/artifact-fs/internal/model"
)

func TestFormatStatusLineUsesNeverForUnsetFetch(t *testing.T) {
	st := model.RepoRuntimeState{
		RepoID:            "workerd",
		State:             "mounted",
		CurrentHEADOID:    "abc123",
		CurrentHEADRef:    "main",
		LastFetchResult:   "never",
		HydratedBlobCount: 3,
		HydratedBlobBytes: 42,
	}

	got := formatStatusLine(st)
	for _, want := range []string{
		"last_fetch=never",
		"result=never",
		"hydrated_blobs=3",
		"hydrated_bytes=42",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("status line %q missing %q", got, want)
		}
	}
	if strings.Contains(got, "0001-01-01T00:00:00Z") {
		t.Fatalf("status line leaked zero time: %q", got)
	}
}

func TestFormatStatusLineFormatsFetchTimestamp(t *testing.T) {
	at := time.Date(2026, time.March, 31, 12, 34, 56, 0, time.UTC)
	st := model.RepoRuntimeState{LastFetchAt: at, LastFetchResult: "ok"}

	got := formatStatusLine(st)
	if !strings.Contains(got, "last_fetch=2026-03-31T12:34:56Z") {
		t.Fatalf("status line %q missing formatted timestamp", got)
	}
}

func TestNewDaemonCoordinatorDefaultsToNoop(t *testing.T) {
	coord, err := newDaemonCoordinator("", "", "")
	if err != nil {
		t.Fatalf("newDaemonCoordinator returned error: %v", err)
	}
	if _, ok := coord.(controlplane.NoopCoordinator); !ok {
		t.Fatalf("coordinator = %T, want NoopCoordinator", coord)
	}
}

func TestNewDaemonCoordinatorCreatesRivet(t *testing.T) {
	coord, err := newDaemonCoordinator("rivet", "http://127.0.0.1:8788", "token-value")
	if err != nil {
		t.Fatalf("newDaemonCoordinator returned error: %v", err)
	}
	if _, ok := coord.(*controlplane.RivetCoordinator); !ok {
		t.Fatalf("coordinator = %T, want *RivetCoordinator", coord)
	}
}

func TestNewDaemonCoordinatorRequiresRivetURL(t *testing.T) {
	_, err := newDaemonCoordinator("rivet", "", "")
	if err == nil {
		t.Fatalf("newDaemonCoordinator accepted empty Rivet URL")
	}
	if !strings.Contains(err.Error(), "ARTIFACT_FS_RIVET_URL") {
		t.Fatalf("error %q did not mention recovery action", err.Error())
	}
}

func TestNewDaemonCoordinatorRejectsUnknownMode(t *testing.T) {
	_, err := newDaemonCoordinator("durable-object", "", "")
	if err == nil {
		t.Fatalf("newDaemonCoordinator accepted unknown mode")
	}
	if !strings.Contains(err.Error(), "noop or rivet") {
		t.Fatalf("error %q did not mention valid modes", err.Error())
	}
}

func TestEnvOrDefault(t *testing.T) {
	t.Setenv("ARTIFACT_FS_CONTROLPLANE", "rivet")
	if got := envOrDefault("ARTIFACT_FS_CONTROLPLANE", "noop"); got != "rivet" {
		t.Fatalf("envOrDefault = %q, want rivet", got)
	}
	t.Setenv("ARTIFACT_FS_CONTROLPLANE", "")
	if got := envOrDefault("ARTIFACT_FS_CONTROLPLANE", "noop"); got != "noop" {
		t.Fatalf("envOrDefault = %q, want noop", got)
	}
}
