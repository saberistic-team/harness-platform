import { spawn } from "node:child_process";

import {
  SandboxAbortedError,
  SandboxDockerHostError,
  SandboxExecutorError,
  SandboxSpecError,
} from "./errors";
import type {
  CommandExecutor,
  ExecuteOptions,
  ExecuteResult,
} from "./types";

const SAFE_PATH_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
] as const;

export const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";

export interface DockerClientEnvironmentOptions {
  dockerConfigDir: string;
  dockerHost?: string;
}

/**
 * Accept only a local Unix socket. Bind-mount sources are resolved by the
 * daemon, so remote contexts cannot safely consume paths validated here.
 */
export function validateLocalDockerHost(
  dockerHost = DEFAULT_DOCKER_HOST,
): string {
  if (
    typeof dockerHost !== "string" ||
    !/^unix:\/\/\/[^\u0000-\u001f\u007f?#]+$/u.test(dockerHost)
  ) {
    throw new SandboxDockerHostError(
      String(dockerHost),
      "expected an absolute unix:///path/to/docker.sock endpoint",
    );
  }
  return dockerHost;
}

/**
 * Build a complete Docker CLI environment. HOME and DOCKER_CONFIG both point
 * at an empty, runner-owned directory so user contexts, credential helpers,
 * and proxy injection from ~/.docker/config.json cannot cross the boundary.
 */
export function restrictedDockerClientEnv(
  source: NodeJS.ProcessEnv,
  options: DockerClientEnvironmentOptions,
): NodeJS.ProcessEnv {
  if (
    typeof options.dockerConfigDir !== "string" ||
    options.dockerConfigDir.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(options.dockerConfigDir)
  ) {
    throw new SandboxSpecError("dockerConfigDir must be a safe non-empty path");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PATH_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  const dockerHost = validateLocalDockerHost(options.dockerHost);
  return {
    ...env,
    HOME: options.dockerConfigDir,
    DOCKER_CONFIG: options.dockerConfigDir,
    DOCKER_HOST: dockerHost,
    TMPDIR: options.dockerConfigDir,
    TMP: options.dockerConfigDir,
    TEMP: options.dockerConfigDir,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
}

function appendBounded(
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; truncated: boolean },
  limit: number,
): void {
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining > 0) {
    const kept = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    chunks.push(kept);
    state.bytes += kept.byteLength;
  }
  if (chunk.byteLength > remaining) state.truncated = true;
}

export class NodeCommandExecutor implements CommandExecutor {
  async execute(
    executable: string,
    args: readonly string[],
    options: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (
      typeof executable !== "string" ||
      executable.length === 0 ||
      executable.includes("\u0000") ||
      !Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > 2_147_483_647 ||
      !Number.isFinite(options.maxOutputBytes) ||
      options.maxOutputBytes < 0 ||
      options.environment === null ||
      typeof options.environment !== "object" ||
      Array.isArray(options.environment)
    ) {
      throw new SandboxSpecError("invalid command-executor options");
    }
    if (options.signal?.aborted) {
      throw new SandboxAbortedError("sandbox command was canceled before spawn");
    }

    return new Promise<ExecuteResult>((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, [...args], {
          cwd: options.cwd,
          env: options.environment,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        reject(new SandboxExecutorError(`failed to spawn ${executable}`, cause));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const state = { bytes: 0, truncated: false };
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const terminateForAbort = () => {
        if (settled || aborted || timedOut) return;
        aborted = true;
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", terminateForAbort, { once: true });
      if (options.signal?.aborted) terminateForAbort();

      const timer = setTimeout(() => {
        if (settled || aborted) return;
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref();

      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", terminateForAbort);
      };

      child.once("spawn", () => {
        try {
          options.onSpawn?.();
        } catch {
          // Audit callbacks cannot replace the child-process outcome.
        }
      });
      child.stdout.on("data", (chunk: Buffer | string) => {
        appendBounded(stdout, Buffer.from(chunk), state, options.maxOutputBytes);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        appendBounded(stderr, Buffer.from(chunk), state, options.maxOutputBytes);
      });
      child.once("error", (cause) => {
        if (settled) return;
        settled = true;
        finish();
        reject(
          new SandboxExecutorError(
            `failed to execute ${executable}`,
            cause,
            { args: [...args] },
          ),
        );
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        finish();
        resolve({
          exitCode: code ?? (aborted ? 130 : timedOut ? 124 : 1),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          signal: signal ?? undefined,
          timedOut,
          aborted,
          outputTruncated: state.truncated,
        });
      });
    });
  }
}
