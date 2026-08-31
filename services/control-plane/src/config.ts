import { ControlPlaneError } from "./errors";
import type { S3ObjectStoreOptions } from "./s3";

export interface ControlPlaneConfig {
  host: string;
  port: number;
  authToken?: string;
  inMemory: boolean;
  databaseUrl?: string;
  s3?: S3ObjectStoreOptions;
  maxRequestBytes: number;
  maxInFlightRequests: number;
  maxArtifactBytes: number;
  defaultLeaseMs: number;
  maxLeaseMs: number;
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  if (raw.trim().length === 0 || raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new ControlPlaneError("CP_INVALID_INPUT", `${name} must be a non-empty value without surrounding whitespace`);
  }
  return raw;
}

function exactBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ControlPlaneError("CP_INVALID_INPUT", `${name} must be exactly true or false`);
}

function integer(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ControlPlaneError("CP_INVALID_INPUT", `${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function databaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmpty(env, "DATABASE_URL") ?? nonEmpty(env, "HARNESS_DATABASE_URL");
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError("CP_INVALID_INPUT", "DATABASE_URL must be an absolute PostgreSQL URL");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || !url.hostname) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "DATABASE_URL must use postgres:// or postgresql://");
  }
  return value;
}

function s3Options(env: NodeJS.ProcessEnv, inMemory: boolean): S3ObjectStoreOptions | undefined {
  const endpoint = nonEmpty(env, "HARNESS_ARTIFACT_ENDPOINT");
  const bucket = nonEmpty(env, "HARNESS_ARTIFACT_BUCKET");
  const region = nonEmpty(env, "HARNESS_ARTIFACT_REGION") ?? nonEmpty(env, "AWS_REGION") ?? "us-east-1";
  const accessKeyId = nonEmpty(env, "HARNESS_ARTIFACT_ACCESS_KEY") ?? nonEmpty(env, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = nonEmpty(env, "HARNESS_ARTIFACT_SECRET_KEY") ?? nonEmpty(env, "AWS_SECRET_ACCESS_KEY");
  const sessionToken = nonEmpty(env, "AWS_SESSION_TOKEN");
  const configured = endpoint !== undefined || bucket !== undefined || accessKeyId !== undefined || secretAccessKey !== undefined;
  if (!configured && inMemory) return undefined;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      "artifact storage requires endpoint, bucket, access key, and secret key",
    );
  }
  return {
    endpoint,
    bucket,
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
    },
    allowHttp: exactBoolean(env, "HARNESS_ARTIFACT_ALLOW_HTTP", false),
    forcePathStyle: exactBoolean(env, "HARNESS_ARTIFACT_FORCE_PATH_STYLE", false),
    requestTimeoutMs: integer(env, "HARNESS_ARTIFACT_TIMEOUT_MS", 30_000, 100, 300_000),
  };
}

/** Parse service configuration once, before binding a socket. */
export function controlPlaneConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneConfig {
  const inMemory = exactBoolean(env, "HARNESS_CONTROL_PLANE_IN_MEMORY", false);
  const db = databaseUrl(env);
  if (!inMemory && !db) {
    throw new ControlPlaneError(
      "CP_INVALID_INPUT",
      "DATABASE_URL is required unless HARNESS_CONTROL_PLANE_IN_MEMORY=true",
    );
  }
  const host = nonEmpty(env, "HARNESS_CONTROL_PLANE_HOST") ?? "127.0.0.1";
  const port = integer(env, "HARNESS_CONTROL_PLANE_PORT", 8780, 0, 65_535);
  const authToken = nonEmpty(env, "HARNESS_CONTROL_PLANE_TOKEN");
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !authToken) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "a non-loopback control plane requires an auth token");
  }
  const maxLeaseMs = integer(env, "HARNESS_CONTROL_PLANE_MAX_LEASE_MS", 15 * 60_000, 1_000, 24 * 60 * 60_000);
  const defaultLeaseMs = integer(env, "HARNESS_CONTROL_PLANE_LEASE_MS", 60_000, 1_000, maxLeaseMs);
  const s3 = s3Options(env, inMemory);
  return {
    host,
    port,
    ...(authToken === undefined ? {} : { authToken }),
    inMemory,
    ...(db === undefined ? {} : { databaseUrl: db }),
    ...(s3 === undefined ? {} : { s3 }),
    maxRequestBytes: integer(env, "HARNESS_CONTROL_PLANE_MAX_REQUEST_BYTES", 24 * 1024 * 1024, 1_024, 64 * 1024 * 1024),
    maxInFlightRequests: integer(env, "HARNESS_CONTROL_PLANE_MAX_IN_FLIGHT_REQUESTS", 256, 1, 10_000),
    maxArtifactBytes: integer(env, "HARNESS_CONTROL_PLANE_MAX_ARTIFACT_BYTES", 16 * 1024 * 1024, 1, 48 * 1024 * 1024),
    defaultLeaseMs,
    maxLeaseMs,
  };
}
