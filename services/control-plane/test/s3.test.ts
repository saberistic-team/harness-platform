import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presignS3Get, S3ObjectStore, signAwsRequest } from "../src/s3";

const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const now = new Date("2013-05-24T00:00:00.000Z");

describe("AWS SigV4", () => {
  it("produces deterministic request authorization without exposing the secret", () => {
    const signed = signAwsRequest({
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { "content-type": "text/plain" },
      payloadHash: createHash("sha256").update("hello").digest("hex"),
      region: "us-east-1",
      credentials,
      now,
    });
    expect(signed["x-amz-date"]).toBe("20130524T000000Z");
    expect(signed.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(signed)).not.toContain(credentials.secretAccessKey);
  });

  it("creates bounded signed GET URLs with canonical query authentication", () => {
    const value = presignS3Get({
      url: new URL("https://examplebucket.s3.amazonaws.com/folder/a%20file.txt"),
      region: "us-east-1",
      credentials,
      now,
      expiresInSeconds: 60,
    });
    const url = new URL(value);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toContain("/20130524/us-east-1/s3/aws4_request");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/u);
    expect(value).not.toContain(credentials.secretAccessKey);
    expect(() => presignS3Get({
      url: new URL("https://example.com/x"), region: "us-east-1", credentials, now,
      expiresInSeconds: 604_801,
    })).toThrow(/expiresInSeconds/u);
  });

  it("returns the exact canonical query bytes that were signed", () => {
    const value = presignS3Get({
      url: new URL("https://examplebucket.s3.amazonaws.com/folder/a%20file.txt"),
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKID~EXAMPLE",
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: "token~with space",
      },
      now,
      expiresInSeconds: 60,
    });
    expect(value).toBe(
      "https://examplebucket.s3.amazonaws.com/folder/a%20file.txt?" +
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
      "X-Amz-Credential=AKID~EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&" +
      "X-Amz-Date=20130524T000000Z&X-Amz-Expires=60&" +
      "X-Amz-Security-Token=token~with%20space&X-Amz-SignedHeaders=host&" +
      "X-Amz-Signature=0fe380156a612c48e3ee69b0e615ca5cebda13e436c48cfc9fa2f24e2d940ed8",
    );
  });
});

describe("S3ObjectStore", () => {
  it("signs real S3-compatible HEAD and immutable PUT requests through an injected transport", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 200, headers: { etag: '"abc"' } });
    };
    const store = new S3ObjectStore({
      endpoint: "http://127.0.0.1:9000",
      allowHttp: true,
      forcePathStyle: true,
      bucket: "harness-artifacts",
      region: "us-east-1",
      credentials,
      fetch: fakeFetch,
      now: () => now,
    });
    await store.ready();
    const body = Buffer.from("hello");
    const result = await store.putObject({
      key: "reports/run 1.json",
      body,
      contentType: "application/json",
      sha256: createHash("sha256").update(body).digest("hex"),
      ifAbsent: true,
    });
    expect(result).toEqual({ alreadyExisted: false, etag: '"abc"' });
    expect(calls.map((call) => call.init?.method)).toEqual(["HEAD", "PUT"]);
    expect(calls[1]!.url).toBe("http://127.0.0.1:9000/harness-artifacts/reports/run%201.json");
    const headers = calls[1]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/u);
    expect(headers["if-none-match"]).toBe("*");
    expect(headers["x-amz-meta-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    expect(headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(body).digest("hex"));
    const signed = await store.signedGetUrl("reports/run 1.json", 120);
    expect(signed).toContain("X-Amz-Signature=");
  });

  it("treats conditional conflicts as an idempotent existing object", async () => {
    const body = Buffer.from("same");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const methods: string[] = [];
    const store = new S3ObjectStore({
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      bucket: "harness-artifacts",
      region: "us-east-1",
      credentials,
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "");
        return methods.length === 1
          ? new Response(null, { status: 412 })
          : new Response(body, {
            status: 200,
            headers: {
              "content-length": String(body.byteLength),
              "content-type": "text/plain",
              // Verification hashes the returned bytes; this user metadata is
              // deliberately absent and is not trusted as evidence.
            },
          });
      },
      now: () => now,
    });
    await expect(store.putObject({
      key: "same", body, contentType: "text/plain",
      sha256, ifAbsent: true,
    })).resolves.toEqual({ alreadyExisted: true });
    expect(methods).toEqual(["PUT", "GET"]);
  });

  it("fails closed when a conditional conflict returns different bytes with forged metadata", async () => {
    const expected = Buffer.from("same");
    const expectedSha256 = createHash("sha256").update(expected).digest("hex");
    let request = 0;
    const store = new S3ObjectStore({
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      bucket: "harness-artifacts",
      region: "us-east-1",
      credentials,
      fetch: async () => request++ === 0
        ? new Response(null, { status: 412 })
        : new Response(Buffer.from("evil"), {
            status: 200,
            headers: {
              "content-length": "4",
              "content-type": "text/plain",
              "x-amz-meta-sha256": expectedSha256,
            },
          }),
      now: () => now,
    });
    await expect(store.putObject({
      key: "same", body: expected, contentType: "text/plain",
      sha256: expectedSha256, ifAbsent: true,
    })).rejects.toMatchObject({ code: "CP_CONFLICT" });
  });

  it("bounds a conditional-conflict download even when content-length is absent", async () => {
    const expected = Buffer.from("same");
    let request = 0;
    const store = new S3ObjectStore({
      endpoint: "https://s3.example.com",
      forcePathStyle: true,
      bucket: "harness-artifacts",
      region: "us-east-1",
      credentials,
      fetch: async () => request++ === 0
        ? new Response(null, { status: 412 })
        : new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from("same!"));
              controller.close();
            },
          }), {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      now: () => now,
    });
    await expect(store.putObject({
      key: "same",
      body: expected,
      contentType: "text/plain",
      sha256: createHash("sha256").update(expected).digest("hex"),
      ifAbsent: true,
    })).rejects.toMatchObject({ code: "CP_CONFLICT" });
  });

  it("fails closed on plaintext endpoints, unsafe keys, and digest mismatch", async () => {
    expect(() => new S3ObjectStore({
      endpoint: "http://s3.example.com", bucket: "harness-artifacts", region: "us-east-1", credentials,
    })).toThrow(/HTTPS/u);
    const store = new S3ObjectStore({
      endpoint: "https://s3.example.com", bucket: "harness-artifacts", region: "us-east-1", credentials,
      fetch: async () => new Response(null, { status: 200 }), now: () => now,
    });
    await expect(store.putObject({
      key: "../escape", body: Buffer.from("x"), contentType: "text/plain", sha256: "0".repeat(64),
    })).rejects.toMatchObject({ code: "CP_INVALID_INPUT" });
  });
});
