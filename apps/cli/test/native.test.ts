import { validateRunReport } from "@harness/sdk";
import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { runBootstrapTask } from "../src/bootstrap";
import { FakeModel } from "../../../packages/models/src";
import { verifyNativeEvidence } from "../src/native-attestation";
const image = `node@sha256:${"a".repeat(64)}`;
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "m16-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "fixture.txt"), "old\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    mkdirSync(join(root, "tasks"));
    writeFileSync(join(root, "tasks/native.yaml"), `id: native\ntitle: Native fixture\ngoal: Edit fixture\nacceptance:\n  - fixture is new\nallowed_paths:\n  - fixture.txt\n  - tasks/native.yaml\npermissions:\n  fs.read: allow\n  fs.write: allow\n  process.exec: allow\n  git.diff: allow\n  network: deny\ndelivery:\n  type: none\n`);
    return root;
}
it("M16/M17 offline native edit/test/diff, restart, clean authorship and candidate/accepted binding without Pi", async () => {
    const root = fixture();
    let tested = 0;
    const manifestPath = join(root, "tasks/native.yaml");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace("fs.write: allow", "fs.write: ask"));
    const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const model = new FakeModel([{ toolCalls: [{ id: "write", name: "fs.write", arguments: { path: "fixture.txt", contents: "new\n" } }] }, { toolCalls: [{ id: "test", name: "process.exec", arguments: { argv: ["fixture-tests"] } }] }, { toolCalls: [{ id: "diff", name: "git.diff", arguments: {} }] }, { content: "done" }]);
    try {
        const main = git(root, "rev-parse", "main");
        const outcome = await runBootstrapTask({ cwd: root, manifestPath: "tasks/native.yaml", approveWrite: true, testCommand: `node -e "if(require('fs').readFileSync('fixture.txt','utf8').trim()!=='new')process.exit(1)"`, nativeSigningKey: keys.privateKey, native: { image, modelAdapter: model, restartAtSafeBoundary: true, executor: { async execute(_program, args, options) {
                        const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, outputTruncated: false };
                        if (args[0] === "rm")
                            return result;
                        options.onSpawn?.();
                        writeFileSync(args[args.indexOf("--cidfile") + 1]!, "a".repeat(64));
                        const input = JSON.parse(options.input!);
                        if (input.command.argv[0] === "fixture-tests") {
                            tested++;
                            expect(input.files["fixture.txt"]).toBe("new\n");
                        }
                        return { ...result, stdout: JSON.stringify({ version: 1, files: input.files, result: { exitCode: 0, stdout: "passed", stderr: "", timedOut: false } }) };
                    } } } });
        expect(outcome.report.status, JSON.stringify({ failure: "failure" in outcome.report ? outcome.report.failure : null, policy: "policy" in outcome.report ? outcome.report.policy : null })).toBe("passed");
        const report = validateRunReport(outcome.report);
        expect(report.schema).toBe("run-report/v2");
        expect(tested).toBe(1);
        expect(model.requests).toHaveLength(4);
        expect(git(root, "branch", "--show-current")).toBe("tasks/native");
        expect(git(root, "rev-parse", "main")).toBe(main);
        const att = report.builder!.nativeAttestation!;
        const events = JSON.parse(readFileSync(join(root, att.eventLogPath), "utf8")) as {
            type: string;
            eventId: string;
        }[];
        expect(events.filter(e => e.type === "runtime.continued")).toHaveLength(1);
        expect(events.filter(e => e.type === "policy.decision")).toHaveLength(3);
        expect(new Set(events.map(e => e.eventId)).size).toBe(events.length);
        git(root, "add", "fixture.txt", "tasks/native.yaml");
        git(root, "commit", "-qm", "candidate");
        const candidate = git(root, "rev-parse", "HEAD");
        verifyNativeEvidence(root, report, publicKey, candidate, { commit: candidate, base: main });
        expect(() => verifyNativeEvidence(root, { ...report, status: "failed" }, publicKey, candidate)).toThrow();
        const patch = readFileSync(join(root, att.patchPath), "utf8");
        writeFileSync(join(root, att.patchPath), patch + "tampered");
        expect(() => verifyNativeEvidence(root, report, publicKey, candidate)).toThrow("NATIVE_ARTIFACT_MISMATCH");
        writeFileSync(join(root, att.patchPath), patch);
        git(root, "switch", "-c", "accepted", main);
        writeFileSync(join(root, "unrelated.txt"), "upstream\n");
        git(root, "add", "unrelated.txt");
        git(root, "commit", "-qm", "new base");
        const acceptedBase = git(root, "rev-parse", "HEAD");
        git(root, "apply", join(root, att.patchPath));
        git(root, "add", "fixture.txt", "tasks/native.yaml");
        git(root, "commit", "-qm", "squashed or rebased native patch");
        const binding = verifyNativeEvidence(root, report, publicKey, candidate, { commit: "HEAD", base: acceptedBase });
        expect(binding.acceptedTree).not.toBe(binding.candidateTree);
        git(root, "switch", "tasks/native");
        writeFileSync(join(root, "fixture.txt"), "human conflict edit\n");
        git(root, "add", "fixture.txt");
        git(root, "commit", "-qm", "human edit");
        expect(() => verifyNativeEvidence(root, report, publicKey, candidate, { commit: "HEAD", base: main })).toThrow("conflict edits must return to the builder");
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 20000);
it.each(["unstaged", "staged", "committed"])("M17 independent %s seeded source is rejected even inside allowed_paths before the model is called", async (mode) => {
    const root = fixture();
    const model = new FakeModel([{ content: "claim seed" }]);
    try {
        if (mode === "committed")
            git(root, "switch", "-c", "tasks/native");
        writeFileSync(join(root, "fixture.txt"), "pre-authored\n");
        if (mode !== "unstaged")
            git(root, "add", "fixture.txt");
        if (mode === "committed")
            git(root, "commit", "-qm", "seeded patch");
        const result = await runBootstrapTask({ cwd: root, manifestPath: "tasks/native.yaml", native: { image, modelAdapter: model } });
        expect(result.report.status).toBe("blocked");
        expect(validateRunReport(result.report).failure?.code).toBe("NATIVE_PREAUTHORED_INPUT");
        expect(model.requests).toHaveLength(0);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
