import { describe, expect, it } from "vitest";
import {
  ModelProviderError,
  OpenAICompatibleModel,
  estimateTokens,
  type CompletionRequest,
  type ModelProviderErrorCode,
  type OpenAICompatibleFetch,
} from "../src";

interface CapturedRequest {
  input: string | URL | Request;
  init?: RequestInit;
}

const defaultCompletion = {
  id: "chatcmpl-1",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "done" },
    },
  ],
  usage: {
    prompt_tokens: 7,
    completion_tokens: 2,
    total_tokens: 9,
  },
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fakeFetch(
  handler: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): OpenAICompatibleFetch {
  return (async (input, init) => handler(input, init)) as OpenAICompatibleFetch;
}

function createModel(
  fetch: OpenAICompatibleFetch,
  overrides: Partial<ConstructorParameters<typeof OpenAICompatibleModel>[0]> = {},
): OpenAICompatibleModel {
  return new OpenAICompatibleModel({
    baseUrl: "https://provider.test/v1",
    model: "test-model",
    apiKey: "test-secret",
    fetch,
    ...overrides,
  });
}

async function captureError(
  promise: Promise<unknown>,
): Promise<ModelProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderError);
    return error as ModelProviderError;
  }
  throw new Error("expected ModelProviderError");
}

describe("OpenAICompatibleModel", () => {
  it("maps messages, tool history, schemas, options, auth, and token limits", async () => {
    let captured: CapturedRequest | undefined;
    const transport = fakeFetch((input, init) => {
      captured = { input, init };
      return jsonResponse(defaultCompletion, 200, { "x-request-id": "req-1" });
    });
    const model = createModel(transport, {
      baseUrl: "https://provider.test/v1/?api-version=2026-08-31",
      organization: "org-1",
      project: "proj-1",
    });

    const result = await model.complete({
      system: "top-level system",
      messages: [
        { role: "system", content: "historical system" },
        { role: "user", content: "use the weather tool" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "weather",
              arguments: { city: "Paris" },
            },
          ],
        },
        {
          role: "tool",
          name: "weather",
          toolCallId: "call-1",
          content: '{"temperature":18}',
        },
      ],
      tools: [
        {
          name: "weather",
          description: "Get weather for a city",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      maxTokens: 123,
      providerOptions: { temperature: 0, metadata: { lane: "offline" } },
    });

    expect(result).toEqual({
      id: "chatcmpl-1",
      content: "done",
      toolCalls: [],
      usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
      finishReason: "stop",
    });
    expect(model.name).toBe("openai-compatible/test-model");
    expect(String(captured?.input)).toBe(
      "https://provider.test/v1/chat/completions?api-version=2026-08-31",
    );
    expect(captured?.init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });

    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
      "OpenAI-Organization": "org-1",
      "OpenAI-Project": "proj-1",
    });
    const body = JSON.parse(String(captured?.init?.body));
    expect(body).toEqual({
      temperature: 0,
      metadata: { lane: "offline" },
      model: "test-model",
      messages: [
        { role: "system", content: "top-level system" },
        { role: "system", content: "historical system" },
        { role: "user", content: "use the weather tool" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "weather",
                arguments: '{"city":"Paris"}',
              },
            },
          ],
        },
        {
          role: "tool",
          content: '{"temperature":18}',
          tool_call_id: "call-1",
        },
      ],
      stream: false,
      tools: [
        {
          type: "function",
          function: {
            name: "weather",
            description: "Get weather for a city",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
      ],
      max_tokens: 123,
    });
  });

  it("supports an endpoint URL directly and max_completion_tokens", async () => {
    let captured: CapturedRequest | undefined;
    const model = createModel(
      fakeFetch((input, init) => {
        captured = { input, init };
        return jsonResponse(defaultCompletion);
      }),
      {
        baseUrl: "https://provider.test/custom/chat/completions",
        maxTokensParameter: "max_completion_tokens",
      },
    );

    await model.complete({
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 44,
    });
    expect(String(captured?.input)).toBe(
      "https://provider.test/custom/chat/completions",
    );
    expect(JSON.parse(String(captured?.init?.body))).toMatchObject({
      max_completion_tokens: 44,
    });
  });

  it("decodes parallel function tool calls and nullable content", async () => {
    const model = createModel(
      fakeFetch(() =>
        jsonResponse({
          id: "chatcmpl-tools",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-a",
                    type: "function",
                    function: { name: "alpha", arguments: '{"x":1}' },
                  },
                  {
                    id: "call-b",
                    type: "function",
                    function: { name: "beta", arguments: "[1,2]" },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
      ),
    );

    const result = await model.complete({
      messages: [{ role: "user", content: "call both" }],
    });
    expect(result.content).toBe("");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call-a", name: "alpha", arguments: { x: 1 } },
      { id: "call-b", name: "beta", arguments: [1, 2] },
    ]);
  });

  it("uses a deterministic usage estimate when usage is absent", async () => {
    let body: Record<string, unknown> | undefined;
    const model = createModel(
      fakeFetch((_input, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          id: "chatcmpl-no-usage",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "fallback" },
            },
          ],
        });
      }),
    );
    const result = await model.complete({
      messages: [{ role: "user", content: "estimate me" }],
    });

    const prompt = JSON.stringify({
      messages: body?.messages,
      tools: [],
    });
    expect(result.usage).toEqual({
      promptTokens: estimateTokens(prompt),
      completionTokens: estimateTokens("fallback"),
      totalTokens: estimateTokens(prompt) + estimateTokens("fallback"),
    });
  });

  it.each([
    [401, "MODEL_AUTH_ERROR", false],
    [403, "MODEL_AUTH_ERROR", false],
    [429, "MODEL_RATE_LIMITED", true],
    [500, "MODEL_HTTP_ERROR", true],
    [422, "MODEL_HTTP_ERROR", false],
  ] as const)(
    "classifies HTTP %s as %s",
    async (status, code, retryable) => {
      const model = createModel(
        fakeFetch(() =>
          jsonResponse(
            {
              error: {
                message: `provider rejected test-secret at ${status}`,
                code: "provider_code",
              },
            },
            status,
            { "x-request-id": "provider-req-9" },
          ),
        ),
      );
      const error = await captureError(
        model.complete({ messages: [{ role: "user", content: "hi" }] }),
      );
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.retryable).toBe(retryable);
      expect(error.providerRequestId).toBe("provider-req-9");
      expect(error.providerCode).toBe("provider_code");
      expect(error.message).not.toContain("test-secret");
      expect(error.message).toContain("[REDACTED]");
      expect(error.cause).toBeUndefined();
    },
  );

  it("classifies a transport failure without leaking credentials", async () => {
    const model = createModel(
      fakeFetch(() => {
        throw new TypeError("connection failed for test-secret");
      }),
    );
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_TRANSPORT_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("[REDACTED]");
    expect(error.message).not.toContain("test-secret");
    expect(error.cause).toBeUndefined();
  });

  it("classifies its own timeout separately from caller cancellation", async () => {
    const hangingFetch = fakeFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const timeoutModel = createModel(hangingFetch, { timeoutMs: 5 });
    const timeout = await captureError(
      timeoutModel.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(timeout.code).toBe("MODEL_TIMEOUT");
    expect(timeout.retryable).toBe(true);

    const controller = new AbortController();
    const abortedModel = createModel(hangingFetch, { timeoutMs: 10_000 });
    const pending = abortedModel.complete({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    controller.abort();
    const aborted = await captureError(pending);
    expect(aborted.code).toBe("MODEL_ABORTED");
    expect(aborted.retryable).toBe(false);
  });

  it("enforces timeout and cancellation even when a custom transport ignores its signal", async () => {
    const ignoresAbort = fakeFetch(() => new Promise<Response>(() => {}));
    const timeoutModel = createModel(ignoresAbort, { timeoutMs: 5 });
    const timeout = await captureError(
      timeoutModel.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(timeout.code).toBe("MODEL_TIMEOUT");

    const controller = new AbortController();
    const cancelledModel = createModel(ignoresAbort, { timeoutMs: 10_000 });
    const pending = cancelledModel.complete({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await captureError(pending);
    expect(cancelled.code).toBe("MODEL_ABORTED");
  });

  it("does not misclassify a provider-originated AbortError as caller cancellation", async () => {
    const model = createModel(
      fakeFetch(() => {
        throw new DOMException("provider transport aborted", "AbortError");
      }),
    );
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_TRANSPORT_ERROR");
    expect(error.retryable).toBe(true);
  });

  it("rejects a request whose signal is already aborted before fetch", async () => {
    let called = false;
    const model = createModel(
      fakeFetch(() => {
        called = true;
        return jsonResponse(defaultCompletion);
      }),
    );
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      }),
    );
    expect(error.code).toBe("MODEL_ABORTED");
    expect(called).toBe(false);
  });

  it.each([
    {
      name: "invalid JSON",
      response: () => new Response("not-json", { status: 200 }),
      code: "MODEL_INVALID_RESPONSE",
    },
    {
      name: "missing fields",
      response: () => jsonResponse({ object: "chat.completion" }),
      code: "MODEL_INVALID_RESPONSE",
    },
    {
      name: "multiple choices",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            ...defaultCompletion.choices,
            { ...defaultCompletion.choices[0], index: 1 },
          ],
        }),
      code: "MODEL_INVALID_RESPONSE",
    },
    {
      name: "content filtering",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              ...defaultCompletion.choices[0],
              finish_reason: "content_filter",
              message: { role: "assistant", content: null },
            },
          ],
        }),
      code: "MODEL_CONTENT_FILTERED",
    },
    {
      name: "legacy function calls",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              ...defaultCompletion.choices[0],
              finish_reason: "function_call",
            },
          ],
        }),
      code: "MODEL_UNSUPPORTED_RESPONSE",
    },
    {
      name: "unknown finish reason",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            { ...defaultCompletion.choices[0], finish_reason: "new_reason" },
          ],
        }),
      code: "MODEL_UNSUPPORTED_RESPONSE",
    },
    {
      name: "missing tool calls",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            { ...defaultCompletion.choices[0], finish_reason: "tool_calls" },
          ],
        }),
      code: "MODEL_INVALID_RESPONSE",
    },
    {
      name: "invalid tool arguments",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "tool", arguments: "{" },
                  },
                ],
              },
            },
          ],
        }),
      code: "MODEL_INVALID_RESPONSE",
    },
    {
      name: "custom tool calls",
      response: () =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "custom",
                    custom: { name: "tool", input: "plain text" },
                  },
                ],
              },
            },
          ],
        }),
      code: "MODEL_UNSUPPORTED_RESPONSE",
    },
  ] satisfies Array<{
    name: string;
    response: () => Response;
    code: ModelProviderErrorCode;
  }>)("rejects $name responses with $code", async ({ response, code }) => {
    const model = createModel(fakeFetch(response));
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe(code);
  });

  it("rejects oversized responses", async () => {
    const model = createModel(
      fakeFetch(() => new Response("123456", { status: 200 })),
      { maxResponseBytes: 5 },
    );
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_INVALID_RESPONSE");
    expect(error.message).toContain("size limit");
  });

  it("bounds the response stream while reading and cancels an oversized body", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([0x61, 0x61]));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const model = createModel(fakeFetch(() => new Response(body)), {
      maxResponseBytes: 5,
    });
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_INVALID_RESPONSE");
    expect(error.message).toContain("size limit");
    expect(cancelled).toBe(1);
  });

  it("rejects invalid UTF-8 instead of silently replacing bytes", async () => {
    const model = createModel(
      fakeFetch(() => new Response(new Uint8Array([0xc3, 0x28]))),
    );
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_INVALID_RESPONSE");
    expect(error.message).toContain("UTF-8");
  });

  it("rejects an oversized request before invoking fetch", async () => {
    let called = false;
    const model = createModel(
      fakeFetch(() => {
        called = true;
        return jsonResponse(defaultCompletion);
      }),
      { maxRequestBytes: 128 },
    );
    const error = await captureError(
      model.complete({
        messages: [{ role: "user", content: "x".repeat(256) }],
      }),
    );
    expect(error.code).toBe("MODEL_INVALID_REQUEST");
    expect(error.message).toContain("size limit");
    expect(called).toBe(false);
  });

  it.each([
    [
      "reserved provider field",
      { providerOptions: { model: "different" } },
    ],
    ["mismatched model", { model: "different" }],
    ["bad token limit", { maxTokens: 0 }],
    [
      "duplicate tools",
      {
        tools: [
          { name: "x", description: "x", inputSchema: { type: "object" } },
          { name: "x", description: "x", inputSchema: { type: "object" } },
        ],
      },
    ],
  ] as const)("rejects an invalid request: %s", async (_name, partial) => {
    const model = createModel(
      fakeFetch(() => {
        throw new Error("fetch must not be called");
      }),
    );
    const request = {
      messages: [{ role: "user", content: "hi" }],
      ...partial,
    } as CompletionRequest;
    const error = await captureError(model.complete(request));
    expect(error.code).toBe("MODEL_INVALID_REQUEST");
  });

  it("rejects circular provider options before fetch", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const model = createModel(fakeFetch(() => jsonResponse(defaultCompletion)));
    const error = await captureError(
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        providerOptions: { metadata: circular },
      }),
    );
    expect(error.code).toBe("MODEL_INVALID_REQUEST");
    expect(error.message).toContain("circular");
  });

  it("bounds deeply nested and high-node JSON without overflowing the stack", async () => {
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 20_000; index++) deep = { child: deep };
    const model = createModel(fakeFetch(() => jsonResponse(defaultCompletion)));
    const deepError = await captureError(
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        providerOptions: { metadata: deep },
      }),
    );
    expect(deepError.code).toBe("MODEL_INVALID_REQUEST");
    expect(deepError.message).toContain("depth limit");

    const nodeError = await captureError(
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        providerOptions: { metadata: Array.from({ length: 10_001 }, () => 0) },
      }),
    );
    expect(nodeError.code).toBe("MODEL_INVALID_REQUEST");
    expect(nodeError.message).toContain("node limit");
  });

  it("rejects accessor-backed JSON without invoking the getter", async () => {
    let getterCalls = 0;
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    const model = createModel(fakeFetch(() => jsonResponse(defaultCompletion)));
    const error = await captureError(
      model.complete({
        messages: [{ role: "user", content: "hi" }],
        providerOptions: { metadata },
      }),
    );
    expect(error.code).toBe("MODEL_INVALID_REQUEST");
    expect(getterCalls).toBe(0);
  });

  it("rejects accessor-backed protocol fields without invoking them", async () => {
    let getterCalls = 0;
    const message: Record<string, unknown> = { role: "user" };
    Object.defineProperty(message, "content", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    const model = createModel(fakeFetch(() => jsonResponse(defaultCompletion)));
    const error = await captureError(
      model.complete({ messages: [message] } as unknown as CompletionRequest),
    );
    expect(error.code).toBe("MODEL_INVALID_REQUEST");
    expect(error.message).toContain("data property");
    expect(getterCalls).toBe(0);
  });

  it("bounds and prototype-isolates decoded tool arguments", async () => {
    const nestedArguments = `${'{"child":'.repeat(100)}0${"}".repeat(100)}`;
    const nestedModel = createModel(
      fakeFetch(() =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-deep",
                    type: "function",
                    function: { name: "deep", arguments: nestedArguments },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    const nestedError = await captureError(
      nestedModel.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(nestedError.code).toBe("MODEL_INVALID_RESPONSE");
    expect(nestedError.message).toContain("depth limit");

    const prototypeModel = createModel(
      fakeFetch(() =>
        jsonResponse({
          ...defaultCompletion,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-proto",
                    type: "function",
                    function: {
                      name: "safe",
                      arguments: '{"__proto__":{"polluted":true}}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );
    const result = await prototypeModel.complete({
      messages: [{ role: "user", content: "hi" }],
    });
    const args = result.toolCalls[0]?.arguments as Record<string, unknown>;
    expect(Object.getPrototypeOf(args)).toBeNull();
    expect(Object.hasOwn(args, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 3,
    },
    {
      prompt_tokens: Number.MAX_SAFE_INTEGER + 1,
      completion_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("rejects unsafe or inconsistent usage: $total_tokens", async (usage) => {
    const model = createModel(
      fakeFetch(() => jsonResponse({ ...defaultCompletion, usage })),
    );
    const error = await captureError(
      model.complete({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(error.code).toBe("MODEL_INVALID_RESPONSE");
  });

  it.each([
    [{ baseUrl: "relative", model: "x" }, "baseUrl"],
    [{ baseUrl: "file:///tmp/provider", model: "x" }, "http or https"],
    [{ baseUrl: "https://user:pass@provider.test/v1", model: "x" }, "credentials"],
    [{ baseUrl: "http://provider.test/v1", model: "x" }, "loopback"],
    [
      { baseUrl: "https://provider.test/v1?api_key=secret", model: "x" },
      "query string",
    ],
    [
      {
        baseUrl: "http://127.0.0.1/v1",
        model: "x",
        apiKey: "secret",
      },
      "require HTTPS",
    ],
    [{ baseUrl: "https://provider.test/v1", model: "" }, "model"],
    [
      { baseUrl: "https://provider.test/v1", model: "x", timeoutMs: 0 },
      "timeoutMs",
    ],
    [
      {
        baseUrl: "https://provider.test/v1",
        model: "x",
        maxTokensParameter: "prototype",
      },
      "maxTokensParameter",
    ],
    [
      {
        baseUrl: "https://provider.test/v1",
        model: "x",
        apiKey: "secret\r\ninjected: true",
      },
      "printable ASCII",
    ],
  ] as const)("rejects invalid configuration", (options, message) => {
    let error: unknown;
    try {
      new OpenAICompatibleModel(
        options as unknown as ConstructorParameters<
          typeof OpenAICompatibleModel
        >[0],
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModelProviderError);
    expect((error as ModelProviderError).code).toBe("MODEL_INVALID_CONFIG");
    expect((error as Error).message).toContain(message);
  });

  it("allows credential-free loopback HTTP for local compatible servers", async () => {
    let input: string | URL | Request | undefined;
    const model = new OpenAICompatibleModel({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local",
      fetch: fakeFetch((received) => {
        input = received;
        return jsonResponse(defaultCompletion);
      }),
    });
    await model.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(String(input)).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
  });

  it("omits authorization when no API key is configured", async () => {
    let headers: RequestInit["headers"];
    const model = createModel(
      fakeFetch((_input, init) => {
        headers = init?.headers;
        return jsonResponse(defaultCompletion);
      }),
      { apiKey: undefined },
    );
    await model.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(headers).toEqual({ "Content-Type": "application/json" });
  });
});
