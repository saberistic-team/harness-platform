import { describe, expect, it } from "vitest";
import { acpInitializeResultSchema } from "@harness/acp";
import { FakeModel } from "@harness/models";
import {
  agentServerConfigFromEnvironment,
  modelRegistryFromEnvironment,
  startAgentServer,
} from "../src";

describe("agent-server environment configuration", () => {
  const digestImage = "example.test/harness@sha256:" + "d".repeat(64);

  it("keeps the sandbox disabled when no sandbox setting is present", () => {
    expect(agentServerConfigFromEnvironment({})).toEqual({
      allowPlaintextRemote: false,
    });
  });

  it("maps explicit transport and sandbox settings", () => {
    expect(agentServerConfigFromEnvironment({
      HARNESS_AGENT_TOKEN: "  a-secret-token  ",
      HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE: "true",
      HARNESS_SANDBOX_IMAGE: digestImage,
      HARNESS_SANDBOX_TRUST_LOCAL_IMAGE: "true",
      HARNESS_DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      HARNESS_DOCKER_BINARY: "/usr/local/bin/docker",
    })).toEqual({
      authToken: "a-secret-token",
      allowPlaintextRemote: true,
      sandbox: {
        image: digestImage,
        trustedLocalImage: true,
        dockerHost: "unix:///run/user/1000/docker.sock",
        dockerBinary: "/usr/local/bin/docker",
      },
    });
  });

  it("accepts an exact false trust attestation without converting it to true", () => {
    expect(agentServerConfigFromEnvironment({
      HARNESS_SANDBOX_IMAGE: digestImage,
      HARNESS_SANDBOX_TRUST_LOCAL_IMAGE: "false",
    }).sandbox).toEqual({
      image: digestImage,
    });
  });

  it.each([
    ["HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE", "1"],
    ["HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE", "TRUE"],
    ["HARNESS_AGENT_ALLOW_PLAINTEXT_REMOTE", " true"],
    ["HARNESS_SANDBOX_TRUST_LOCAL_IMAGE", "yes"],
    ["HARNESS_SANDBOX_TRUST_LOCAL_IMAGE", "False"],
  ])("rejects non-exact boolean %s=%j", (name, value) => {
    expect(() => agentServerConfigFromEnvironment({
      HARNESS_SANDBOX_IMAGE: digestImage,
      [name]: value,
    })).toThrow(`${name} must be exactly \"true\" or \"false\"`);
  });

  it.each([
    "HARNESS_SANDBOX_TRUST_LOCAL_IMAGE",
    "HARNESS_DOCKER_HOST",
    "HARNESS_DOCKER_BINARY",
  ])("requires an image when %s configures the sandbox", (name) => {
    expect(() => agentServerConfigFromEnvironment({
      [name]: name === "HARNESS_SANDBOX_TRUST_LOCAL_IMAGE" ? "false" : "value",
    })).toThrow("HARNESS_SANDBOX_IMAGE is required");
  });

  it("rejects mutable images unless local trust is explicitly true", () => {
    expect(() => agentServerConfigFromEnvironment({
      HARNESS_SANDBOX_IMAGE: "harness-sandbox:latest",
    })).toThrow("is not immutable");
    expect(agentServerConfigFromEnvironment({
      HARNESS_SANDBOX_IMAGE: "harness-sandbox:local",
      HARNESS_SANDBOX_TRUST_LOCAL_IMAGE: "true",
    }).sandbox).toMatchObject({
      image: "harness-sandbox:local",
      trustedLocalImage: true,
    });
  });

  it("rejects remote Docker endpoints during startup configuration", () => {
    expect(() => agentServerConfigFromEnvironment({
      HARNESS_SANDBOX_IMAGE: digestImage,
      HARNESS_DOCKER_HOST: "tcp://docker.example:2376",
    })).toThrow("expected an absolute unix:///");
  });
});

describe("agent-server provider model environment configuration", () => {
  const providerEnvironment = {
    HARNESS_MODEL_ID: "provider-model",
    HARNESS_MODEL_BASE_URL: "https://provider.example/v1",
  };

  it("uses FakeModel only when provider selectors are absent", () => {
    const registry = modelRegistryFromEnvironment({});
    expect(registry.defaultModel).toBe("fake-model/v1");
    expect(registry.models[registry.defaultModel]!()).toBeInstanceOf(FakeModel);
  });

  it.each([
    { HARNESS_MODEL_ID: "provider-model" },
    { HARNESS_MODEL_BASE_URL: "https://provider.example/v1" },
  ])("rejects partial provider selection: %j", (environment) => {
    expect(() => modelRegistryFromEnvironment(environment)).toThrow(
      "HARNESS_MODEL_ID and HARNESS_MODEL_BASE_URL must be set together",
    );
  });

  it.each([
    { HARNESS_MODEL_ID: "", HARNESS_MODEL_BASE_URL: "" },
    { HARNESS_MODEL_ID: "   ", HARNESS_MODEL_BASE_URL: "https://provider.example/v1" },
    { HARNESS_MODEL_ID: "provider-model", HARNESS_MODEL_BASE_URL: "\t" },
  ])("rejects present-but-empty provider selection: %j", (environment) => {
    expect(() => modelRegistryFromEnvironment(environment)).toThrow(
      /HARNESS_MODEL_(?:ID|BASE_URL) must be non-empty when set/u,
    );
  });

  it.each(["OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"] as const)(
    "rejects an explicitly empty %s",
    (name) => {
      expect(() => modelRegistryFromEnvironment({ [name]: "  " })).toThrow(
        `${name} must be non-empty when set`,
      );
    },
  );

  it("validates provider secrets without changing accepted values", () => {
    const environment = {
      ...providerEnvironment,
      OPENAI_API_KEY: "sk-test_+/=.",
      OPENAI_ORG_ID: "org-test_1",
      OPENAI_PROJECT_ID: "project-test_1",
    };
    const registry = modelRegistryFromEnvironment(environment);
    const model = registry.models[registry.defaultModel]!() as unknown as {
      apiKey?: string;
      organization?: string;
      project?: string;
    };
    expect(model.apiKey).toBe(environment.OPENAI_API_KEY);
    expect(model.organization).toBe(environment.OPENAI_ORG_ID);
    expect(model.project).toBe(environment.OPENAI_PROJECT_ID);
  });

  it.each([
    ["OPENAI_API_KEY", " secret"],
    ["OPENAI_ORG_ID", "org\nheader"],
    ["OPENAI_PROJECT_ID", "project-\u00e9"],
  ] as const)("rejects unsafe provider header %s", (name, value) => {
    expect(() => modelRegistryFromEnvironment({
      ...providerEnvironment,
      [name]: value,
    })).toThrow(name);
  });

  it("validates provider construction before returning the registry", () => {
    expect(() => modelRegistryFromEnvironment({
      ...providerEnvironment,
      HARNESS_MODEL_BASE_URL: "http://provider.example/v1",
    })).toThrow("plaintext model provider URLs are allowed only for loopback hosts");
    expect(() => modelRegistryFromEnvironment({
      ...providerEnvironment,
      HARNESS_MODEL_BASE_URL: "http://127.0.0.1:8080/v1",
      OPENAI_API_KEY: "must-not-cross-plaintext",
    })).toThrow("credentials and account headers require HTTPS");
  });

  it("keeps advertised model names within the ACP wire limit", () => {
    const prefix = "openai-compatible/";
    const modelId = "m".repeat(256 - prefix.length);
    const registry = modelRegistryFromEnvironment({
      HARNESS_MODEL_ID: modelId,
      HARNESS_MODEL_BASE_URL: "https://provider.example/v1",
    });
    expect(acpInitializeResultSchema.safeParse({
      protocolVersion: "harness/acp/1",
      agentName: "harness-agent-server",
      capabilities: {},
      models: Object.keys(registry.models),
    }).success).toBe(true);

    expect(() => modelRegistryFromEnvironment({
      HARNESS_MODEL_ID: `${modelId}m`,
      HARNESS_MODEL_BASE_URL: "https://provider.example/v1",
    })).toThrow("advertised model name must be at most 256 UTF-8 bytes for ACP");

    expect(() => modelRegistryFromEnvironment({
      HARNESS_MODEL_ID: "💡".repeat(80),
      HARNESS_MODEL_BASE_URL: "https://provider.example/v1",
    })).toThrow("advertised model name must be at most 256 UTF-8 bytes for ACP");
  });
});

describe("agent-server remote transport guard", () => {
  const baseOptions = {
    host: "0.0.0.0",
    port: 0,
    sessionDbPath: false as const,
    models: { fake: () => new FakeModel() },
  };

  it("requires token authentication before a non-loopback bind", async () => {
    await expect(startAgentServer({
      ...baseOptions,
      allowPlaintextRemote: true,
    })).rejects.toThrow("requires authToken");
  });

  it("requires an explicit plaintext opt-in before a non-loopback bind", async () => {
    await expect(startAgentServer({
      ...baseOptions,
      authToken: "a-secret-token",
    })).rejects.toThrow("requires allowPlaintextRemote: true");
  });

  it("does not accept a truthy non-boolean plaintext opt-in", async () => {
    await expect(startAgentServer({
      ...baseOptions,
      authToken: "a-secret-token",
      allowPlaintextRemote: "true" as unknown as boolean,
    })).rejects.toThrow("requires allowPlaintextRemote: true");
  });
});
