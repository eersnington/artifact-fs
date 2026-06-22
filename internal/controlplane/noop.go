package controlplane

import (
	"context"
)

type NoopCoordinator struct{}

func NewNoop() NoopCoordinator {
	return NoopCoordinator{}
}

func (NoopCoordinator) DesiredRepos(context.Context, HostInfo) (DesiredRepoSet, error) {
	return DesiredRepoSet{}, nil
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
