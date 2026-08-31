import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import type {
  AcpCancelSessionParams,
  AcpClientOptions,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPermissionResponseParams,
  AcpPromptParams,
  AcpPromptResult,
  AcpSessionEventParams,
} from "@harness/acp";
import {
  deserializeEvent,
  serializeEvent,
  type AnyHarnessEvent,
  type TypedEvent,
} from "@harness/events";
import { renderEventLine, sanitizeTerminalText } from "./render";

const ACP_PROTOCOL_VERSION = "harness/acp/1";
const MAX_INTERACTIVE_EVENTS = 10_000;

export type PermissionRequestedEvent = TypedEvent<"permission.requested">;
export type PermissionResolvedEvent = TypedEvent<"permission.resolved">;
export type InteractiveHarnessEvent = AnyHarnessEvent;

export type AcpEventNotification = AcpSessionEventParams;
export type PermissionResponseParams = AcpPermissionResponseParams;

/** Structural surface used by the TUI and its offline fake client. */
export interface InteractiveAcpClient {
  initialize(params: AcpInitializeParams): Promise<AcpInitializeResult>;
  newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult>;
  prompt(params: AcpPromptParams): Promise<AcpPromptResult>;
  respondPermission(params: PermissionResponseParams): Promise<unknown>;
  cancelSession(params: AcpCancelSessionParams): Promise<unknown>;
  onEvent(
    listener: (notification: AcpEventNotification) => void,
  ): void | (() => void);
  close(): void | Promise<void>;
}

export type ConnectAcpClient = (
  url: string,
  options?: AcpClientOptions,
) => Promise<InteractiveAcpClient>;

export interface PermissionPrompt {
  sessionId: string;
  permissionId: string;
  callId?: string;
  action: string;
  subject?: string;
  scope: "once" | "run";
  reason?: string;
}

export type ConfirmPermission = (
  request: PermissionPrompt,
) => boolean | Promise<boolean>;

export type ReadLine = (prompt: string) => Promise<string | undefined>;

export interface InteractiveContext {
  cwd?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
  connect?: ConnectAcpClient;
  confirmPermission?: ConfirmPermission;
  readPrompt?: () => Promise<string | undefined>;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface InteractiveRunOptions {
  url: string;
  token?: string;
  workspace: string;
  taskId?: string;
  model?: string;
  prompt?: string;
}

export class InteractiveTuiError extends Error {
  constructor(
    readonly code:
      | "TUI_USAGE"
      | "TUI_PROMPT_REQUIRED"
      | "TUI_CLIENT_UNAVAILABLE"
      | "TUI_PROTOCOL"
      | "TUI_ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "InteractiveTuiError";
  }
}

/** Only an explicit y/yes is approval. Everything else fails closed. */
export function isExplicitAllow(answer: string | undefined): boolean {
  if (answer === undefined) return false;
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

export function permissionQuestion(request: PermissionPrompt): string {
  const action = sanitizeTerminalText(request.action);
  const subject = request.subject ? ` ${sanitizeTerminalText(request.subject)}` : "";
  const why = request.reason ? ` (${sanitizeTerminalText(request.reason)})` : "";
  const scope = request.scope === "run" ? " for this run" : " once";
  return `Allow ${action}${subject}${scope}?${why} [y/N] `;
}

/**
 * Build a confirmation function from any line reader. Noninteractive input is
 * deliberately denied without attempting to consume stdin.
 */
export function createConfirmation(
  readLine: ReadLine,
  interactive: boolean,
): ConfirmPermission {
  return async (request) => {
    if (!interactive) return false;
    try {
      return isExplicitAllow(await readLine(permissionQuestion(request)));
    } catch {
      return false;
    }
  };
}

async function terminalLine(
  prompt: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal,
  });
  try {
    return await rl.question(prompt, { signal });
  } catch {
    return undefined;
  } finally {
    rl.close();
  }
}

function terminalConfirmation(signal?: AbortSignal): ConfirmPermission {
  return createConfirmation(
    (prompt) => terminalLine(prompt, signal),
    Boolean(process.stdin.isTTY && process.stdout.isTTY),
  );
}

async function defaultConnect(
  url: string,
  options?: AcpClientOptions,
): Promise<InteractiveAcpClient> {
  // Keep this indirect so offline fake-client tests do not load the concrete
  // WebSocket implementation merely by importing the TUI module.
  const specifier = "@harness/acp";
  const module = (await import(specifier)) as unknown as {
    ACP_PROTOCOL_VERSION?: string;
    AcpClient?: {
      connect(
        url: string,
        options?: AcpClientOptions,
      ): Promise<InteractiveAcpClient>;
    };
  };
  if (!module.AcpClient) {
    throw new InteractiveTuiError(
      "TUI_CLIENT_UNAVAILABLE",
      "@harness/acp does not export AcpClient",
    );
  }
  if (module.ACP_PROTOCOL_VERSION !== ACP_PROTOCOL_VERSION) {
    throw new InteractiveTuiError(
      "TUI_PROTOCOL",
      `unsupported ACP client protocol: ${module.ACP_PROTOCOL_VERSION ?? "unknown"}`,
    );
  }
  return module.AcpClient.connect(url, options);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return true;
  }
  const parts = normalized.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/u.test(part));
}

function parseEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new InteractiveTuiError(
      "TUI_USAGE",
      "connect URL must be a valid ws:// or wss:// URL",
    );
  }
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new InteractiveTuiError(
      "TUI_USAGE",
      "connect URL must use ws:// or wss://",
    );
  }
  if (endpoint.username || endpoint.password) {
    throw new InteractiveTuiError(
      "TUI_USAGE",
      "connect URL must not contain username or password credentials",
    );
  }
  if (endpoint.protocol === "ws:" && !isLoopbackHostname(endpoint.hostname)) {
    throw new InteractiveTuiError(
      "TUI_USAGE",
      "non-loopback ACP connections require wss://",
    );
  }
  return endpoint;
}

function replaceSecrets(value: string, secrets: Iterable<string>): string {
  const candidates = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((a, b) => b.length - a.length);
  let cursor = 0;
  let output = "";
  while (cursor < value.length) {
    let index = -1;
    let match = "";
    for (const candidate of candidates) {
      const candidateIndex = value.indexOf(candidate, cursor);
      if (
        candidateIndex >= 0 &&
        (index < 0 || candidateIndex < index ||
          (candidateIndex === index && candidate.length > match.length))
      ) {
        index = candidateIndex;
        match = candidate;
      }
    }
    if (index < 0) {
      output += value.slice(cursor);
      break;
    }
    output += `${value.slice(cursor, index)}[REDACTED]`;
    cursor = index + match.length;
  }
  return output;
}

function redactConnectionSecrets(
  value: string,
  options?: Pick<InteractiveRunOptions, "url" | "token">,
): string {
  let redacted = value;
  const secrets = new Set<string>();
  if (options?.token) secrets.add(options.token);
  if (options?.url) {
    try {
      const endpoint = new URL(options.url);
      for (const key of ["token", "access_token", "auth"]) {
        for (const secret of endpoint.searchParams.getAll(key)) {
          if (secret) secrets.add(secret);
        }
      }
    } catch {
      // parseConnectArgs reports a generic URL error and never echoes the URL.
    }
  }
  const variants = new Set<string>();
  for (const secret of secrets) {
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(new URLSearchParams({ value: secret }).toString().slice(6));
  }
  redacted = replaceSecrets(redacted, variants);
  redacted = redacted.replace(
    /([?&](?:token|access_token|auth)=)[^&#\s]*/giu,
    "$1[REDACTED]",
  );
  return redacted.replace(/(wss?:\/\/)[^/@\s]+@/giu, "$1[REDACTED]@");
}

/** Keep bearer-style query credentials out of user-visible transport errors. */
function safeInteractiveErrorMessage(
  error: unknown,
  options?: Pick<InteractiveRunOptions, "url" | "token">,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(redactConnectionSecrets(message, options));
}

function abortError(): InteractiveTuiError {
  return new InteractiveTuiError("TUI_ABORTED", "interactive session canceled");
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) throw abortError();
  let onAbort!: () => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, canceled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Drive one ACP session. The client is injected for deterministic offline
 * tests; the default connector loads AcpClient from @harness/acp.
 */
export async function runInteractive(
  options: InteractiveRunOptions,
  ctx: InteractiveContext = {},
): Promise<number> {
  const rawOut = ctx.out ?? console.log;
  const out = (line: string) => {
    rawOut(sanitizeTerminalText(redactConnectionSecrets(line, options)));
  };
  const connect = ctx.connect ?? defaultConnect;
  const signal = ctx.signal;
  const confirm = ctx.confirmPermission ?? terminalConfirmation(signal);
  let client: InteractiveAcpClient | undefined;
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let cancelStarted = false;

  const cancel = async () => {
    if (!client || !sessionId || cancelStarted) return;
    cancelStarted = true;
    try {
      await client.cancelSession({ sessionId });
    } catch {
      // Abort is already fail-closed; close the transport in finally.
    }
  };

  const onAbort = () => {
    void cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) throw abortError();

    let prompt = options.prompt?.trim();
    if (!prompt) {
      prompt = (await raceWithAbort(
        (ctx.readPrompt ?? (() => terminalLine("Prompt: ", signal)))(),
        signal,
      ))?.trim();
    }
    if (!prompt) {
      throw new InteractiveTuiError(
        "TUI_PROMPT_REQUIRED",
        "connect requires prompt text (arguments or stdin)",
      );
    }

    const endpoint = parseEndpoint(options.url);
    if (options.token) endpoint.searchParams.set("token", options.token);
    const connecting = connect(endpoint.toString(), { signal });
    try {
      client = await raceWithAbort(connecting, signal);
    } catch (error) {
      if (signal?.aborted) {
        void connecting.then((lateClient) => lateClient.close()).catch(() => undefined);
        throw abortError();
      }
      throw error;
    }
    const initialized = await raceWithAbort(
      client.initialize({
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientName: "harness-view",
        clientVersion: "0.2.0",
        capabilities: {
          streaming: true,
          permissioning: true,
        },
      }),
      signal,
    );

    if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new InteractiveTuiError(
        "TUI_PROTOCOL",
        `server negotiated unsupported ACP protocol "${initialized.protocolVersion}"`,
      );
    }
    if (!initialized.capabilities.streaming || !initialized.capabilities.permissioning) {
      throw new InteractiveTuiError(
        "TUI_PROTOCOL",
        "server does not support streaming permission negotiation",
      );
    }

    if (options.model && initialized.models.length > 0 && !initialized.models.includes(options.model)) {
      throw new InteractiveTuiError(
        "TUI_USAGE",
        `server does not offer model "${options.model}"`,
      );
    }

    const session = await raceWithAbort(
      client.newSession({
        workspace: options.workspace,
        taskId: options.taskId,
        model: options.model,
      }),
      signal,
    );
    sessionId = session.sessionId;
    out(`connected session ${sanitizeTerminalText(sessionId)}`);

    const seen = new Map<string, string>();
    const permissionRequests = new Map<
      string,
      PermissionPrompt & { decision?: "allow" | "deny"; resolved?: boolean }
    >();
    let nextStreamSeq = 0;
    let receivedStreamNotifications = 0;
    let nextRenderSeq = 0;
    let terminalStatus: "completed" | "failed" | "canceled" | "budget_exceeded" | undefined;
    let eventChain: Promise<void> = Promise.resolve();
    let rejectEventFailure: (reason: unknown) => void = () => undefined;
    const eventFailure = new Promise<never>((_, reject) => {
      rejectEventFailure = reject;
    });

    const handleEvent = async (notification: AcpEventNotification) => {
      if (notification.sessionId !== sessionId) return;
      const event = notification.event;
      if (notification.seq !== nextStreamSeq) {
        throw new InteractiveTuiError(
          "TUI_PROTOCOL",
          `expected session event sequence ${nextStreamSeq}, received ${notification.seq}`,
        );
      }
      nextStreamSeq++;
      nextRenderSeq = nextStreamSeq;

      const canonical = serializeEvent(event);
      if (seen.has(event.eventId)) {
        throw new InteractiveTuiError(
          "TUI_PROTOCOL",
          `duplicate session event id "${sanitizeTerminalText(event.eventId)}"`,
        );
      }

      let request: PermissionPrompt | undefined;
      if (event.type === "permission.requested") {
        if (event.data.sessionId !== notification.sessionId) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `permission ${event.data.permissionId} names the wrong session`,
          );
        }
        if (permissionRequests.has(event.data.permissionId)) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `duplicate permission request "${sanitizeTerminalText(event.data.permissionId)}"`,
          );
        }
        request = {
          sessionId: event.data.sessionId,
          permissionId: event.data.permissionId,
          callId: event.data.callId,
          action: event.data.action,
          subject: event.data.subject,
          scope: event.data.scope,
          reason: event.data.reason,
        };
        permissionRequests.set(event.data.permissionId, request);
      } else if (event.type === "permission.resolved") {
        if (event.data.sessionId !== notification.sessionId) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `permission ${event.data.permissionId} resolution names the wrong session`,
          );
        }
        const pending = permissionRequests.get(event.data.permissionId);
        if (!pending || pending.decision === undefined || pending.resolved) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `unexpected permission resolution "${sanitizeTerminalText(event.data.permissionId)}"`,
          );
        }
        if (
          pending.callId !== event.data.callId ||
          pending.action !== event.data.action ||
          pending.subject !== event.data.subject ||
          pending.scope !== event.data.scope ||
          pending.decision !== event.data.decision
        ) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `permission resolution "${sanitizeTerminalText(event.data.permissionId)}" does not match the submitted decision`,
          );
        }
        pending.resolved = true;
      } else if (event.type === "agent.stopped") {
        if (terminalStatus !== undefined) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            "session emitted more than one agent.stopped event",
          );
        }
        terminalStatus = event.data.status;
      }

      seen.set(event.eventId, canonical);
      out(renderEventLine(notification.seq, event, { color: false }));

      if (request) {
        let allowed = false;
        try {
          const confirmation = await raceWithAbort(
            Promise.resolve(confirm(request)),
            signal,
          );
          allowed = confirmation === true;
        } catch {
          if (signal?.aborted) throw abortError();
          allowed = false;
        }
        const decision = allowed ? "allow" : "deny";
        permissionRequests.get(request.permissionId)!.decision = decision;
        await raceWithAbort(client!.respondPermission({
          sessionId: request.sessionId,
          permissionId: request.permissionId,
          decision,
          note: allowed ? "approved by harness-view" : "denied by harness-view",
        }), signal);
      }
    };

    const maybeUnsubscribe = client.onEvent((notification) => {
      if (notification.sessionId !== sessionId) return;
      if (receivedStreamNotifications >= MAX_INTERACTIVE_EVENTS) {
        rejectEventFailure(new InteractiveTuiError(
          "TUI_PROTOCOL",
          `session exceeded ${MAX_INTERACTIVE_EVENTS} streamed events`,
        ));
        void cancel();
        return;
      }
      receivedStreamNotifications++;
      eventChain = eventChain.then(() => handleEvent(notification));
      eventChain.catch((error) => {
        rejectEventFailure(error);
        void cancel();
      });
    });
    if (typeof maybeUnsubscribe === "function") unsubscribe = maybeUnsubscribe;

    const result = await raceWithAbort(
      Promise.race([
        client.prompt({ sessionId, content: prompt }),
        eventFailure,
      ]),
      signal,
    );
    await eventChain;

    if (result.events.length > MAX_INTERACTIVE_EVENTS - seen.size) {
      throw new InteractiveTuiError(
        "TUI_PROTOCOL",
        `session exceeded ${MAX_INTERACTIVE_EVENTS} total events`,
      );
    }

    // A streaming client normally saw these already. Render any transcript
    // events omitted from the stream, deduplicating by canonical eventId.
    for (const wire of result.events) {
      const event = deserializeEvent(wire) as InteractiveHarnessEvent;
      const canonical = serializeEvent(event);
      const streamed = seen.get(event.eventId);
      if (streamed !== undefined) {
        if (streamed !== canonical) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            `transcript event id "${sanitizeTerminalText(event.eventId)}" conflicts with the streamed event`,
          );
        }
        continue;
      }
      if (event.type === "permission.requested" || event.type === "permission.resolved") {
        throw new InteractiveTuiError(
          "TUI_PROTOCOL",
          "permission events must be delivered through the live event stream",
        );
      }
      if (event.type === "agent.stopped") {
        if (terminalStatus !== undefined) {
          throw new InteractiveTuiError(
            "TUI_PROTOCOL",
            "session emitted more than one agent.stopped event",
          );
        }
        terminalStatus = event.data.status;
      }
      seen.set(event.eventId, canonical);
      out(renderEventLine(nextRenderSeq++, event, { color: false }));
    }

    for (const request of permissionRequests.values()) {
      if (request.decision === undefined || !request.resolved) {
        throw new InteractiveTuiError(
          "TUI_PROTOCOL",
          `permission "${sanitizeTerminalText(request.permissionId)}" was not resolved in the event stream`,
        );
      }
    }
    if (terminalStatus === undefined) {
      throw new InteractiveTuiError(
        "TUI_PROTOCOL",
        "session completed without an agent.stopped event",
      );
    }
    const eventResultStatus = terminalStatus === "completed" ? "completed" : "failed";
    if (result.status !== eventResultStatus) {
      throw new InteractiveTuiError(
        "TUI_PROTOCOL",
        "prompt result status conflicts with the agent.stopped event",
      );
    }

    if (result.finalText.length > 0) out(sanitizeTerminalText(result.finalText));
    return result.status === "completed" ? 0 : 2;
  } catch (error) {
    if (error instanceof InteractiveTuiError && error.code === "TUI_ABORTED") {
      await cancel();
      return 130;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      unsubscribe?.();
    } catch {
      // Transport close still runs if an injected subscription misbehaves.
    }
    try {
      await client?.close();
    } catch {
      // Cleanup must not mask the session result or its typed failure.
    }
  }
}

export interface ParsedConnectArgs extends InteractiveRunOptions {}

/** Strict parser for the `harness-view connect` command. */
export function parseConnectArgs(
  argv: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ParsedConnectArgs {
  const url = argv[0];
  if (!url) {
    throw new InteractiveTuiError("TUI_USAGE", "connect requires a WebSocket URL");
  }
  parseEndpoint(url);

  let workspace: string | undefined;
  let taskId: string | undefined;
  let model: string | undefined;
  let token = env.HARNESS_AGENT_TOKEN?.trim() || undefined;
  const prompt: string[] = [];
  let positionalOnly = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (positionalOnly) {
      prompt.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (arg === "--workspace" || arg === "--task" || arg === "--model" || arg === "--token") {
      const value = argv[++i];
      if (!value) {
        throw new InteractiveTuiError("TUI_USAGE", `${arg} requires a value`);
      }
      if (arg === "--workspace") workspace = resolve(cwd, value);
      else if (arg === "--task") taskId = value;
      else if (arg === "--model") model = value;
      else token = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new InteractiveTuiError("TUI_USAGE", `unknown connect option "${arg}"`);
    }
    prompt.push(arg);
  }

  if (!workspace) {
    throw new InteractiveTuiError("TUI_USAGE", "connect requires --workspace <path>");
  }

  return {
    url,
    workspace,
    taskId,
    model,
    ...(token ? { token } : {}),
    prompt: prompt.length > 0 ? prompt.join(" ") : undefined,
  };
}

export async function runConnectCommand(
  argv: string[],
  ctx: InteractiveContext = {},
): Promise<number> {
  const err = ctx.err ?? console.error;
  let options: ParsedConnectArgs;
  try {
    options = parseConnectArgs(argv, ctx.cwd, ctx.env);
  } catch (error) {
    if (error instanceof InteractiveTuiError) {
      err(`harness-view: ${sanitizeTerminalText(error.message)}`);
      return 1;
    }
    throw error;
  }

  try {
    return await runInteractive(options, ctx);
  } catch (error) {
    err(`harness-view: ${safeInteractiveErrorMessage(error, options)}`);
    return error instanceof InteractiveTuiError &&
      (error.code === "TUI_USAGE" || error.code === "TUI_PROMPT_REQUIRED")
      ? 1
      : 2;
  }
}
