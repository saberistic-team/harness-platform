import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import type { PermissionMap } from "@harness/policy";

/**
 * The TASK MANIFEST is the machine-readable task contract.
 *
 * One file per dogfooded task. It is the single source of truth that
 * feeds:
 *   - the policy engine  (permissions, allowed_paths)
 *   - the scheduler      (id, budget, delivery)
 *   - the CLI / UI       (title, goal, acceptance)
 *   - the audit log      (id links every run and decision)
 *   - the eval system    (acceptance + scenarios)
 *
 * Schema is zod so the same shape is validated in TypeScript and
 * (via serialization) in any future language.
 */

const identifier =
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const effect = z.enum(["allow", "ask", "deny"]);

const permissionValue = z.union([
  effect,
  z.record(effect).passthrough(),
]);

export const taskManifestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(identifier, "id must be a kebab-case identifier"),
    title: z.string().min(1),
    goal: z.string().min(1),
    acceptance: z.array(z.string().min(1)).min(1),
    allowed_paths: z
      .array(z.string().min(1))
      .min(1)
      .describe("globs of paths this task may modify"),
    permissions: z
      .record(permissionValue)
      .describe(
        "action -> effect, or action -> {subjectPattern -> effect}",
      ),
    budget: z
      .object({
        max_model_tokens: z.number().int().positive().optional(),
        max_tool_calls: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    delivery: z
      .object({
        type: z
          .enum(["pull_request", "merge", "artifact", "none"])
          .default("pull_request"),
      })
      .strict(),
  })
  .strict();

export type TaskManifest = z.infer<typeof taskManifestSchema>;

export type TaskPermissions = z.infer<typeof taskManifestSchema>["permissions"];

export interface ManifestIssue {
  path: string;
  message: string;
}

export class ManifestParseError extends Error {
  constructor(
    readonly issues: ManifestIssue[],
  ) {
    super(
      `invalid task manifest: ${issues.map((i) => `${i.path || "<root>"} ${i.message}`).join("; ")}`,
    );
    this.name = "ManifestParseError";
  }
}

export function decodeTaskManifest(doc: unknown): TaskManifest {
  const result = taskManifestSchema.safeParse(doc);
  if (!result.success) {
    throw new ManifestParseError(
      result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}

/** Parse YAML text (a task manifest file) into a validated manifest. */
export function loadTaskManifest(yamlText: string): TaskManifest {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    throw new ManifestParseError([
      { path: "<yaml>", message: `invalid YAML: ${(err as Error).message}` },
    ]);
  }
  return decodeTaskManifest(doc);
}

export async function loadTaskManifestFile(
  path: string,
): Promise<TaskManifest> {
  const text = await readFile(path, "utf8");
  return loadTaskManifest(text);
}

/** View the manifest's permissions as the policy engine's rule map. */
export function manifestPermissions(
  manifest: TaskManifest,
): PermissionMap {
  return manifest.permissions as PermissionMap;
}
