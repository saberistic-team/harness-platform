import { z } from "zod";
import { invokeWorkspaceOperation, safePath, isIsolatedWorkspace, WorkspaceAdapterError } from "@harness/workspace";
import { createBoundedTool, ToolRegistry, type Tool, type ToolExecutionContext } from "./tool";
import { createReadFileTool } from "./fs-tools";

export const DEVELOPMENT_TOOL_NAMES = Object.freeze(["fs.read", "fs.list", "fs.write", "process.exec", "git.diff"] as const);
const MAX_BYTES = 128 * 1024;
const path = z.string().min(1).max(4096);
const text = z.string().refine(s => Buffer.byteLength(s) <= MAX_BYTES, "text exceeds byte limit");
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? "null") > MAX_BYTES) {
    throw new WorkspaceAdapterError("TOOL_OUTPUT_LIMIT", "tool output exceeds byte limit");
  }
  return value;
}
function active(context?: ToolExecutionContext, mutation = false) {
  context?.signal?.throwIfAborted();
  if (mutation && !isIsolatedWorkspace(context?.workspace)) {
    throw new WorkspaceAdapterError("WORKSPACE_ISOLATION_REQUIRED", "model mutation requires the isolated DockerWorkspace; local inspection remains read-only");
  }
  return context?.workspace;
}
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false }) as Tool["inputSchema"];

/** Exactly five canonical capabilities. Workspace adapters own containment and effect limits. */
export function createDevelopmentTools(root: string): ToolRegistry {
  return new ToolRegistry([
    createReadFileTool(root),
    createBoundedTool({
      name: "fs.list", description: "List bounded workspace file paths.",
      parameters: z.object({ path }).strict(),
      inputSchema: object({ path: { type: "string" } }, ["path"]),
      authorization: p => ({ action: "fs.list", subject: (p as {path:string}).path }),
      execute: async ({path}, context) => bounded(await invokeWorkspaceOperation(active(context), { operation: "listFiles", path: safePath(path, true) })),
    }, {kind:"workspace", access:"read", capability:"listFiles", root}),
    createBoundedTool({
      name: "fs.write", description: "Atomically write bounded UTF-8 text within allowed paths.",
      parameters: z.object({ path, contents: text }).strict(),
      inputSchema: object({ path: {type:"string"}, contents:{type:"string", maxLength:MAX_BYTES} }, ["path","contents"]),
      authorization: p => ({ action:"fs.write", subject:(p as {path:string}).path }),
      execute: async ({path,contents}, context) => { await invokeWorkspaceOperation(active(context, true), {operation:"writeFile", path:safePath(path), contents}); return {path}; },
    }, {kind:"workspace",access:"write",capability:"writeFile",root}),
    createBoundedTool({
      name:"process.exec", description:"Execute bounded argv without a shell. cwd is workspace-relative: omit it or use dot for the workspace root; never use /workspace.",
      parameters:z.object({ argv:z.array(z.string().max(8192).refine(s=>!s.includes("\0"))).min(1).max(128), cwd:path.refine(value => !value.startsWith("/"), "cwd must be workspace-relative; omit cwd or use dot for the workspace root, never /workspace").optional(), timeoutMs:z.number().int().min(1).max(30000).optional() }).strict(),
      inputSchema:object({argv:{type:"array",minItems:1,maxItems:128,items:{type:"string",maxLength:8192}},cwd:{type:"string",pattern:"^[^/]",description:"Workspace-relative directory. Omit or use . for the root. Absolute paths including /workspace are invalid."},timeoutMs:{type:"integer",minimum:1,maximum:30000}},["argv"]),
      authorization:p=>({action:"process.exec",subject:(p as {argv:string[]}).argv.map(s=>/^[a-zA-Z0-9_./:@%+=,-]+$/.test(s)?s:`'${s.replaceAll("'", `'\\''`)}'`).join(" ")}),
      execute:async ({argv,cwd,timeoutMs},context)=>bounded(await invokeWorkspaceOperation(active(context, true),{operation:"execute",command:{argv:argv as [string,...string[]],...(cwd===undefined?{}:{cwd:safePath(cwd,true)}),timeoutMs:timeoutMs??30000,...(context?.signal?{signal:context.signal}:{})}})),
    },{kind:"workspace",access:"execute",capability:"execute",root}),
    createBoundedTool({
      name:"git.diff", description:"Return a bounded diff against the initial workspace snapshot.",
      parameters:z.object({}).strict(), inputSchema:object({},[]),
      authorization:()=>({action:"git.diff"}),
      execute:async (_p,context)=>bounded(await invokeWorkspaceOperation(active(context),{operation:"diff"})),
    },{kind:"workspace",access:"read",capability:"diff",root}),
  ]);
}
