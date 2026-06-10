//go:build !windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cloudflare/artifact-fs/internal/auth"
	"github.com/cloudflare/artifact-fs/internal/daemon"
	"github.com/cloudflare/artifact-fs/internal/logging"
	"github.com/cloudflare/artifact-fs/internal/model"
)

type headCatchupRepoSpec struct {
	name  string
	files int
}

type headCatchupScenario string

const (
	headCatchupCreate  headCatchupScenario = "create"
	headCatchupModify  headCatchupScenario = "modify"
	headCatchupPartial headCatchupScenario = "partial"
	headCatchupRename  headCatchupScenario = "rename"
	headCatchupDelete  headCatchupScenario = "delete"
)

type headCatchupRun struct {
	Mode             string  `json:"mode"`
	Repo             string  `json:"repo"`
	Files            int     `json:"files"`
	Scenario         string  `json:"scenario"`
	Iteration        int     `json:"iteration"`
	CommitMS         float64 `json:"commit_ms"`
	DaemonCatchupMS  float64 `json:"daemon_catchup_ms"`
	PostStatusMS     float64 `json:"post_status_ms"`
	Polls            int     `json:"polls"`
	TimedOut         bool    `json:"timed_out"`
	FinalHeadChanged bool    `json:"final_head_changed"`
	FinalStatus      string  `json:"final_status"`
}

type headCatchupStatusRun struct {
	Mode      string  `json:"mode"`
	Repo      string  `json:"repo"`
	Files     int     `json:"files"`
	Iteration int     `json:"iteration"`
	StatusMS  float64 `json:"status_ms"`
}

type headCatchupSummary struct {
	Mode      string
	Repo      string
	Files     int
	Scenario  string
	Runs      int
	Timeouts  int
	CommitMS  numericSummary
	CatchupMS numericSummary
	StatusMS  numericSummary
}

type headCatchupStatusSummary struct {
	Mode     string
	Repo     string
	Files    int
	Runs     int
	StatusMS numericSummary
}

func TestE2EHeadCatchupBenchmark(t *testing.T) {
	if os.Getenv("AFS_RUN_HEAD_CATCHUP_BENCH") != "1" {
		t.Skip("skipping head catch-up benchmark (set AFS_RUN_HEAD_CATCHUP_BENCH=1 to run)")
	}
	skipIfNoFUSE(t)

	runs := getenvInt("AFS_HEAD_CATCHUP_RUNS", 30)
	if runs <= 0 {
		t.Fatalf("AFS_HEAD_CATCHUP_RUNS must be > 0, got %d", runs)
	}

	repos := headCatchupRepoSpecs()
	scenarios := headCatchupScenarios()
	verbose := os.Getenv("AFS_HEAD_CATCHUP_VERBOSE") == "1"

	var commitRuns []headCatchupRun
	var statusRuns []headCatchupStatusRun
	for _, repo := range repos {
		if repo.files < runs*2+25 {
			t.Fatalf("repo %s has %d files, need at least %d", repo.name, repo.files, runs*2+25)
		}
		remote := createHeadCatchupRepo(t, repo.files)

		t.Run(repo.name+"/artifactfs/status", func(t *testing.T) {
			mounted := mountHeadCatchupRepo(t, remote, repo.name+"-status")
			statusRuns = append(statusRuns, measureCleanStatusRuns(t, "artifactfs", repo, mounted.mountPath, runs, verbose)...)
		})
		t.Run(repo.name+"/git/status", func(t *testing.T) {
			worktree := cloneHeadCatchupWorktree(t, remote)
			statusRuns = append(statusRuns, measureCleanStatusRuns(t, "git", repo, worktree, runs, verbose)...)
		})
		for _, scenario := range scenarios {
			scenario := scenario
			t.Run(fmt.Sprintf("%s/artifactfs/%s", repo.name, scenario), func(t *testing.T) {
				repoName := fmt.Sprintf("%s-%s", repo.name, scenario)
				mounted := mountHeadCatchupRepo(t, remote, repoName)
				waiter := func(newHead string) (time.Duration, int, bool, bool, string) {
					return waitForArtifactFSHead(context.Background(), mounted.svc, repoName, newHead, 30*time.Second)
				}
				commitRuns = append(commitRuns, runHeadCatchupScenario(t, "artifactfs", repo, mounted.mountPath, scenario, runs, verbose, waiter)...)
			})
			t.Run(fmt.Sprintf("%s/git/%s", repo.name, scenario), func(t *testing.T) {
				worktree := cloneHeadCatchupWorktree(t, remote)
				commitRuns = append(commitRuns, runHeadCatchupScenario(t, "git", repo, worktree, scenario, runs, verbose, waitForNoopHeadCatchup)...)
			})
		}
	}

	for _, summary := range summarizeHeadCatchupRuns(commitRuns) {
		fmt.Printf(
			"HEAD_CATCHUP_SUMMARY mode=%s repo=%s files=%d scenario=%s runs=%d timeouts=%d commit_ms median=%.1f p90=%.1f p95=%.1f p99=%.1f max=%.1f daemon_catchup_ms median=%.1f p90=%.1f p95=%.1f p99=%.1f max=%.1f post_status_ms median=%.1f p90=%.1f p95=%.1f p99=%.1f max=%.1f\n",
			summary.Mode,
			summary.Repo,
			summary.Files,
			summary.Scenario,
			summary.Runs,
			summary.Timeouts,
			summary.CommitMS.Median,
			summary.CommitMS.P90,
			summary.CommitMS.P95,
			summary.CommitMS.P99,
			summary.CommitMS.Max,
			summary.CatchupMS.Median,
			summary.CatchupMS.P90,
			summary.CatchupMS.P95,
			summary.CatchupMS.P99,
			summary.CatchupMS.Max,
			summary.StatusMS.Median,
			summary.StatusMS.P90,
			summary.StatusMS.P95,
			summary.StatusMS.P99,
			summary.StatusMS.Max,
		)
	}
	for _, summary := range summarizeHeadCatchupStatusRuns(statusRuns) {
		fmt.Printf(
			"HEAD_CATCHUP_STATUS_SUMMARY mode=%s repo=%s files=%d runs=%d status_ms median=%.1f p90=%.1f p95=%.1f p99=%.1f max=%.1f\n",
			summary.Mode,
			summary.Repo,
			summary.Files,
			summary.Runs,
			summary.StatusMS.Median,
			summary.StatusMS.P90,
			summary.StatusMS.P95,
			summary.StatusMS.P99,
			summary.StatusMS.Max,
		)
	}
}

func headCatchupRepoSpecs() []headCatchupRepoSpec {
	if raw := strings.TrimSpace(os.Getenv("AFS_HEAD_CATCHUP_REPOS")); raw != "" {
		var specs []headCatchupRepoSpec
		for _, part := range strings.Split(raw, ",") {
			name, fileCount, ok := strings.Cut(strings.TrimSpace(part), ":")
			if !ok || strings.TrimSpace(name) == "" {
				continue
			}
			files, err := strconv.Atoi(strings.TrimSpace(fileCount))
			if err != nil || files <= 0 {
				continue
			}
			specs = append(specs, headCatchupRepoSpec{name: strings.TrimSpace(name), files: files})
		}
		if len(specs) > 0 {
			return specs
		}
	}

	specs := []headCatchupRepoSpec{
		{name: "tiny", files: 500},
		{name: "small", files: 1000},
		{name: "large", files: 10000},
	}
	if os.Getenv("AFS_HEAD_CATCHUP_XLARGE") == "1" {
		specs = append(specs, headCatchupRepoSpec{name: "xlarge", files: 25000})
	}
	return specs
}

func headCatchupScenarios() []headCatchupScenario {
	known := map[string]headCatchupScenario{
		"create":  headCatchupCreate,
		"modify":  headCatchupModify,
		"partial": headCatchupPartial,
		"rename":  headCatchupRename,
		"delete":  headCatchupDelete,
	}
	if raw := strings.TrimSpace(os.Getenv("AFS_HEAD_CATCHUP_SCENARIOS")); raw != "" {
		var scenarios []headCatchupScenario
		for _, part := range strings.Split(raw, ",") {
			name := strings.TrimSpace(part)
			if scenario, ok := known[name]; ok {
				scenarios = append(scenarios, scenario)
			}
		}
		if len(scenarios) > 0 {
			return scenarios
		}
	}
	return []headCatchupScenario{
		headCatchupCreate,
		headCatchupDelete,
	}
}

func createHeadCatchupRepo(t *testing.T, files int) string {
	t.Helper()

	bareDir := filepath.Join(t.TempDir(), "head-catchup.git")
	workDir := filepath.Join(t.TempDir(), "work")
	run(t, "", "git", "init", "--bare", bareDir)
	run(t, "", "git", "clone", bareDir, workDir)
	run(t, workDir, "git", "config", "user.name", "Head Catchup Setup")
	run(t, workDir, "git", "config", "user.email", "head-catchup@test")
	run(t, workDir, "git", "checkout", "-b", "main")

	for i := range files {
		path := fixturePath(i)
		writeHeadCatchupFile(t, workDir, path, fmt.Sprintf("file %06d\n", i))
	}
	writeHeadCatchupFile(t, workDir, "README.md", fmt.Sprintf("# Head catch-up fixture\n\nfiles: %d\n", files))
	run(t, workDir, "git", "add", "-A")
	run(t, workDir, "git", "commit", "-m", "seed synthetic repo")
	run(t, workDir, "git", "push", "origin", "main")
	return "file://" + bareDir
}

func writeHeadCatchupFile(t *testing.T, root string, path string, content string) {
	t.Helper()
	abs := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fixturePath(i int) string {
	return fmt.Sprintf("packages/pkg-%04d/src/file-%06d.ts", i/20, i)
}

func mountHeadCatchupRepo(t *testing.T, remote string, name string) *mountedE2ERepo {
	t.Helper()
	root, err := os.MkdirTemp("", "artifact-fs-head-catchup-root-*")
	if err != nil {
		t.Fatal(err)
	}
	mountDir, err := os.MkdirTemp("", "artifact-fs-head-catchup-mount-*")
	if err != nil {
		_ = os.RemoveAll(root)
		t.Fatal(err)
	}
	mountPath := filepath.Join(mountDir, name)
	if err := os.MkdirAll(mountPath, 0o755); err != nil {
		_ = os.RemoveAll(mountDir)
		_ = os.RemoveAll(root)
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	logger := logging.NewJSONLogger(os.Stderr, slog.LevelWarn)
	svc, err := daemon.New(ctx, root, logger)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	svc.SetMountRoot(mountDir)
	cfg := model.RepoConfig{
		Name:              name,
		ID:                model.RepoID(name),
		RemoteURL:         remote,
		RemoteURLRedacted: auth.RedactRemoteURL(remote),
		Branch:            "main",
		RefreshInterval:   5 * time.Minute,
		MountRoot:         mountDir,
		Enabled:           true,
	}
	if err := svc.AddRepo(ctx, cfg); err != nil {
		cancel()
		_ = svc.Close()
		t.Fatalf("add-repo: %v", err)
	}
	errCh := make(chan error, 1)
	go func() { errCh <- svc.Start(ctx) }()
	if !waitForMount(t, mountPath, 60*time.Second) {
		cancel()
		_ = svc.Close()
		t.Fatal("FUSE mount did not appear within timeout")
	}
	repo := &mountedE2ERepo{root: root, mountDir: mountDir, mountPath: mountPath, svc: svc, cancel: cancel, errCh: errCh}
	t.Cleanup(func() { repo.close(t) })
	return repo
}

func cloneHeadCatchupWorktree(t *testing.T, remote string) string {
	t.Helper()
	worktree := filepath.Join(t.TempDir(), "worktree")
	run(t, "", "git", "clone", "--branch", "main", remote, worktree)
	run(t, worktree, "git", "config", "user.name", "Head Catchup Bench")
	run(t, worktree, "git", "config", "user.email", "head-catchup-bench@test")
	return worktree
}

func measureCleanStatusRuns(t *testing.T, mode string, repo headCatchupRepoSpec, dir string, runs int, verbose bool) []headCatchupStatusRun {
	t.Helper()
	results := make([]headCatchupStatusRun, 0, runs)
	for i := 1; i <= runs; i++ {
		start := time.Now()
		out := gitCmd(t, dir, "status", "--short", "--untracked-files=all")
		dur := time.Since(start)
		if strings.TrimSpace(out) != "" {
			t.Fatalf("%s/%s clean status baseline was dirty: %q", mode, repo.name, out)
		}
		result := headCatchupStatusRun{Mode: mode, Repo: repo.name, Files: repo.files, Iteration: i, StatusMS: durationMS(dur)}
		results = append(results, result)
		if verbose {
			printJSONLine(t, "HEAD_CATCHUP_STATUS_RUN", result)
		}
	}
	return results
}

type headCatchupWaiter func(newHead string) (time.Duration, int, bool, bool, string)

func runHeadCatchupScenario(t *testing.T, mode string, repo headCatchupRepoSpec, dir string, scenario headCatchupScenario, runs int, verbose bool, waiter headCatchupWaiter) []headCatchupRun {
	t.Helper()
	results := make([]headCatchupRun, 0, runs)
	for i := 1; i <= runs; i++ {
		preHead := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "HEAD"))
		wantStatus, cleanup := prepareHeadCatchupScenario(t, dir, repo.files, scenario, i)

		commitStart := time.Now()
		gitCmd(t, dir,
			"-c", "user.name=Head Catchup Bench",
			"-c", "user.email=head-catchup-bench@test",
			"commit", "-m", fmt.Sprintf("head catchup %s %03d", scenario, i),
		)
		commitDur := time.Since(commitStart)

		newHead := strings.TrimSpace(gitCmd(t, dir, "rev-parse", "HEAD"))
		daemonCatchupDur, polls, timedOut, finalHeadChanged, finalStatus := waiter(newHead)
		if newHead == preHead {
			t.Fatalf("%s/%s/%s iteration %d did not advance HEAD", mode, repo.name, scenario, i)
		}

		postStatusStart := time.Now()
		statusOut := gitCmd(t, dir, "status", "--short", "--untracked-files=all")
		postStatusDur := time.Since(postStatusStart)
		gotStatus, err := parseStatusOutput(statusOut)
		if err != nil {
			t.Fatalf("parse status: %v", err)
		}
		if !reflect.DeepEqual(gotStatus, wantStatus) {
			t.Fatalf("%s/%s/%s iteration %d status mismatch after catch-up: got %v want %v", mode, repo.name, scenario, i, gotStatus, wantStatus)
		}
		result := headCatchupRun{
			Mode:             mode,
			Repo:             repo.name,
			Files:            repo.files,
			Scenario:         string(scenario),
			Iteration:        i,
			CommitMS:         durationMS(commitDur),
			DaemonCatchupMS:  durationMS(daemonCatchupDur),
			PostStatusMS:     durationMS(postStatusDur),
			Polls:            polls,
			TimedOut:         timedOut,
			FinalHeadChanged: finalHeadChanged,
			FinalStatus:      finalStatus,
		}
		results = append(results, result)
		if verbose {
			printJSONLine(t, "HEAD_CATCHUP_RUN", result)
		}
		if timedOut {
			t.Fatalf("%s/%s/%s iteration %d timed out: headChanged=%t status=%s", mode, repo.name, scenario, i, finalHeadChanged, finalStatus)
		}
		cleanup()
	}
	return results
}

func prepareHeadCatchupScenario(t *testing.T, dir string, files int, scenario headCatchupScenario, iteration int) (map[string]string, func()) {
	t.Helper()
	switch scenario {
	case headCatchupCreate:
		path := fmt.Sprintf("bench-created/create-%06d.txt", iteration)
		writeMountedFile(t, dir, path, fmt.Sprintf("created %06d\n", iteration))
		gitCmd(t, dir, "add", path)
		return map[string]string{}, func() {}
	case headCatchupModify:
		path := fixturePath(iteration - 1)
		appendMountedFile(t, dir, path, fmt.Sprintf("modify %06d\n", iteration))
		gitCmd(t, dir, "add", path)
		return map[string]string{}, func() {}
	case headCatchupPartial:
		path := fixturePath(100 + iteration - 1)
		staged := readFileStr(t, filepath.Join(dir, path)) + fmt.Sprintf("staged %06d\n", iteration)
		if err := os.WriteFile(filepath.Join(dir, path), []byte(staged), 0o644); err != nil {
			t.Fatal(err)
		}
		gitCmd(t, dir, "add", path)
		worktree := staged + fmt.Sprintf("unstaged %06d\n", iteration)
		if err := os.WriteFile(filepath.Join(dir, path), []byte(worktree), 0o644); err != nil {
			t.Fatal(err)
		}
		return map[string]string{path: " M"}, func() {
			gitCmd(t, dir, "checkout", "--", path)
			waitForExactStatus(t, dir, map[string]string{}, 10*time.Second)
		}
	case headCatchupRename:
		oldPath := fixturePath(10 + iteration - 1)
		newPath := fmt.Sprintf("bench-renamed/renamed-%06d.ts", iteration)
		if err := os.MkdirAll(filepath.Join(dir, "bench-renamed"), 0o755); err != nil {
			t.Fatal(err)
		}
		gitCmd(t, dir, "mv", oldPath, newPath)
		return map[string]string{}, func() {}
	case headCatchupDelete:
		path := fixturePath(files/2 + iteration - 1)
		gitCmd(t, dir, "rm", path)
		return map[string]string{}, func() {}
	default:
		t.Fatalf("unknown scenario %q", scenario)
		return nil, nil
	}
}

func writeMountedFile(t *testing.T, root string, path string, content string) {
	t.Helper()
	abs := filepath.Join(root, path)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendMountedFile(t *testing.T, root string, path string, content string) {
	t.Helper()
	abs := filepath.Join(root, path)
	f, err := os.OpenFile(abs, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func waitForArtifactFSHead(ctx context.Context, svc *daemon.Service, repoName string, newHead string, timeout time.Duration) (time.Duration, int, bool, bool, string) {
	deadline := time.Now().Add(timeout)
	start := time.Now()
	polls := 0
	lastState := "not checked"
	for time.Now().Before(deadline) {
		polls++
		state, err := svc.Status(ctx, repoName)
		if err != nil {
			lastState = "status failed: " + err.Error()
			time.Sleep(50 * time.Millisecond)
			continue
		}
		lastState = fmt.Sprintf("head=%s gen=%d dirty=%t", state.CurrentHEADOID, state.SnapshotGeneration, state.DirtyOverlay)
		if state.CurrentHEADOID == newHead {
			return time.Since(start), polls, false, true, lastState
		}
		time.Sleep(50 * time.Millisecond)
	}
	return time.Since(start), polls, true, false, lastState
}

func waitForNoopHeadCatchup(_ string) (time.Duration, int, bool, bool, string) {
	return 0, 0, false, true, "not applicable"
}

func waitForExactStatus(t *testing.T, dir string, want map[string]string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last map[string]string
	for time.Now().Before(deadline) {
		out := gitCmd(t, dir, "status", "--short", "--untracked-files=all")
		got, err := parseStatusOutput(out)
		if err != nil {
			t.Fatalf("parse status: %v", err)
		}
		if reflect.DeepEqual(got, want) {
			return
		}
		last = got
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for status %v, got %v", want, last)
}

func statusMapString(status map[string]string) string {
	if len(status) == 0 {
		return "clean"
	}
	paths := make([]string, 0, len(status))
	for path := range status {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	parts := make([]string, 0, len(paths))
	for _, path := range paths {
		parts = append(parts, fmt.Sprintf("%s:%s", path, status[path]))
	}
	return strings.Join(parts, ",")
}

func summarizeHeadCatchupRuns(runs []headCatchupRun) []headCatchupSummary {
	byKey := make(map[string][]headCatchupRun)
	for _, run := range runs {
		key := strings.Join([]string{run.Mode, run.Repo, run.Scenario}, "\x00")
		byKey[key] = append(byKey[key], run)
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]headCatchupSummary, 0, len(keys))
	for _, key := range keys {
		group := byKey[key]
		commitVals := make([]float64, 0, len(group))
		catchupVals := make([]float64, 0, len(group))
		statusVals := make([]float64, 0, len(group))
		timeouts := 0
		for _, run := range group {
			commitVals = append(commitVals, run.CommitMS)
			catchupVals = append(catchupVals, run.DaemonCatchupMS)
			statusVals = append(statusVals, run.PostStatusMS)
			if run.TimedOut {
				timeouts++
			}
		}
		out = append(out, headCatchupSummary{
			Mode:      group[0].Mode,
			Repo:      group[0].Repo,
			Files:     group[0].Files,
			Scenario:  group[0].Scenario,
			Runs:      len(group),
			Timeouts:  timeouts,
			CommitMS:  summarizeValues(commitVals),
			CatchupMS: summarizeValues(catchupVals),
			StatusMS:  summarizeValues(statusVals),
		})
	}
	return out
}

func summarizeHeadCatchupStatusRuns(runs []headCatchupStatusRun) []headCatchupStatusSummary {
	byKey := make(map[string][]headCatchupStatusRun)
	for _, run := range runs {
		key := strings.Join([]string{run.Mode, run.Repo}, "\x00")
		byKey[key] = append(byKey[key], run)
	}
	keys := make([]string, 0, len(byKey))
	for key := range byKey {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]headCatchupStatusSummary, 0, len(keys))
	for _, key := range keys {
		group := byKey[key]
		vals := make([]float64, 0, len(group))
		for _, run := range group {
			vals = append(vals, run.StatusMS)
		}
		out = append(out, headCatchupStatusSummary{
			Mode:     group[0].Mode,
			Repo:     group[0].Repo,
			Files:    group[0].Files,
			Runs:     len(group),
			StatusMS: summarizeValues(vals),
		})
	}
	return out
}

func durationMS(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

func printJSONLine(t *testing.T, prefix string, value any) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal %s: %v", prefix, err)
	}
	fmt.Printf("%s %s\n", prefix, encoded)
}
