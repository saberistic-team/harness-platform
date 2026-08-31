import { ControlPlaneError } from "./errors";
import type {
  ArtifactKind,
  ArtifactRecord,
  ControlPlaneRepository,
  OutboxKick,
  ObjectPutInput,
  ObjectPutResult,
  ObjectStore,
} from "./types";
import { clone, defaultId, requireId, requireInteger, requireIso, sha256Hex } from "./util";

export interface ArtifactRegistryOptions {
  repository: ControlPlaneRepository;
  objectStore: ObjectStore;
  outbox?: OutboxKick;
  now?: () => string;
  newId?: (prefix: string) => string;
  maxArtifactBytes?: number;
  maxSignedUrlSeconds?: number;
}

export interface PrepareArtifactInput {
  kind: ArtifactKind;
  body: string | Uint8Array;
  contentType: string;
  artifactId?: string;
  objectKey?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
}

function bytes(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? Buffer.from(body, "utf8") : new Uint8Array(body);
}

function contentType(value: string): string {
  if (value.length === 0 || value.length > 256 || /[\r\n\u0000]/u.test(value)) {
    throw new ControlPlaneError("CP_INVALID_INPUT", "artifact contentType is invalid");
  }
  return value;
}

function artifactKind(value: ArtifactKind): ArtifactKind {
  if (value !== "run_report" && value !== "output" && value !== "audit") {
    throw new ControlPlaneError("CP_INVALID_INPUT", "artifact kind is invalid");
  }
  return value;
}

/** Immutable object upload + durable metadata registry. */
export class ArtifactRegistry {
  private readonly repository: ControlPlaneRepository;
  readonly objectStore: ObjectStore;
  private readonly outbox?: OutboxKick;
  private readonly now: () => string;
  private readonly newId: (prefix: string) => string;
  private readonly maxArtifactBytes: number;
  private readonly maxSignedUrlSeconds: number;

  constructor(options: ArtifactRegistryOptions) {
    this.repository = options.repository;
    this.objectStore = options.objectStore;
    this.outbox = options.outbox;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? defaultId;
    this.maxArtifactBytes = requireInteger(
      options.maxArtifactBytes ?? 16 * 1024 * 1024,
      "maxArtifactBytes",
      1,
      256 * 1024 * 1024,
    );
    this.maxSignedUrlSeconds = requireInteger(
      options.maxSignedUrlSeconds ?? 900,
      "maxSignedUrlSeconds",
      1,
      86_400,
    );
  }

  async ready(): Promise<void> {
    await Promise.all([this.repository.ready(), this.objectStore.ready()]);
  }

  private timestamp(): string {
    return requireIso(this.now(), "artifact registry clock");
  }

  async prepare(input: PrepareArtifactInput): Promise<ArtifactRecord> {
    const kind = artifactKind(input.kind);
    const artifactId = input.artifactId === undefined
      ? this.newId("artifact")
      : requireId(input.artifactId, "artifactId");
    const body = bytes(input.body);
    if (body.byteLength > this.maxArtifactBytes) {
      throw new ControlPlaneError(
        "CP_PAYLOAD_TOO_LARGE",
        `artifact exceeds the ${this.maxArtifactBytes}-byte limit`,
      );
    }
    const digest = sha256Hex(body);
    const key = input.objectKey ?? `artifacts/${kind}/${digest.slice(0, 2)}/${artifactId}-${digest}`;
    const createdAt = this.timestamp();
    if (input.taskId !== undefined && !await this.repository.getTask(requireId(input.taskId, "taskId"))) {
      throw new ControlPlaneError("CP_NOT_FOUND", `task ${input.taskId} was not found`);
    }
    if (input.runId !== undefined) {
      const run = await this.repository.getRun(requireId(input.runId, "runId"));
      if (!run) throw new ControlPlaneError("CP_NOT_FOUND", `run ${input.runId} was not found`);
      if (input.taskId !== undefined && run.taskId !== input.taskId) {
        throw new ControlPlaneError("CP_CONFLICT", "artifact task and run do not match");
      }
    }
    const record: ArtifactRecord = {
      artifactId,
      kind,
      bucket: this.objectStore.bucket,
      key,
      sha256: digest,
      bytes: body.byteLength,
      contentType: contentType(input.contentType),
      ...(input.taskId === undefined ? {} : { taskId: requireId(input.taskId, "taskId") }),
      ...(input.runId === undefined ? {} : { runId: requireId(input.runId, "runId") }),
      ...(input.sessionId === undefined ? {} : { sessionId: requireId(input.sessionId, "sessionId") }),
      createdAt,
    };
    await this.objectStore.putObject({
      key: record.key,
      body,
      contentType: record.contentType,
      sha256: record.sha256,
      ifAbsent: true,
    });
    return record;
  }

  async commitPrepared(record: ArtifactRecord): Promise<{ artifact: ArtifactRecord; created: boolean }> {
    const result = await this.repository.registerArtifact(record);
    this.outbox?.kick();
    return { artifact: result.record, created: result.created };
  }

  async register(input: PrepareArtifactInput): Promise<{ artifact: ArtifactRecord; created: boolean }> {
    if (input.artifactId !== undefined) {
      const artifactId = requireId(input.artifactId, "artifactId");
      const existing = await this.repository.getArtifact(artifactId);
      if (existing) {
        const body = bytes(input.body);
        const digest = sha256Hex(body);
        const expectedKey = input.objectKey ?? `artifacts/${input.kind}/${digest.slice(0, 2)}/${artifactId}-${digest}`;
        if (
          existing.kind !== input.kind || existing.sha256 !== digest || existing.bytes !== body.byteLength ||
          existing.contentType !== input.contentType || existing.bucket !== this.objectStore.bucket ||
          existing.key !== expectedKey ||
          existing.taskId !== input.taskId || existing.runId !== input.runId || existing.sessionId !== input.sessionId
        ) {
          throw new ControlPlaneError("CP_CONFLICT", `artifact ${artifactId} was already registered differently`);
        }
        this.outbox?.kick();
        return { artifact: existing, created: false };
      }
    }
    return this.commitPrepared(await this.prepare(input));
  }

  async get(artifactId: string): Promise<ArtifactRecord> {
    const id = requireId(artifactId, "artifactId");
    const record = await this.repository.getArtifact(id);
    if (!record) throw new ControlPlaneError("CP_NOT_FOUND", `artifact ${id} was not found`);
    return record;
  }

  async signedGetUrl(artifactId: string, expiresInSeconds = 300): Promise<{ artifact: ArtifactRecord; url: string; expiresInSeconds: number }> {
    const expires = requireInteger(expiresInSeconds, "expiresInSeconds", 1, this.maxSignedUrlSeconds);
    const artifact = await this.get(artifactId);
    if (artifact.bucket !== this.objectStore.bucket) {
      throw new ControlPlaneError("CP_STORAGE_FAILED", "artifact belongs to another object store");
    }
    return {
      artifact,
      url: await this.objectStore.signedGetUrl(artifact.key, expires),
      expiresInSeconds: expires,
    };
  }
}

/** Offline object store used only when explicitly injected. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string; sha256: string }>();

  constructor(readonly bucket = "harness-test") {}

  async ready(): Promise<void> {}

  async putObject(input: ObjectPutInput): Promise<ObjectPutResult> {
    const existing = this.objects.get(input.key);
    if (existing) {
      if (existing.sha256 !== input.sha256 || existing.contentType !== input.contentType) {
        throw new ControlPlaneError("CP_CONFLICT", "object key already contains different bytes or metadata");
      }
      if (input.ifAbsent) return { alreadyExisted: true, etag: existing.sha256 };
    }
    this.objects.set(input.key, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
      sha256: input.sha256,
    });
    return { alreadyExisted: false, etag: input.sha256 };
  }

  async signedGetUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.objects.has(key)) throw new ControlPlaneError("CP_NOT_FOUND", "object was not found");
    return `https://objects.invalid/${encodeURIComponent(this.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?expires=${expiresInSeconds}`;
  }

  read(key: string): Uint8Array | undefined {
    const value = this.objects.get(key);
    return value ? clone(value.body) : undefined;
  }
}
