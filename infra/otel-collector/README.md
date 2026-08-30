# Local OpenTelemetry collector (ROADMAP M2 — "kernel -> CLI -> local
# collector", pre-Kubernetes: Docker first).

Pinned image (upgrade deliberately — the collector is a wire-format
boundary):

#   docker compose -f infra/docker/docker-compose.yml up otel-collector
#   OTEL_EXPORT_OTLP_ENDPOINT=http://127.0.0.1:4318 pnpm evals

Without a collector, the harness falls back to the console sink
(HARNESS_OTEL=1, no endpoint) — same spans, printed to stdout.
