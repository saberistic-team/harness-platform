import { FakeModel, OpenAICompatibleModel, type Model } from "@harness/models";
import {
  validateLocalDockerHost,
  validateSandboxImage,
} from "@harness/sandbox-runner";
import type { AgentSandboxOptions } from "./sandbox-tool";

export interface AgentModelRegistry {
  models: Record<string, () => Model>;
  defaultModel: string;
}

export interface AgentServerEnvironmentConfig {
  authToken?: string;
  allowPlaintextRemote: boolean;
  /** Shared durable session/event store used by every connection and replica. */
  databaseUrl?: string;
  /** Deployment-owned path that must exist before the service is Ready. */
  readinessPath?: string;
  sandbox?: AgentSandboxOptions;
}

const SANDBOX_ENVIRONMENT_KEYS = [
  "HARNESS_SANDBOX_IMAGE",
  "HARNESS_SANDBOX_TRUST_LOCAL_IMAGE",
  "HARNESS_DOCKER_HOST",
  "HARNESS_DOCKER_BINARY",
] as const;

// Keep this aligned with the model-name bound in @harness/acp's initialize
// result and session/new request schemas.
const ACP_MODEL_NAME_MAX_LENGTH = 256;
const MAX_PROVIDER_HEADER_VALUE_LENGTH = 16_384;

function nonEmptyEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must be non-empty when set`);
  }
  return normalized;
}

function exactBooleanEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly "true" or "false" when set`);
}

function postgresEnvironmentValue(env: NodeJS.ProcessEnv): string | undefined {
  const value = nonEmptyEnvironmentValue(env, "HARNESS_DATABASE_URL") ??
    nonEmptyEnvironmentValue(env, "DATABASE_URL");
  if (value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("HARNESS_DATABASE_URL must be an absolute PostgreSQL URL");
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname
  ) {
    throw new Error("HARNESS_DATABASE_URL must use postgres:// or postgresql://");
  }
  return value;
}

function providerHeaderEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: "OPENAI_API_KEY" | "OPENAI_ORG_ID" | "OPENAI_PROJECT_ID",
): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty when set`);
  }
  if (value !== value.trim()) {
    throw new Error(`${name} must not have leading or trailing whitespace`);
  }
  if (
    value.length > MAX_PROVIDER_HEADER_VALUE_LENGTH ||
    !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new Error(
      `${name} must be a printable ASCII header value no longer than ${MAX_PROVIDER_HEADER_VALUE_LENGTH} characters`,
    );
  }
  // Credentials are opaque. Validate them, but never normalize or rewrite
  // them before they reach the provider adapter.
  return value;
}

/**
 * Parses service-only transport and sandbox configuration. Sandbox execution
 * remains disabled when no sandbox variable is present; any partial sandbox
 * configuration fails closed unless it includes an image.
 */
export function agentServerConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AgentServerEnvironmentConfig {
  const allowPlaintextRemote = exactBooleanEnvironmentValue(
    env,
    "HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE",
  ) ?? false;
  const authToken = nonEmptyEnvironmentValue(env, "HARNESS_AGENT_TOKEN");
  const databaseUrl = postgresEnvironmentValue(env);
  const readinessPath = nonEmptyEnvironmentValue(env, "HARNESS_AGENT_READINESS_PATH");
  const shared = {
    ...(authToken ? { authToken } : {}),
    allowPlaintextRemote,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(readinessPath ? { readinessPath } : {}),
  };
  const sandboxConfigured = SANDBOX_ENVIRONMENT_KEYS.some(
    (name) => env[name] !== undefined,
  );
  if (!sandboxConfigured) {
    return {
      ...shared,
    };
  }

  const image = nonEmptyEnvironmentValue(env, "HARNESS_SANDBOX_IMAGE");
  if (!image) {
    throw new Error(
      "HARNESS_SANDBOX_IMAGE is required when sandbox runner configuration is set",
    );
  }
  const trustedLocalImage = exactBooleanEnvironmentValue(
    env,
    "HARNESS_SANDBOX_TRUST_LOCAL_IMAGE",
  );
  const dockerHost = nonEmptyEnvironmentValue(env, "HARNESS_DOCKER_HOST");
  const dockerBinary = nonEmptyEnvironmentValue(env, "HARNESS_DOCKER_BINARY");
  validateSandboxImage(
    image,
    trustedLocalImage === true ? true : undefined,
  );
  if (dockerHost) validateLocalDockerHost(dockerHost);
  if (dockerBinary && /[\u0000-\u001f\u007f]/u.test(dockerBinary)) {
    throw new Error("HARNESS_DOCKER_BINARY must not contain control characters");
  }

  return {
    ...shared,
    sandbox: {
      image,
      ...(trustedLocalImage === true ? { trustedLocalImage: true } : {}),
      ...(dockerHost ? { dockerHost } : {}),
      ...(dockerBinary ? { dockerBinary } : {}),
    },
  };
}

/**
 * Provider credentials are read only at the service boundary. They never enter
 * ACP params, task manifests, kernel events, or sandbox environments.
 */
export function modelRegistryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): AgentModelRegistry {
  const apiKey = providerHeaderEnvironmentValue(env, "OPENAI_API_KEY");
  const organization = providerHeaderEnvironmentValue(env, "OPENAI_ORG_ID");
  const project = providerHeaderEnvironmentValue(env, "OPENAI_PROJECT_ID");
  const modelConfigured = env.HARNESS_MODEL_ID !== undefined;
  const baseUrlConfigured = env.HARNESS_MODEL_BASE_URL !== undefined;
  if (modelConfigured || baseUrlConfigured) {
    if (!modelConfigured || !baseUrlConfigured) {
      throw new Error("HARNESS_MODEL_ID and HARNESS_MODEL_BASE_URL must be set together");
    }
    const providerModel = nonEmptyEnvironmentValue(env, "HARNESS_MODEL_ID")!;
    const baseUrl = nonEmptyEnvironmentValue(env, "HARNESS_MODEL_BASE_URL")!;
    const options = {
      model: providerModel,
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(project !== undefined ? { project } : {}),
    };

    // Construction is offline and validates the endpoint, model ID, account
    // headers, and credential/transport combination before the service binds.
    const validatedModel = new OpenAICompatibleModel(options);
    const advertised = validatedModel.name;
    if (Buffer.byteLength(advertised, "utf8") > ACP_MODEL_NAME_MAX_LENGTH) {
      throw new Error(
        `advertised model name must be at most ${ACP_MODEL_NAME_MAX_LENGTH} UTF-8 bytes for ACP`,
      );
    }
    return {
      defaultModel: advertised,
      models: {
        [advertised]: () => new OpenAICompatibleModel(options),
      },
    };
  }
  const name = "fake-model/v1";
  return { defaultModel: name, models: { [name]: () => new FakeModel() } };
}
