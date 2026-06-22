package registry

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cloudflare/artifact-fs/internal/meta"
	"github.com/cloudflare/artifact-fs/internal/model"
)

var migrations = []string{
	`CREATE TABLE IF NOT EXISTS repos (
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
	  managed_by TEXT NOT NULL DEFAULT 'local',
	  desired_owner TEXT NOT NULL DEFAULT '',
	  created_at_ns INTEGER NOT NULL,
	  updated_at_ns INTEGER NOT NULL
	);`,
}

type Store struct {
	db *sql.DB
}

func New(ctx context.Context, dbPath string) (*Store, error) {
	db, err := meta.OpenDB(dbPath)
	if err != nil {
		return nil, err
	}
	if err := meta.ExecMigrations(ctx, db, migrations); err != nil {
		return nil, err
	}
	if err := ensureRepoColumn(ctx, db, "managed_by", "TEXT NOT NULL DEFAULT 'local'"); err != nil {
		return nil, err
	}
	if err := ensureRepoColumn(ctx, db, "desired_owner", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) AddRepo(ctx context.Context, cfg model.RepoConfig) error {
	if cfg.ManagedBy == "" {
		cfg.ManagedBy = model.RepoManagedByLocal
	}
	now := time.Now().UnixNano()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO repos (repo_id, name, mount_root, mount_path, remote_url_redacted, remote_url_secret_ref, branch, refresh_interval_seconds, git_dir, overlay_dir, blob_cache_dir, meta_db_path, overlay_db_path, enabled, managed_by, desired_owner, created_at_ns, updated_at_ns)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(repo_id) DO UPDATE SET
		name=excluded.name,
		mount_root=excluded.mount_root,
		mount_path=excluded.mount_path,
		remote_url_redacted=excluded.remote_url_redacted,
		remote_url_secret_ref=excluded.remote_url_secret_ref,
		branch=excluded.branch,
		refresh_interval_seconds=excluded.refresh_interval_seconds,
		git_dir=excluded.git_dir,
		overlay_dir=excluded.overlay_dir,
		blob_cache_dir=excluded.blob_cache_dir,
		meta_db_path=excluded.meta_db_path,
		overlay_db_path=excluded.overlay_db_path,
		enabled=excluded.enabled,
		managed_by=excluded.managed_by,
		desired_owner=excluded.desired_owner,
		updated_at_ns=excluded.updated_at_ns
		`, string(cfg.ID), cfg.Name, cfg.MountRoot, cfg.MountPath, cfg.RemoteURLRedacted, cfg.RemoteURLSecretRef, cfg.Branch, int64(cfg.RefreshInterval.Seconds()), cfg.GitDir, cfg.OverlayDir, cfg.BlobCacheDir, cfg.MetaDBPath, cfg.OverlayDBPath, boolToInt(cfg.Enabled), cfg.ManagedBy, cfg.DesiredOwner, now, now)
	return err
}

func (s *Store) RemoveRepo(ctx context.Context, name string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM repos WHERE name=?`, name)
	return err
}

func (s *Store) GetRepo(ctx context.Context, name string) (model.RepoConfig, error) {
	row := s.db.QueryRowContext(ctx, `SELECT repo_id, name, mount_root, mount_path, remote_url_redacted, remote_url_secret_ref, branch, refresh_interval_seconds, git_dir, overlay_dir, blob_cache_dir, meta_db_path, overlay_db_path, enabled, managed_by, desired_owner FROM repos WHERE name=?`, name)
	return scanRepo(row)
}

func (s *Store) ListRepos(ctx context.Context) ([]model.RepoConfig, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT repo_id, name, mount_root, mount_path, remote_url_redacted, remote_url_secret_ref, branch, refresh_interval_seconds, git_dir, overlay_dir, blob_cache_dir, meta_db_path, overlay_db_path, enabled, managed_by, desired_owner FROM repos ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.RepoConfig, 0)
	for rows.Next() {
		cfg, err := scanRepo(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, cfg)
	}
	return out, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scanRepo(s scanner) (model.RepoConfig, error) {
	var cfg model.RepoConfig
	var refresh int64
	var enabled int
	var secretRef sql.NullString
	if err := s.Scan(&cfg.ID, &cfg.Name, &cfg.MountRoot, &cfg.MountPath, &cfg.RemoteURLRedacted, &secretRef, &cfg.Branch, &refresh, &cfg.GitDir, &cfg.OverlayDir, &cfg.BlobCacheDir, &cfg.MetaDBPath, &cfg.OverlayDBPath, &enabled, &cfg.ManagedBy, &cfg.DesiredOwner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return cfg, fmt.Errorf("repo not found")
		}
		return cfg, err
	}
	if secretRef.Valid {
		cfg.RemoteURLSecretRef = secretRef.String
	}
	cfg.RefreshInterval = time.Duration(refresh) * time.Second
	cfg.Enabled = enabled == 1
	if cfg.ManagedBy == "" {
		cfg.ManagedBy = model.RepoManagedByLocal
	}
	if cfg.RemoteURLSecretRef == "" && cfg.RemoteURLRedacted != "" && !strings.Contains(cfg.RemoteURLRedacted, "REDACTED") {
		cfg.RemoteURL = cfg.RemoteURLRedacted
	}
	return cfg, nil
}

func ensureRepoColumn(ctx context.Context, db *sql.DB, name string, definition string) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(repos)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var columnName string
		var columnType string
		var notNull int
		var defaultValue any
		var pk int
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if columnName == name {
			return rows.Err()
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE repos ADD COLUMN %s %s`, name, definition))
	return err
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
