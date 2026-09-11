import { describe, expect, it } from 'vitest';
// @ts-expect-error Reviewed standalone image helper has no TypeScript declaration.
import { checkArguments, runCheck } from '../../../infra/docker/native-check.mjs';

describe('native focused test command', () => {
  it('builds a fixed argv with one scoped test target', () => {
    expect(checkArguments(['apps/cli/test/doctor.test.ts'])).toEqual([
      '/node_modules/vitest/vitest.mjs', 'run', 'apps/cli/test/doctor.test.ts',
      '--config', '/opt/harness/native-check.config.mjs', '--configLoader=native', '--maxWorkers=1',
      '--no-file-parallelism', '--passWithNoTests=false',
    ]);
  });
  it.each([[], ['--help'], ['../escape.test.ts'], ['apps/cli/test/../../escape.test.ts'],
    ['apps/cli/test/test.ts'], ['apps/cli/test/a.test.ts', '--update'],
    ['/apps/cli/test/a.test.ts'], ['apps/cli/test/a.test.ts;id']])('rejects invalid targets %j', (...args) => {
      expect(() => checkArguments(args)).toThrow('NATIVE_CHECK_TARGET');
    });
});

// @ts-expect-error Reviewed standalone image helper has no TypeScript declaration.
import { buildContext } from '../../../infra/docker/build-native-test.mjs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('builds a manifest-only context with live workspace package links', () => {
  const context = mkdtempSync(join(tmpdir(), 'native-test-context-'));
  try {
    buildContext(process.cwd(), context);
    const files = readdirSync(context, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => entry.name);
    expect(files.every(name => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
      'link-workspaces.mjs', 'native-test.Dockerfile', 'native-check.mjs', 'native-check.config.mjs'].includes(name))).toBe(true);
    expect(existsSync(join(context, 'apps/cli/src/main.ts'))).toBe(false);
    expect(readFileSync(join(context, 'pnpm-lock.yaml'), 'utf8')).toBe(readFileSync('pnpm-lock.yaml', 'utf8'));
    const links = readFileSync(join(context, 'link-workspaces.mjs'), 'utf8');
    expect(links).toContain('"name":"@harness/kernel","path":"packages/kernel"');
    expect(links).toContain("symlinkSync('/workspace/'+item.path,dest)");
  } finally { rmSync(context, { recursive: true, force: true }); }
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DockerWorkspace } from '../../../packages/workspace/src/docker';

it.skipIf(!process.env.HARNESS_NATIVE_TEST_IMAGE)('returns failing then corrected feedback inside the pinned sandbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-check-live-'));
  let workspace: DockerWorkspace | undefined;
  try {
    for (const path of execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(path => path && !path.startsWith('tasks/runs/'))) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), readFileSync(path));
    }
    const target = 'apps/cli/test/native-feedback-probe.test.ts';
    const source = (expected: number) => `import {it,expect} from 'vitest'; import {SESSIONS_SCHEMA_VERSION} from '@harness/sessions'; it('live source',()=>expect(SESSIONS_SCHEMA_VERSION).toBe(${expected}));\n`;
    writeFileSync(join(root, target), source(999));
    workspace = await DockerWorkspace.create({ root, allowedPaths: [target], image: process.env.HARNESS_NATIVE_TEST_IMAGE! });
    const check = (path = target) => workspace!.execute({ argv: ['node', '/opt/harness/native-check.mjs', path], timeoutMs: 30000 });
    const before = (await workspace.snapshot()).id;
    const failed = await check();
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout + failed.stderr).toContain('expected 2 to be 999');
    expect((await workspace.snapshot()).id).toBe(before);
    await workspace.writeFile(target, source(2));
    const edited = (await workspace.snapshot()).id;
    const passed = await check();
    expect(passed.exitCode, passed.stdout + passed.stderr).toBe(0);
    expect((await workspace.snapshot()).id).toBe(edited);
    expect(passed.stdout).toContain('NATIVE_CHECK_STAGE: typecheck');
    await workspace.writeFile(target, source(2) + 'const wrong: string = 123;\n');
    const beforeCompilerFailure = (await workspace.snapshot()).id;
    const compilerFailure = await check();
    expect(compilerFailure.exitCode).not.toBe(0);
    expect(compilerFailure.stdout + compilerFailure.stderr).toContain('TS2322');
    expect((await workspace.snapshot()).id).toBe(beforeCompilerFailure);
    expect((await check('apps/cli/test/missing.test.ts')).exitCode).not.toBe(0);
  } finally { await workspace?.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 90000);


it('returns compiler failures after passing tests within a shared deadline', () => {
  const calls: {argv: string[]; options: {timeout: number}}[] = [];
  let clock = 0;
  let output = '';
  const status = runCheck(['apps/cli/test/doctor.test.ts'], {
    now: () => clock, out: (text: string) => { output += text; }, err: (text: string) => { output += text; },
    spawn: (_program: string, argv: string[], options: {timeout: number}) => {
      calls.push({argv, options}); clock += 10000;
      return { status: calls.length === 1 ? 0 : 2, stdout: calls.length === 1 ? 'tests passed' : 'TS2322: wrong type', stderr: '' };
    },
  });
  expect(status).toBe(2);
  expect(calls.map(call => call.options.timeout)).toEqual([25000, 15000]);
  expect(calls[1]!.argv).toContain('--noEmit');
  expect(output).toContain('NATIVE_CHECK_STAGE: typecheck');
  expect(output).toContain('TS2322');
});

it('does not start the compiler after failed tests or exhausted time', () => {
  for (const testStatus of [1, 0]) {
    let count = 0;
    let clock = 0;
    const status = runCheck(['apps/cli/test/doctor.test.ts'], {
      now: () => clock, out: () => {}, err: () => {},
      spawn: () => { count++; clock = 25000; return { status: testStatus, stdout: '', stderr: '' }; },
    });
    expect(status).not.toBe(0);
    expect(count).toBe(1);
  }
});

import { loadTaskManifest } from '../../../packages/sdk/src/task-manifest';

it('documents a valid native fixture and exposes the missing delivery failure', () => {
  const guide = readFileSync('infra/docker/native-authoring.md', 'utf8');
  const yaml = /```yaml\n([\s\S]*?)```/.exec(guide)?.[1];
  expect(yaml).toBeDefined();
  expect(loadTaskManifest(yaml!).delivery.type).toBe('none');
  expect(() => loadTaskManifest(yaml!.replace(/delivery:\n  type: none\n/, ''))).toThrow(/delivery/);
  const permissions = JSON.parse(readFileSync('infra/docker/m18-permissions.json', 'utf8'));
  expect(permissions['fs.read']['infra/docker/native-authoring.md']).toBe('allow');
  expect(permissions['fs.read']['*']).toBe('deny');
});
