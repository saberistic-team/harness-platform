# Kubernetes (M4 — later, deliberately)

Phase rule: **Docker before Kubernetes.** This directory stays empty of
manifests until the control plane exists and we have a reason for more
than two containers.

When it lands (M4, expected pieces):

- `namespace.yaml` — `harness` namespace, resource quotas
- `control-plane/` — Deployment + Service + PVC (Postgres) + Secret (S3 creds)
- `agent-server/` — Deployment + Service (WebSocket) + HPA
- `sandbox-runner/` — Job-per-run pattern (dynamic Jobs, no long-lived runners)
- `networkpolicy/` — default-deny egress per namespace (mirrors `network: deny`)

No hand-written Helm in M4; a chart is justified only after M5.
