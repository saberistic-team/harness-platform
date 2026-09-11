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

export function runCheck(args) {
  let argv;
  try { argv = checkArguments(args); }
  catch (error) { console.error(error.message); return 2; }
  const result = spawnSync(process.execPath, argv, {
    cwd: '/workspace', shell: false, timeout: 25000, maxBuffer: 48 * 1024,
    encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) console.error(`NATIVE_CHECK_FAILED: ${result.error.code ?? result.error.message}`);
  return result.status ?? 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCheck(process.argv.slice(2));
}
