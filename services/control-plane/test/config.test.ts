import { describe, expect, it } from "vitest";
import { controlPlaneConfigFromEnvironment } from "../src/config";

describe("control-plane environment configuration", () => {
  it("requires durable services by default", () => {
    expect(() => controlPlaneConfigFromEnvironment({})).toThrow(/DATABASE_URL/u);
  });

  it("supports an explicit offline in-memory mode", () => {
    const config = controlPlaneConfigFromEnvironment({
      HARNESS_CONTROL_PLANE_IN_MEMORY: "true",
      HARNESS_CONTROL_PLANE_PORT: "0",
    });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      inMemory: true,
      defaultLeaseMs: 60_000,
      maxInFlightRequests: 256,
    });
    expect(config).not.toHaveProperty("databaseUrl");
    expect(config).not.toHaveProperty("s3");
  });

  it("parses Postgres and S3/MinIO settings without rewriting credentials", () => {
    const config = controlPlaneConfigFromEnvironment({
      DATABASE_URL: "postgres://control:db-secret@postgres/harness?sslmode=disable",
      HARNESS_ARTIFACT_ENDPOINT: "http://minio:9000",
      HARNESS_ARTIFACT_BUCKET: "harness-artifacts",
      HARNESS_ARTIFACT_ACCESS_KEY: "access-value",
      HARNESS_ARTIFACT_SECRET_KEY: "secret-value",
      HARNESS_ARTIFACT_ALLOW_HTTP: "true",
      HARNESS_ARTIFACT_FORCE_PATH_STYLE: "true",
    });
    expect(config.databaseUrl).toContain("postgres://");
    expect(config.s3).toMatchObject({
      endpoint: "http://minio:9000",
      bucket: "harness-artifacts",
      forcePathStyle: true,
      allowHttp: true,
      credentials: { accessKeyId: "access-value", secretAccessKey: "secret-value" },
    });
  });

  it("requires auth for configured non-loopback listeners and exact booleans", () => {
    expect(() => controlPlaneConfigFromEnvironment({
      HARNESS_CONTROL_PLANE_IN_MEMORY: "true",
      HARNESS_CONTROL_PLANE_HOST: "0.0.0.0",
    })).toThrow(/auth token/u);
    expect(() => controlPlaneConfigFromEnvironment({
      HARNESS_CONTROL_PLANE_IN_MEMORY: "yes",
    })).toThrow(/exactly true or false/u);
  });

  it("bounds the configured in-flight request limit", () => {
    expect(controlPlaneConfigFromEnvironment({
      HARNESS_CONTROL_PLANE_IN_MEMORY: "true",
      HARNESS_CONTROL_PLANE_MAX_IN_FLIGHT_REQUESTS: "17",
    }).maxInFlightRequests).toBe(17);
    expect(() => controlPlaneConfigFromEnvironment({
      HARNESS_CONTROL_PLANE_IN_MEMORY: "true",
      HARNESS_CONTROL_PLANE_MAX_IN_FLIGHT_REQUESTS: "0",
    })).toThrow(/MAX_IN_FLIGHT_REQUESTS/u);
  });
});
