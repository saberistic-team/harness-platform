import { describe, expect, it } from 'vitest';
// @ts-expect-error Reviewed standalone image helper has no TypeScript declaration.
import { checkArguments } from '../../../infra/docker/native-check.mjs';

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
    expect((await check('apps/cli/test/missing.test.ts')).exitCode).not.toBe(0);
  } finally { await workspace?.dispose(); rmSync(root, { recursive: true, force: true }); }
}, 90000);
