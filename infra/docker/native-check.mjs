import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function checkArguments(args) {
  if (args.length !== 1 || !/^(?:apps|packages|services)\/[a-zA-Z0-9_-]+\/test\/[a-zA-Z0-9_/-]+\.test\.ts$/.test(args[0])) {
    throw new Error('NATIVE_CHECK_TARGET: supply one repository test/*.test.ts path');
  }
  return ['/node_modules/vitest/vitest.mjs', 'run', args[0],
    '--config', '/opt/harness/native-check.config.mjs', '--configLoader=native', '--maxWorkers=1',
    '--no-file-parallelism', '--passWithNoTests=false'];
}

/** Test and compiler feedback share one deadline and aggregate output budget. */
export function runCheck(args, { spawn = spawnSync, now = Date.now,
  out = text => process.stdout.write(text), err = text => process.stderr.write(text) } = {}) {
  let testArgv;
  try { testArgv = checkArguments(args); }
  catch (error) { err(`${error.message}\n`); return 2; }
  const deadline = now() + 25000;
  let remainingBytes = 96 * 1024;
  const emit = (write, text) => {
    const bytes = Buffer.from(text ?? '');
    write(bytes.subarray(0, remainingBytes).toString('utf8'));
    remainingBytes -= Math.min(bytes.length, remainingBytes);
  };
  const temporary = mkdtempSync(join(tmpdir(), 'harness-typecheck-'));
  const config = join(temporary, 'tsconfig.json');
  try {
  writeFileSync(config, JSON.stringify({ extends: '/workspace/tsconfig.json',
    files: ['/workspace/' + args[0]], include: [], exclude: [],
    compilerOptions: { noEmit: true, incremental: false } }));
  for (const [stage, argv] of [
    ['tests', testArgv],
    ['typecheck', ['/node_modules/typescript/bin/tsc', '-p', config,
      '--noEmit', '--incremental', 'false', '--pretty', 'false']],
  ]) {
    emit(out, `NATIVE_CHECK_STAGE: ${stage}\n`);
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || remainingBytes < 1024) {
      emit(err, 'NATIVE_CHECK_FAILED: shared time or output budget exhausted\n');
      return 1;
    }
    const result = spawn(process.execPath, argv, {
      cwd: '/workspace', shell: false, timeout: remainingMs,
      maxBuffer: Math.floor(remainingBytes / 2),
      encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    emit(out, result.stdout);
    emit(err, result.stderr);
    if (result.error) emit(err, `NATIVE_CHECK_FAILED: ${result.error.code ?? result.error.message}\n`);
    if (result.error || result.status !== 0) return result.status || 1;
  }
  return 0;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCheck(process.argv.slice(2));
}
