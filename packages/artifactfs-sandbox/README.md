# ArtifactFS Sandbox

Cloudflare Worker + Sandbox container for mounting a Git repo with ArtifactFS and reading it over HTTP.

## Deploy

```sh
cd packages/artifactfs-sandbox
pnpm install
pnpx wrangler secret put ARTIFACTS_SANDBOX_API_TOKEN
pnpx wrangler deploy
```

## API

All routes except `GET /` require `Authorization: Bearer <token>`.

### Mount

```sh
curl -X POST https://<worker>/mount \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -d '{"sandboxId":"demo","remote":"https://github.com/cloudflare/artifact-fs.git","branch":"main"}'
```

### Inspect

```sh
curl -H 'authorization: Bearer <token>' \
  'https://<worker>/status?sandboxId=demo'

curl -H 'authorization: Bearer <token>' \
  'https://<worker>/tree?sandboxId=demo&path=cmd'

curl -H 'authorization: Bearer <token>' \
  'https://<worker>/file?sandboxId=demo&path=README.md'
```

## Limits

- Accepts public HTTPS and SSH Git remotes.
- Rejects credentials in remote URLs.
- Exposes status, directory listing, and text file reads.
- Container disk is ephemeral across stop/restart.
