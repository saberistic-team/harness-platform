import { createHash, createHmac } from "node:crypto";
import { ControlPlaneError } from "./errors";
import type { ObjectPutInput, ObjectPutResult, ObjectStore } from "./types";
import { requireInteger } from "./util";

export type FetchLike = typeof fetch;

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ObjectStoreOptions {
  endpoint: string;
  region: string;
  bucket: string;
  credentials: S3Credentials;
  forcePathStyle?: boolean;
  allowHttp?: boolean;
  requestTimeoutMs?: number;
  fetch?: FetchLike;
  now?: () => Date;
}

function hashHex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function encodedPath(value: string): string {
  return value.split("/").map(awsEncode).join("/");
}

function amzTimestamp(date: Date): { timestamp: string; day: string } {
  if (!Number.isFinite(date.getTime())) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "S3 signing clock returned an invalid date");
  }
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  return { timestamp, day: timestamp.slice(0, 8) };
}

function signingKey(secret: string, day: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, day);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function canonicalQuery(parameters: Iterable<[string, string]>): string {
  return [...parameters]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function validateKey(key: string): string {
  if (
    key.length === 0 ||
    Buffer.byteLength(key, "utf8") > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(key) ||
    key.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "object key is invalid");
  }
  return key;
}

function validateCredentials(credentials: S3Credentials): S3Credentials {
  for (const [name, value] of Object.entries(credentials)) {
    if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", `S3 ${name} is invalid`);
    }
  }
  return { ...credentials };
}

export interface AwsSigningInput {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string>>;
  payloadHash: string;
  region: string;
  credentials: S3Credentials;
  now: Date;
}

/** AWS Signature Version 4 headers, exported for deterministic offline tests. */
export function signAwsRequest(input: AwsSigningInput): Record<string, string> {
  const { timestamp, day } = amzTimestamp(input.now);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key.toLowerCase(), normalizeHeader(value)])),
    host: input.url.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": timestamp,
  };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${headers[name]}\n`).join("")}`;
  const query = canonicalQuery(input.url.searchParams.entries());
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, day, input.region))
    .update(stringToSign)
    .digest("hex");
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface PresignInput {
  url: URL;
  region: string;
  credentials: S3Credentials;
  now: Date;
  expiresInSeconds: number;
}

/** Generate a query-authenticated S3 GET URL without contacting the service. */
export function presignS3Get(input: PresignInput): string {
  const expires = requireInteger(input.expiresInSeconds, "expiresInSeconds", 1, 604_800);
  const { timestamp, day } = amzTimestamp(input.now);
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const url = new URL(input.url);
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${input.credentials.accessKeyId}/${scope}`);
  url.searchParams.set("X-Amz-Date", timestamp);
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  if (input.credentials.sessionToken) {
    url.searchParams.set("X-Amz-Security-Token", input.credentials.sessionToken);
  }
  const canonical = canonicalQuery(url.searchParams.entries());
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonical,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    hashHex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, day, input.region))
    .update(stringToSign)
    .digest("hex");
  // Assign the already-canonical wire form once. Mutating `searchParams` after
  // signing would re-encode valid AWS bytes (for example `~` as `%7E`) and make
  // the returned URL differ from the canonical request that was signed.
  url.search = `${canonical}&X-Amz-Signature=${signature}`;
  return url.toString();
}

/** Minimal S3/MinIO client: immutable PUTs, readiness, and signed GET URLs. */
export class S3ObjectStore implements ObjectStore {
  readonly bucket: string;
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly credentials: S3Credentials;
  private readonly forcePathStyle: boolean;
  private readonly requestTimeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => Date;

  constructor(options: S3ObjectStoreOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new ControlPlaneError("CP_INVALID_INPUT", "S3 endpoint must be an absolute URL");
    }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "S3 endpoint must not contain credentials, query, or fragment");
    }
    if (endpoint.protocol !== "https:" && !(options.allowHttp === true && endpoint.protocol === "http:")) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "S3 endpoint must use HTTPS");
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucket)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "S3 bucket name is invalid");
    }
    if (!/^[a-z0-9-]{1,64}$/u.test(options.region)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "S3 region is invalid");
    }
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "");
    this.endpoint = endpoint;
    this.bucket = options.bucket;
    this.region = options.region;
    this.credentials = validateCredentials(options.credentials);
    this.forcePathStyle = options.forcePathStyle ?? (
      endpoint.hostname === "localhost" || endpoint.hostname.includes(":") || endpoint.protocol === "http:"
    );
    this.requestTimeoutMs = requireInteger(options.requestTimeoutMs ?? 30_000, "S3 requestTimeoutMs", 100, 300_000);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private objectUrl(key?: string): URL {
    const url = new URL(this.endpoint);
    const base = url.pathname.replace(/\/+$/u, "");
    if (this.forcePathStyle) {
      url.pathname = `${base}/${awsEncode(this.bucket)}${key === undefined ? "" : `/${encodedPath(validateKey(key))}`}`;
    } else {
      url.hostname = `${this.bucket}.${url.hostname}`;
      url.pathname = `${base}${key === undefined ? "/" : `/${encodedPath(validateKey(key))}`}`;
    }
    return url;
  }

  private async request(
    method: "GET" | "HEAD" | "PUT",
    url: URL,
    body: Uint8Array | undefined,
    headers: Record<string, string>,
  ): Promise<Response> {
    const payloadHash = hashHex(body ?? "");
    const signed = signAwsRequest({
      method,
      url,
      headers,
      payloadHash,
      region: this.region,
      credentials: this.credentials,
      now: this.now(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timer.unref();
    try {
      return await this.fetcher(url, {
        method,
        headers: signed,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "S3 request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void reader.cancel().catch(() => {});
        reject(new ControlPlaneError("CP_STORAGE_FAILED", "S3 object verification timed out"));
      }, this.requestTimeoutMs);
      timer.unref();
    });
    const consume = async (): Promise<Uint8Array> => {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > maximumBytes) {
          await reader.cancel().catch(() => {});
          throw new ControlPlaneError("CP_CONFLICT", "object key already contains different bytes");
        }
        chunks.push(Buffer.from(result.value));
      }
      return Buffer.concat(chunks, size);
    };
    try {
      return await Promise.race([consume(), timeout]);
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError("CP_STORAGE_FAILED", "S3 object verification failed", { cause: error });
    } finally {
      if (timer) clearTimeout(timer);
      if (!timedOut) reader.releaseLock();
    }
  }

  private async discard(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort release after a bodyless response or a verified/bounded read.
    }
  }

  async ready(): Promise<void> {
    const response = await this.request("HEAD", this.objectUrl(), undefined, {});
    try {
      if (!response.ok) {
        throw new ControlPlaneError("CP_NOT_READY", `S3 bucket readiness failed with status ${response.status}`);
      }
    } finally {
      await this.discard(response);
    }
  }

  async putObject(input: ObjectPutInput): Promise<ObjectPutResult> {
    validateKey(input.key);
    if (!/^[a-f0-9]{64}$/u.test(input.sha256) || hashHex(input.body) !== input.sha256) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "object sha256 does not match its bytes");
    }
    if (input.contentType.length === 0 || input.contentType.length > 256 || /[\r\n]/u.test(input.contentType)) {
      throw new ControlPlaneError("CP_INVALID_INPUT", "object content type is invalid");
    }
    const response = await this.request("PUT", this.objectUrl(input.key), input.body, {
      "content-length": String(input.body.byteLength),
      "content-type": input.contentType,
      "x-amz-meta-sha256": input.sha256,
      ...(input.ifAbsent ? { "if-none-match": "*" } : {}),
    });
    try {
      if (input.ifAbsent && (response.status === 409 || response.status === 412)) {
        const existing = await this.request("GET", this.objectUrl(input.key), undefined, {});
        try {
          if (!existing.ok) {
            throw new ControlPlaneError(
              "CP_STORAGE_FAILED",
              `S3 object verification failed with status ${existing.status}`,
            );
          }
          const lengthHeader = existing.headers.get("content-length");
          if (lengthHeader !== null) {
            const length = Number(lengthHeader);
            if (!Number.isSafeInteger(length) || length < 0) {
              throw new ControlPlaneError("CP_STORAGE_FAILED", "S3 object verification returned an invalid length");
            }
            if (length !== input.body.byteLength) {
              throw new ControlPlaneError("CP_CONFLICT", "object key already contains different bytes");
            }
          }
          const existingContentType = existing.headers.get("content-type");
          if (
            existingContentType === null ||
            normalizeHeader(existingContentType) !== normalizeHeader(input.contentType)
          ) {
            throw new ControlPlaneError("CP_CONFLICT", "object key already contains a different content type");
          }
          const existingBody = await this.readBounded(existing, input.body.byteLength);
          if (existingBody.byteLength !== input.body.byteLength || hashHex(existingBody) !== input.sha256) {
            throw new ControlPlaneError("CP_CONFLICT", "object key already contains different bytes");
          }
          return {
            alreadyExisted: true,
            ...(existing.headers.get("etag") === null ? {} : { etag: existing.headers.get("etag")! }),
          };
        } finally {
          await this.discard(existing);
        }
      }
      if (!response.ok) {
        throw new ControlPlaneError("CP_STORAGE_FAILED", `S3 object upload failed with status ${response.status}`);
      }
      return {
        alreadyExisted: false,
        ...(response.headers.get("etag") === null ? {} : { etag: response.headers.get("etag")! }),
      };
    } finally {
      await this.discard(response);
    }
  }

  async signedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    validateKey(key);
    return presignS3Get({
      url: this.objectUrl(key),
      region: this.region,
      credentials: this.credentials,
      now: this.now(),
      expiresInSeconds,
    });
  }
}
