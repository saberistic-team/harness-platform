/** Internal attestation of the reviewed isolated adapter and its bound views.
 * Model parameters and arbitrary object properties cannot manufacture this grant.
 * Replacing any attested method revokes it before a capability can be rebound.
 */
const grants = new WeakMap<object, Readonly<Record<string, unknown>>>();
const methods = ["readFile", "writeFile", "listFiles", "execute", "diff", "snapshot", "dispose"];
export function attestIsolatedWorkspace(value: object): void {
  grants.set(value, Object.freeze(Object.fromEntries(methods.map(name => [name, Reflect.get(value, name)]))));
}
export function isIsolatedWorkspace(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const grant = grants.get(value);
  if (!grant) return false;
  try { return methods.every(name => Reflect.get(value, name) === grant[name]); }
  catch { return false; }
}
export function inheritWorkspaceIsolation(source: unknown, view: object): void {
  if (isIsolatedWorkspace(source)) attestIsolatedWorkspace(view);
}
