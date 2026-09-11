import { validateRunReport, loadTaskManifestFile } from "@harness/sdk";
import { createNativeTaskAgent } from "../src/native-agent";
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
it("native model deadline aborts a pending request and rejects invalid configuration before Docker", async () => {
    const root = fixture();
    try {
        const manifestPath = join(root, "tasks/native.yaml");
        const input = { cwd: root, manifestPath, manifest: await loadTaskManifestFile(manifestPath), branch: "tasks/native", prompt: "wait", timeoutMs: 5000 };
        for (const modelTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
            await expect(createNativeTaskAgent({ image, modelTimeoutMs }).run(input)).rejects.toMatchObject({ code: "NATIVE_CONFIG_INVALID" });
        }
        let aborted = false;
        const agent = createNativeTaskAgent({ image, modelTimeoutMs: 20, modelAdapter: {
            async *stream(request) {
                await new Promise<void>((_resolve, reject) => {
                    const abort = () => { aborted = true; reject(request.signal!.reason); };
                    if (request.signal!.aborted) abort();
                    else request.signal!.addEventListener("abort", abort, { once: true });
                });
            },
        }, executor: { async execute(_program, args, options) {
            const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, outputTruncated: false };
            if (args[0] === "rm") return result;
            options.onSpawn?.();
            writeFileSync(args[args.indexOf("--cidfile") + 1]!, "a".repeat(64));
            const input = JSON.parse(options.input!);
            return { ...result, stdout: JSON.stringify({ version: 1, files: input.files, result: { exitCode: 0, stdout: "", stderr: "", timedOut: false } }) };
        } } });
        await expect(agent.run(input)).rejects.toMatchObject({ code: "RUNTIME_MODEL_TIMEOUT", timeoutMs: 20 });
        expect(aborted).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
function git(root: string, ...args: string[]) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "m16-"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, "fixture.txt"), "old\n");
    mkdirSync(join(root, "tasks/runs"), { recursive: true });
    writeFileSync(join(root, "tasks/runs/.gitkeep"), "");
    writeFileSync(join(root, "tasks/runs/prior-report.json"), '{"reserved":"evidence"}\n');
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
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
        const outcome = await runBootstrapTask({ cwd: root, manifestPath: "tasks/native.yaml", approveWrite: true, testCommand: `node -e "if(require('fs').readFileSync('fixture.txt','utf8').trim()!=='new')process.exit(1)"`, nativeSigningKey: keys.privateKey, native: { image, modelAdapter: model, modelTimeoutMs: 600000, restartAtSafeBoundary: true, executor: { async execute(_program, args, options) {
                        const result = { exitCode: 0, stdout: "", stderr: "", timedOut: false, aborted: false, outputTruncated: false };
                        if (args[0] === "rm")
                            return result;
                        options.onSpawn?.();
                        writeFileSync(args[args.indexOf("--cidfile") + 1]!, "a".repeat(64));
                        const input = JSON.parse(options.input!);
                        expect(Object.keys(input.files).filter(path => path.startsWith("tasks/runs/"))).toEqual([]);
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
        expect(readFileSync(join(root, "tasks/runs/prior-report.json"), "utf8")).toBe('{"reserved":"evidence"}\n');
        expect(git(root, "diff", "HEAD", "--", "tasks/runs/.gitkeep", "tasks/runs/prior-report.json")).toBe("");
        const att = report.builder!.nativeAttestation!;
        const events = JSON.parse(readFileSync(join(root, att.eventLogPath), "utf8")) as {
            type: string;
            eventId: string;
        }[];
        expect(events.filter(e => e.type === "runtime.continued")).toHaveLength(1);
        const checkpoints = (JSON.parse(readFileSync(join(root, att.eventLogPath), "utf8")) as { type: string; data: { payload?: { settings?: { modelTimeoutMs?: number } } } }[]).filter(e => e.type === "runtime.checkpoint");
        expect(checkpoints.length).toBeGreaterThan(0);
        expect(checkpoints.every(e => e.data.payload?.settings?.modelTimeoutMs === 600000)).toBe(true);
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

it('bootstrap accepts native path-specific reads and the kernel denies unmatched files', async () => {
    const root = fixture();
    try {
        const manifestPath = join(root, 'tasks/native.yaml');
        writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('fs.read: allow', 'fs.read:\n    fixture.txt: allow\n    "*": deny'));
        const model = new FakeModel([
            { toolCalls: [{ id: 'denied', name: 'fs.read', arguments: { path: 'tasks/native.yaml' } }] },
            { toolCalls: [{ id: 'allowed', name: 'fs.read', arguments: { path: 'fixture.txt' } }] },
            { content: 'done' },
        ]);
        const outcome = await runBootstrapTask({ cwd: root, manifestPath: 'tasks/native.yaml',
            testCommand: 'node -e "process.exit(0)"', native: { image, modelAdapter: model,
                executor: { async execute(_program, args, options) {
                    const result = { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false, outputTruncated: false };
                    if (args[0] === 'rm') return result;
                    options.onSpawn?.();
                    writeFileSync(args[args.indexOf('--cidfile') + 1]!, 'a'.repeat(64));
                    const input = JSON.parse(options.input!);
                    return { ...result, stdout: JSON.stringify({ version: 1, files: input.files, result: { exitCode: 0, stdout: '', stderr: '', timedOut: false } }) };
                } },
            },
        });
        expect(outcome.report.status, JSON.stringify(outcome.report)).toBe('passed');
        const report = validateRunReport(outcome.report);
        const events = JSON.parse(readFileSync(join(root, report.builder!.nativeAttestation!.eventLogPath), 'utf8'));
        expect(events.some((event: {type: string; data: {action?: string; effect?: string}}) => event.type === 'policy.decision' && event.data.action === 'fs.read' && event.data.effect === 'deny')).toBe(true);
        expect(JSON.stringify(model.requests)).not.toContain('title: Native fixture');
        expect(JSON.stringify(model.requests)).toContain('old');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
