package controlplane

import (
	"context"

	"github.com/cloudflare/artifact-fs/internal/model"
)

type NoopCoordinator struct{}

func NewNoop() NoopCoordinator {
	return NoopCoordinator{}
}

func (NoopCoordinator) DesiredRepos(context.Context, HostInfo) ([]model.RepoConfig, error) {
	return nil, nil
}

func (NoopCoordinator) RecordEvent(context.Context, RuntimeEvent) error {
	return nil
}

func (NoopCoordinator) WarmupPlan(context.Context, WarmupRequest) (WarmupPlan, error) {
	return WarmupPlan{}, nil
}

func (NoopCoordinator) CredentialEnv(context.Context, CredentialRequest) (CredentialEnv, error) {
	return CredentialEnv{}, nil
}

func (NoopCoordinator) Close() error {
	return nil
}
