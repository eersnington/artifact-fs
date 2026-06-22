# syntax=docker/dockerfile:1

FROM golang:1.24 AS artifact-fs-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /artifact-fs ./cmd/artifact-fs

FROM docker.io/cloudflare/sandbox:0.8.1

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fuse3 \
    git \
    openssh-client \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

COPY --from=artifact-fs-build /artifact-fs /usr/local/bin/artifact-fs
COPY examples/rivet-artifact-sanbox/container_src/start.sh /usr/local/bin/rivet-artifact-start
COPY examples/rivet-artifact-sanbox/container_src/demo-rivet /opt/rivet-artifact-demo

RUN chmod +x /usr/local/bin/artifact-fs /usr/local/bin/rivet-artifact-start \
  && bun install --cwd /opt/rivet-artifact-demo --production

ENV ARTIFACT_FS_ROOT=/tmp/artifact-fs
ENV MOUNT_ROOT=/workspace/mnt
ENV DEMO_DIR=/tmp/rivet-artifact-demo
ENV DEMO_PORT=8788
