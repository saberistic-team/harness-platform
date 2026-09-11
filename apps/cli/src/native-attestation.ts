import { NativeBuilderError } from "./native-error";
import { createHash, generateKeyPairSync, sign, verify, type KeyObject, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, lstatSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { NativeBuilderAttestation, RunReport } from "@harness/sdk";
import { validateRunReport } from "@harness/sdk";
import { git, type GitChangeSnapshot } from "./git";
import type { NativeRunEvidence } from "./native-agent";
export const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export function canonical(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
function checkedGit(root: string, args: string[]): string { const result = git(root, args); if (!result.ok)
    throw Error(result.stdout); return result.stdout; }
/** Content-addressed revision includes all executable platform source and dependency lock. */
export function builderSourceRevision(): string {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const entries: [
        string,
        string
    ][] = [];
    const visit = (path: string) => {
        for (const name of readdirSync(join(root, path)).sort()) {
            const next = join(path, name), stat = lstatSync(join(root, next));
            if (stat.isSymbolicLink())
                throw new NativeBuilderError("NATIVE_SOURCE_SYMLINK");
            if (stat.isDirectory()) {
                if (name === "src")
                    visit(next);
                else if (!["node_modules", "test", "dist"].includes(name))
                    visit(next);
            }
            else if (next.includes("/src/") && name.endsWith(".ts"))
                entries.push([next, digest(readFileSync(join(root, next)))]);
        }
    };
    visit("packages");
    visit("apps/cli");
    visit("services");
    entries.push(["pnpm-lock.yaml", digest(readFileSync(join(root, "pnpm-lock.yaml")))]);
    return digest(canonical(entries));
}
function gitInput(root: string, args: string[], input?: string, index?: string): string {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
    return execFileSync("git", ["--no-replace-objects", "-c", "core.fileMode=true", ...args], { cwd: root, env: { ...env, GIT_NO_REPLACE_OBJECTS: "1", ...(index ? { GIT_INDEX_FILE: index } : {}) }, input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}
/** A separate index prevents the trusted gate from staging the user's checkout. */
export function captureGeneratedTree(root: string, base: string, paths: readonly string[]): string {
    const directory = mkdtempSync(join(tmpdir(), "harness-tree-")), index = join(directory, "index");
    try {
        gitInput(root, ["read-tree", base], undefined, index);
        for (const path of paths) {
            const full = resolve(root, path);
            if (!full.startsWith(resolve(root) + "/"))
                throw new NativeBuilderError("NATIVE_PATH_ESCAPE");
            let stat;
            try {
                stat = lstatSync(full);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error;
            }
            if (!stat) {
                gitInput(root, ["update-index", "--force-remove", "--", path], undefined, index);
                continue;
            }
            if (!stat.isFile() || stat.nlink !== 1)
                throw new NativeBuilderError("NATIVE_NONREGULAR_OUTPUT");
            const hash = gitInput(root, ["hash-object", "-w", "--no-filters", "--stdin"], readFileSync(full, "utf8")).trim();
            gitInput(root, ["update-index", "--add", "--cacheinfo", stat.mode & 0o111 ? "100755" : "100644", hash, path], undefined, index);
        }
        return gitInput(root, ["write-tree"], undefined, index).trim();
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
}
export function canonicalPatch(root: string, base: string, tree: string): string {
    return checkedGit(root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", base, tree, "--"]);
}
export function applyNativePatch(root: string, patch: string): void {
    if (!patch)
        return;
    gitInput(root, ["apply", "--check", "--whitespace=nowarn", "-"], patch);
    gitInput(root, ["apply", "--whitespace=nowarn", "-"], patch);
}
const pendingArtifacts = new Map<string, Record<string, string>>();
export function persistNativeArtifacts(attestation: NativeBuilderAttestation, root: string): void {
    const artifacts = pendingArtifacts.get(attestation.runId);
    if (!artifacts)
        throw new NativeBuilderError("NATIVE_ARTIFACTS_UNAVAILABLE");
    mkdirSync(join(root, "tasks/runs"), { recursive: true });
    for (const [path, wire] of Object.entries(artifacts))
        writeFileSync(join(root, path), wire, { flag: "wx" });
}
export function recordNativeAttestation(root: string, manifestPath: string, base: string, sourceRevision: string, evidence: NativeRunEvidence, preBuilder: GitChangeSnapshot, postBuilder: GitChangeSnapshot, preBuilderTree: string): NativeBuilderAttestation {
    const generatedTree = captureGeneratedTree(root, base, postBuilder.policyPaths);
    const patch = canonicalPatch(root, base, generatedTree);
    const patchPath = `tasks/runs/${evidence.runId}.patch`, eventLogPath = `tasks/runs/${evidence.runId}.events.json`, workspaceLogPath = `tasks/runs/${evidence.runId}.workspace.json`;
    const eventLog = canonical(evidence.events), workspaceLog = canonical(evidence.workspaceEvents);
    pendingArtifacts.set(evidence.runId, { [patchPath]: patch, [eventLogPath]: eventLog, [workspaceLogPath]: workspaceLog });
    return { version: "native-builder/v1", entrypoint: evidence.entrypoint, builderSourceRevision: sourceRevision, image: evidence.image, model: evidence.model,
        manifestDigest: digest(readFileSync(manifestPath)), inputBaseSha: base, workspaceId: evidence.workspaceId, sessionId: evidence.sessionId, runId: evidence.runId,
        initialSnapshot: evidence.initialSnapshot, generatedSnapshot: evidence.generatedSnapshot, generatedTree, patchDigest: digest(patch), workspacePatchDigest: digest(evidence.patch), eventLogDigest: digest(eventLog), workspaceLogDigest: digest(workspaceLog), preBuilder, postBuilder, preBuilderTree, patchPath, eventLogPath, workspaceLogPath };
}
const localAuthority = generateKeyPairSync("ed25519");
export function nativeEvidencePublicKey(): string { return localAuthority.publicKey.export({ type: "spki", format: "pem" }).toString(); }
export function sealNativeReport(report: RunReport, key: KeyObject = localAuthority.privateKey): RunReport {
    if (!report.builder?.nativeAttestation)
        return report;
    const { nativeSeal: _, ...payload } = report;
    return validateRunReport({ ...payload, nativeSeal: { algorithm: "Ed25519", publicKey: createPublicKey(key).export({ type: "spki", format: "pem" }).toString(), signature: sign(null, Buffer.from(canonical(payload)), key).toString("base64") } });
}
/** The public key is a separately pinned CI trust input, never trusted from the report. */
export function verifyNativeEvidence(root: string, report: RunReport, trustedPublicKey: string, candidate: string, accepted?: {
    commit: string;
    base: string;
}) {
    const parsed = validateRunReport(report), { nativeSeal, ...payload } = parsed, attestation = parsed.builder?.nativeAttestation;
    if (!nativeSeal || !attestation || parsed.status !== "passed" || parsed.schema !== "run-report/v2" ||
        createPublicKey(nativeSeal.publicKey).export({ type: "spki", format: "pem" }) !== createPublicKey(trustedPublicKey).export({ type: "spki", format: "pem" }) || !verify(null, Buffer.from(canonical(payload)), trustedPublicKey, Buffer.from(nativeSeal.signature, "base64")))
        throw new NativeBuilderError("NATIVE_EVIDENCE_UNTRUSTED");
    const read = (path: string) => { const absolute = resolve(root, path); if (!absolute.startsWith(resolve(root) + "/tasks/runs/"))
        throw new NativeBuilderError("NATIVE_ARTIFACT_PATH"); return readFileSync(absolute); };
    if (digest(read(attestation.patchPath)) !== attestation.patchDigest || digest(read(attestation.eventLogPath)) !== attestation.eventLogDigest || digest(read(attestation.workspaceLogPath)) !== attestation.workspaceLogDigest)
        throw new NativeBuilderError("NATIVE_ARTIFACT_MISMATCH");
    const candidateCommit = checkedGit(root, ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`]).trim();
    const tree = checkedGit(root, ["rev-parse", "--verify", `${candidateCommit}^{tree}`]).trim();
    if (tree !== attestation.generatedTree || digest(canonicalPatch(root, attestation.inputBaseSha, tree)) !== attestation.patchDigest)
        throw new NativeBuilderError("NATIVE_CANDIDATE_MISMATCH");
    const acceptedCommit = accepted ? checkedGit(root, ["rev-parse", "--verify", "--end-of-options", `${accepted.commit}^{commit}`]).trim() : undefined;
    const acceptedBase = accepted ? checkedGit(root, ["rev-parse", "--verify", "--end-of-options", `${accepted.base}^{commit}`]).trim() : undefined;
    if (accepted && digest(canonicalPatch(root, acceptedBase!, acceptedCommit!)) !== attestation.patchDigest)
        throw new NativeBuilderError("NATIVE_ACCEPTED_PATCH_MISMATCH", "conflict edits must return to the builder");
    return { version: "native-acceptance/v1", attestationDigest: digest(canonical(attestation)),
        candidateCommit, candidateTree: tree,
        patchDigest: attestation.patchDigest,
        ...(accepted ? { acceptedCommit, acceptedTree: checkedGit(root, ["rev-parse", "--verify", `${acceptedCommit}^{tree}`]).trim(), acceptedBase } : {}), };
}
