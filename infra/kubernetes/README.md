# Kubernetes (M4)

This directory is the raw-Kustomize deployment contract for the M4 service
topology. It deliberately contains no Helm chart and no live credential.

The base is **not directly deployable from a clone**. Every workload image uses
an `example.invalid/...@sha256:000...` sentinel, and the four
`secret.*.example.yaml` files contain only `REPLACE_*` values. The stateful
references also use the deliberately unresolved `REPLACE_STORAGE_CLASS`. These
fail-closed placeholders make an unreviewed deployment stop instead of silently
pulling a mutable image, selecting an ambient storage class, or using a default
password.

## Layout

```text
kustomization.yaml             namespace, quota, limits, and all sub-bases
postgres/                      single-node StatefulSet reference
minio/                         single-node S3-compatible reference
control-plane/                 scheduler/API Deployment, Service, PDB, identity
agent-server/                  ACP Deployment, Service, PDB, and HPA
sandbox-runner/                isolated namespace, suspended Job contract, and deny-all networking
networkpolicy/                 default deny plus explicit required connections
secret.control-plane.example.yaml      control-plane runtime key contract
secret.agent-server.example.yaml       agent-server runtime key contract
secret.postgres-bootstrap.example.yaml reference Postgres bootstrap key contract
secret.minio-bootstrap.example.yaml    reference MinIO bootstrap key contract
```

The example Secret files are excluded from Kustomize output. They document
four independent trust domains and must never be applied as-is.

Postgres and MinIO are production-shaped, persistent reference deployments,
not highly available databases. Their PDBs prevent voluntary eviction of the
only replica. Use managed Postgres/S3 or a reviewed HA operator for a production
availability target, and remove those two sub-bases in the corresponding
overlay. Backups, restore drills, storage classes, encryption, retention, and
object-lock policy are cluster/operator responsibilities.

The reference stores use plaintext only on the policy-constrained in-cluster
network. A production environment must supply authenticated service-mesh/node
encryption for those hops or replace the references with TLS-enabled
Postgres/S3 endpoints; NetworkPolicy is isolation, not encryption.

## Required configuration

Before rendering an environment overlay:

1. Replace every `example.invalid` image with a reviewed immutable digest.
   Application images must provide the control-plane and agent-server entry
   points assumed by their Deployments. Never substitute a mutable tag.
2. Materialize four namespace-local Secrets through the cluster's external
   secret manager; use the matching example file only as its key contract:
   - `harness-control-plane-secrets` contains the control-plane database URL,
     artifact-store application credentials, and control-plane bearer token.
   - `harness-agent-server-secrets` contains the agent-server database URL,
     agent bearer token, and optional model-provider key.
   - `harness-postgres-bootstrap` contains only the reference database's
     bootstrap password.
   - `harness-minio-bootstrap` contains only the reference object store's root
     credentials.

   Do not apply the example files or commit populated copies. Do not copy either
   bootstrap credential into an application Secret. Set independent,
   high-entropy bearer tokens for the two APIs. A gateway needing a bearer token
   gets a separate copy managed in the gateway namespace; it must not read the
   server's Secret across namespaces.

   The reference Postgres StatefulSet does not terminate TLS, so both runtime
   URLs must refer to `harness-postgres:5432` and explicitly end with
   `?sslmode=disable`; they are separate values to support separate roles. A
   managed production database should use certificate validation, normally
   `sslmode=verify-full`, with a hostname covered by the database certificate.
3. Provision the `harness` bucket and a least-privilege MinIO/S3 principal that
   matches `HARNESS_ARTIFACT_ACCESS_KEY` and
   `HARNESS_ARTIFACT_SECRET_KEY`. Do not give the control plane MinIO root keys.
   Configure an environment-appropriate public artifact endpoint when signed
   URLs must be usable outside the cluster; the base endpoint is cluster-local.
4. Replace `REPLACE_STORAGE_CLASS` with an environment-specific encrypted
   storage class and review the capacity policy for both `volumeClaimTemplates`,
   or remove the stateful references when using managed services. Leaving the
   placeholder unresolved is intentionally non-deployable.

For external S3, change the artifact endpoint/region/path-style values on the
control-plane Deployment and add a narrowly scoped egress policy for the
approved S3 endpoint. For a live model provider, similarly add only its approved
egress path and set both provider model variables plus the provider key. The
base intentionally permits neither broad HTTPS egress nor arbitrary sandbox
network access.

### Database authorization and migrations

The reference application entry points auto-migrate their stores. Combined
with the bootstrap-owned reference database, that is a development convenience,
**not an authorization boundary**. A production overlay must instead:

1. run schema migrations in a database-privileged, one-shot Job using a
   dedicated migration credential (not a privileged container);
2. give control-plane and agent-server distinct least-privilege runtime roles
   and database URLs, scoped only to the tables and operations each service
   needs, with no schema ownership or DDL privileges; and
3. use a reviewed production image, command, or configuration that prevents the
   runtime processes from auto-migrating after the migration Job succeeds.

In particular, runtime roles should not gain broad `UPDATE` or `DELETE` access
to append-only event/audit data. The base cannot claim database privilege
separation until an overlay supplies this migration and role design. Never use
`harness-postgres-bootstrap` as a runtime database Secret.

## Network and transport

Every pod starts with ingress and egress denied. The base then permits only:

- the explicitly selected control-plane and agent-server pods to reach labeled
  `kube-dns` pods;
- agent-server to Postgres;
- control-plane to Postgres and MinIO;
- agent-server ingress from the explicitly labeled ACP gateway;
- control-plane ingress from the explicitly labeled control-plane gateway; and
- Postgres/MinIO ingress from their explicit service clients.

Sandbox pods run in `harness-sandboxes`. That namespace has its own deny-all
policy and no DNS or other egress exception. It contains no runtime Secret; a
Secret in `harness` cannot be mounted across the namespace boundary.

Gateway admission is an AND of namespace and pod labels:

| API | Required namespace label | Required pod label |
| --- | --- | --- |
| ACP / agent-server | `harness.dev/acp-ingress=true` | `harness.dev/acp-gateway=true` |
| control-plane HTTP | `harness.dev/control-plane-ingress=true` | `harness.dev/control-plane-gateway=true` |

Apply those labels only to dedicated gateway namespaces and gateway pods; do
not label a shared application namespace. Treat both namespace labels as
security-sensitive: cluster authorization/admission must restrict namespace
label mutation and pod creation in each gateway namespace. Terminate TLS at
both gateways. For ACP, expose `wss://` and suppress query strings from access
logs because the current bearer token is transported in the WebSocket upgrade
URL. Forward the control-plane `Authorization: Bearer` header without logging
it. The M4 control-plane token covers every non-health worker, operator,
artifact, audit, and signed-URL route; it is one trust domain, not route-level
authorization. Do not distribute it across mutually untrusted workers or
tenants, and suppress signed-URL query strings in object-store/gateway logs.
The internal listeners remain plaintext only on these policy-constrained hops.
These ingress policies do not grant gateway egress; the gateway namespace must
independently allow only the corresponding service destination.

NetworkPolicy enforcement requires a compatible CNI. Cluster DNS labels and
API endpoint routing vary by distribution, so validate both in the target
cluster. A manifest permission of `network: allow` does not automatically open
cluster egress: an environment-specific, destination-scoped NetworkPolicy must
also exist.

## Sandbox Jobs

`sandbox-runner/job-template.yaml` is packaged as the
`harness-sandbox-job-template` ConfigMap in `harness`; Kustomize does not create
the Job. The template targets the separate `harness-sandboxes` namespace.
Sandbox pods receive a namespace-local service account with token automount
disabled.

This is currently a deployment contract, not an active Kubernetes executor.
The M4 control-plane runtime exposes scheduling and lease APIs but does not yet
read this ConfigMap or materialize Jobs. Deploying these resources alone will
not cause queued runs to execute; a reviewed executor implementation must first
consume the contract and enforce every substitution described below.

The stored template is suspended and fail-closed. A future executor overlay
must add a narrowly scoped, namespace-local Role/RoleBinding; the M4 base grants
no workload Kubernetes API access. Before creating a run, that executor must
validate and replace the run ID, immutable image digest, argv, deadline,
workspace PVC, and any writable mounts derived from `allowed_paths`. It may
clear `spec.suspend` only after that validation is durable. The baseline
workspace mount is read-only; do not use `hostPath`, mount a container socket,
or turn the whole workspace writable. A network-enabled run requires a separate
reviewed policy selected by a run-specific label; none is supplied here.
Workspace PVCs must be staged by trusted infrastructure in
`harness-sandboxes`; no workload identity in the base can create or mutate
PVCs. No Secret should be created in that namespace. The agent-server's empty
`/workspace` volume is only a mount point: an environment overlay must stage
the reviewed workspace and its task manifests before task-backed sessions are
accepted.

## Security defaults

The namespace enforces the Restricted Pod Security Standard. Workloads run as
non-root, use a read-only root filesystem, drop all Linux capabilities, disable
privilege escalation and service links, use the runtime-default seccomp
profile, declare resource bounds, and receive only bounded writable temporary
volumes. No M4 workload mounts a Kubernetes API token. The sandbox namespace
also has independent CPU, memory, ephemeral-storage, pod, and Job limits.

Both namespaces pin Restricted Pod Security admission to Kubernetes `v1.32`
for enforce, audit, and warn. Pinning makes policy changes an explicit upgrade
decision instead of silently changing admission behavior when a cluster is
upgraded. The base therefore requires a Kubernetes 1.32-or-newer control plane.
An overlay targeting a newer Pod Security version must validate every rendered
workload first, then update all three version labels together.

Running two control-plane and two agent-server replicas assumes the services
use durable leases and fencing tokens in Postgres so only one owner can advance
a run or restore a session after failure. Both Deployments require their first
two replicas to spread across at least two nodes; a one-node cluster will leave
one replica pending by design.

### Secret rotation

Secret-backed environment variables are read only when a container starts.
Rotate application credentials by publishing the new value, rolling every
consumer, confirming readiness, and only then revoking the old value. Coordinate
bearer-token rotation with each gateway/client copy so no unauthenticated gap is
introduced. Prefer versioned external-secret material plus a checksum rollout
trigger or a reviewed restart controller.

Changing `POSTGRES_PASSWORD` in `harness-postgres-bootstrap` does not update the
password inside an already initialized data volume. Rotate that role in
Postgres, update dependent Secrets, roll and verify consumers, then revoke the
old credential. Root/bootstrap credentials should be rotated separately from
least-privilege application credentials and never used for normal traffic.

## Render and validate

Render without contacting a cluster:

```bash
kubectl kustomize infra/kubernetes
```

Before applying an overlay, fail the release if rendered output still contains
`example.invalid`, the all-zero digest, or `REPLACE_`. Then run
server-side dry-run and policy checks against the destination cluster. The HPA
also requires the cluster resource-metrics API.
