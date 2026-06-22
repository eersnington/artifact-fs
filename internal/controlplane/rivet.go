package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/cloudflare/artifact-fs/internal/auth"
	"github.com/cloudflare/artifact-fs/internal/model"
)

const defaultRivetTimeout = 2 * time.Second

type RivetOptions struct {
	BaseURL    string
	Token      string
	Timeout    time.Duration
	HTTPClient *http.Client
}

type RivetCoordinator struct {
	baseURL string
	token   string
	timeout time.Duration
	client  *http.Client
}

func NewRivet(opts RivetOptions) (*RivetCoordinator, error) {
	baseURL := strings.TrimSpace(opts.BaseURL)
	if baseURL == "" {
		return nil, errors.New("rivet controlplane URL is required; set ARTIFACT_FS_RIVET_URL or pass --rivet-url")
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, fmt.Errorf("invalid rivet controlplane URL %q: expected an absolute http(s) URL", auth.RedactString(baseURL))
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultRivetTimeout
	}
	client := opts.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return &RivetCoordinator{
		baseURL: strings.TrimRight(u.String(), "/"),
		token:   opts.Token,
		timeout: timeout,
		client:  client,
	}, nil
}

func (c *RivetCoordinator) DesiredRepos(ctx context.Context, host HostInfo) (DesiredRepoSet, error) {
	var out desiredReposResponse
	query := url.Values{}
	query.Set("root", host.Root)
	query.Set("mountRoot", host.MountRoot)
	if err := c.do(ctx, http.MethodGet, "/v1/desired-repos", query, nil, &out); err != nil {
		return DesiredRepoSet{}, err
	}
	repos := make([]model.RepoConfig, 0, len(out.Repos))
	for _, repo := range out.Repos {
		repos = append(repos, repo.toModel(out.Source))
	}
	return DesiredRepoSet{Repos: repos, Source: out.Source, Authoritative: out.Authoritative}, nil
}

func (c *RivetCoordinator) RecordEvent(ctx context.Context, event RuntimeEvent) error {
	return c.do(ctx, http.MethodPost, "/v1/events", nil, runtimeEventWireFromEvent(event), nil)
}

func (c *RivetCoordinator) WarmupPlan(ctx context.Context, req WarmupRequest) (WarmupPlan, error) {
	var out warmupPlanWire
	if err := c.do(ctx, http.MethodPost, "/v1/warmup-plan", nil, warmupRequestWireFromRequest(req), &out); err != nil {
		return WarmupPlan{}, err
	}
	return out.toModel(), nil
}

func (c *RivetCoordinator) CredentialEnv(ctx context.Context, req CredentialRequest) (CredentialEnv, error) {
	var out credentialEnvWire
	if err := c.do(ctx, http.MethodPost, "/v1/credential-env", nil, credentialRequestWireFromRequest(req), &out); err != nil {
		return CredentialEnv{}, err
	}
	return out.toModel(), nil
}

func (c *RivetCoordinator) Close() error {
	return nil
}

func (c *RivetCoordinator) do(ctx context.Context, method string, path string, query url.Values, body any, out any) error {
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	endpoint, err := url.Parse(c.baseURL + path)
	if err != nil {
		return err
	}
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}

	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode rivet %s request: %w", path, err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(requestCtx, method, endpoint.String(), reqBody)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("authorization", "Bearer "+c.token)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("rivet %s %s failed: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := strings.TrimSpace(string(data))
		if msg == "" {
			msg = http.StatusText(resp.StatusCode)
		}
		return fmt.Errorf("rivet %s %s failed: status %d: %s", method, path, resp.StatusCode, auth.RedactString(msg))
	}

	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode rivet %s response: %w", path, err)
	}
	return nil
}

type desiredReposResponse struct {
	Repos         []repoConfigWire `json:"repos"`
	Source        string           `json:"source,omitempty"`
	Authoritative bool             `json:"authoritative,omitempty"`
}

type repoConfigWire struct {
	ID                     string `json:"id,omitempty"`
	Name                   string `json:"name"`
	MountRoot              string `json:"mountRoot,omitempty"`
	MountPath              string `json:"mountPath,omitempty"`
	RemoteURL              string `json:"remoteUrl,omitempty"`
	RemoteURLRedacted      string `json:"remoteUrlRedacted,omitempty"`
	RemoteURLSecretRef     string `json:"remoteUrlSecretRef,omitempty"`
	Branch                 string `json:"branch"`
	RefreshIntervalSeconds int64  `json:"refreshIntervalSeconds,omitempty"`
	GitDir                 string `json:"gitDir,omitempty"`
	OverlayDir             string `json:"overlayDir,omitempty"`
	BlobCacheDir           string `json:"blobCacheDir,omitempty"`
	MetaDBPath             string `json:"metaDbPath,omitempty"`
	OverlayDBPath          string `json:"overlayDbPath,omitempty"`
	Enabled                bool   `json:"enabled"`
	DesiredOwner           string `json:"desiredOwner,omitempty"`
}

func (r repoConfigWire) toModel(source string) model.RepoConfig {
	desiredOwner := r.DesiredOwner
	if desiredOwner == "" {
		desiredOwner = source
	}
	return model.RepoConfig{
		ID:                 model.RepoID(r.ID),
		Name:               r.Name,
		MountRoot:          r.MountRoot,
		MountPath:          r.MountPath,
		RemoteURL:          r.RemoteURL,
		RemoteURLRedacted:  r.RemoteURLRedacted,
		RemoteURLSecretRef: r.RemoteURLSecretRef,
		Branch:             r.Branch,
		RefreshInterval:    time.Duration(r.RefreshIntervalSeconds) * time.Second,
		GitDir:             r.GitDir,
		OverlayDir:         r.OverlayDir,
		BlobCacheDir:       r.BlobCacheDir,
		MetaDBPath:         r.MetaDBPath,
		OverlayDBPath:      r.OverlayDBPath,
		Enabled:            r.Enabled,
		DesiredOwner:       desiredOwner,
	}
}

type runtimeEventWire struct {
	ID                string    `json:"id,omitempty"`
	RepoID            string    `json:"repoId"`
	RepoName          string    `json:"repoName"`
	Kind              string    `json:"kind"`
	At                time.Time `json:"at"`
	HeadOID           string    `json:"headOid,omitempty"`
	HeadRef           string    `json:"headRef,omitempty"`
	Generation        int64     `json:"generation,omitempty"`
	Path              string    `json:"path,omitempty"`
	ObjectOID         string    `json:"objectOid,omitempty"`
	SizeBytes         int64     `json:"sizeBytes,omitempty"`
	Error             string    `json:"error,omitempty"`
	State             string    `json:"state,omitempty"`
	DirtyOverlay      bool      `json:"dirtyOverlay,omitempty"`
	HydratedBlobCount int64     `json:"hydratedBlobCount,omitempty"`
	HydratedBlobBytes int64     `json:"hydratedBlobBytes,omitempty"`
}

func runtimeEventWireFromEvent(event RuntimeEvent) runtimeEventWire {
	return runtimeEventWire{
		ID:                event.ID,
		RepoID:            string(event.RepoID),
		RepoName:          event.RepoName,
		Kind:              string(event.Kind),
		At:                event.At,
		HeadOID:           event.HeadOID,
		HeadRef:           event.HeadRef,
		Generation:        event.Generation,
		Path:              event.Path,
		ObjectOID:         event.ObjectOID,
		SizeBytes:         event.SizeBytes,
		Error:             event.Error,
		State:             event.State,
		DirtyOverlay:      event.DirtyOverlay,
		HydratedBlobCount: event.HydratedBlobCount,
		HydratedBlobBytes: event.HydratedBlobBytes,
	}
}

type warmupRequestWire struct {
	RepoID      string `json:"repoId"`
	RepoName    string `json:"repoName"`
	HeadOID     string `json:"headOid"`
	HeadRef     string `json:"headRef"`
	Generation  int64  `json:"generation"`
	ToolProfile string `json:"toolProfile,omitempty"`
	MaxFiles    int    `json:"maxFiles,omitempty"`
	MaxBytes    int64  `json:"maxBytes,omitempty"`
}

func warmupRequestWireFromRequest(req WarmupRequest) warmupRequestWire {
	return warmupRequestWire{
		RepoID:      string(req.RepoID),
		RepoName:    req.RepoName,
		HeadOID:     req.HeadOID,
		HeadRef:     req.HeadRef,
		Generation:  req.Generation,
		ToolProfile: req.ToolProfile,
		MaxFiles:    req.MaxFiles,
		MaxBytes:    req.MaxBytes,
	}
}

type warmupPlanWire struct {
	Tasks []hydrationTaskWire `json:"tasks"`
}

func (p warmupPlanWire) toModel() WarmupPlan {
	tasks := make([]model.HydrationTask, 0, len(p.Tasks))
	for _, task := range p.Tasks {
		tasks = append(tasks, task.toModel())
	}
	return WarmupPlan{Tasks: tasks}
}

type hydrationTaskWire struct {
	RepoID     string    `json:"repoId"`
	Path       string    `json:"path"`
	ObjectOID  string    `json:"objectOid"`
	Priority   int       `json:"priority"`
	Reason     string    `json:"reason,omitempty"`
	EnqueuedAt time.Time `json:"enqueuedAt,omitempty"`
}

func (t hydrationTaskWire) toModel() model.HydrationTask {
	return model.HydrationTask{
		RepoID:     model.RepoID(t.RepoID),
		Path:       t.Path,
		ObjectOID:  t.ObjectOID,
		Priority:   t.Priority,
		Reason:     t.Reason,
		EnqueuedAt: t.EnqueuedAt,
	}
}

type credentialRequestWire struct {
	RepoID    string `json:"repoId"`
	RepoName  string `json:"repoName"`
	RemoteURL string `json:"remoteUrl"`
	SecretRef string `json:"secretRef,omitempty"`
}

func credentialRequestWireFromRequest(req CredentialRequest) credentialRequestWire {
	return credentialRequestWire{
		RepoID:    string(req.RepoID),
		RepoName:  req.RepoName,
		RemoteURL: req.RemoteURL,
		SecretRef: req.SecretRef,
	}
}

type credentialEnvWire struct {
	SafeRemoteURL string    `json:"safeRemoteUrl"`
	Env           []string  `json:"env"`
	ExpiresAt     time.Time `json:"expiresAt,omitempty"`
}

func (c credentialEnvWire) toModel() CredentialEnv {
	return CredentialEnv{
		SafeRemoteURL: c.SafeRemoteURL,
		Env:           c.Env,
		ExpiresAt:     c.ExpiresAt,
	}
}
