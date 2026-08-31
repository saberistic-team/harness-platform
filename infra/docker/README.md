# Docker infra (pre-Kubernetes: Docker first, K8s in M4)

See `docker-compose.yml` (MinIO + app) and `dev.Dockerfile`.

M3 adds `sandbox.Dockerfile`, deliberately separate from the privileged dev
image. Builds require a reviewed, immutable Node image reference:

```bash
docker build -f infra/docker/sandbox.Dockerfile \
  --build-arg NODE_IMAGE=node:22-alpine@sha256:<reviewed-64-hex-digest> \
  -t harness-sandbox:local .
```

The sandbox runner supplies the workspace mounts, network namespace, resource
limits, and uid at run time. The image itself contains no project source or
credentials and defaults to the non-root uid/gid 65532. Before trusting a local
tag, review the resulting image configuration and ensure it declares no
`VOLUME`: image-owned volumes could otherwise obscure a bind-mounted path.
