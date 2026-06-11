# syntax=docker/dockerfile:1

FROM golang:1.24 AS artifact-fs-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /artifact-fs ./cmd/artifact-fs

FROM docker.io/cloudflare/sandbox:0.8.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    fuse3 \
    git \
    openssh-client \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=artifact-fs-build /artifact-fs /usr/local/bin/artifact-fs
COPY packages/artifactfs-sandbox/container_src/mount-artifact-fs-repo.sh /usr/local/bin/mount-artifact-fs-repo

RUN chmod +x /usr/local/bin/artifact-fs /usr/local/bin/mount-artifact-fs-repo

ENV ARTIFACT_FS_ROOT=/tmp/artifact-fs
ENV MOUNT_ROOT=/workspace/mnt
ENV ARTIFACT_FS_MOUNT_METADATA_FILE=/workspace/.artifact-fs-mount
