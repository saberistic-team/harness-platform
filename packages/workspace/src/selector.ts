import { DockerWorkspace, type DockerWorkspaceOptions } from "./docker";
import { LocalWorkspace, type LocalWorkspaceOptions } from "./local";
import { fail } from "./adapter-common";
import type { Workspace } from "./index";
export type NativeWorkspaceOptions =
  | (DockerWorkspaceOptions & { backend?: "docker" })
  | (LocalWorkspaceOptions & { backend: "local" });
/** Native capability selection only. Upstream Pi TaskAgent dispatch is unchanged. */
export async function createNativeWorkspace(options: NativeWorkspaceOptions): Promise<Workspace> {
  if (!options || typeof options !== "object") fail("MALFORMED", "workspace options required");
  if (options.backend === "local") return new LocalWorkspace(options);
  if (options.backend === undefined || options.backend === "docker") return DockerWorkspace.create(options);
  return fail("UNSUPPORTED", "unknown workspace backend");
}
