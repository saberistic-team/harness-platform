import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export function buildContext(root, context) {
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (tracked.status !== 0) throw new Error('NATIVE_TEST_BUILD: cannot list tracked manifests');
  const manifests = tracked.stdout.split('\0').filter(p => /^(?:apps|packages|services)\/[^/]+\/package\.json$/.test(p) || p === 'evals/package.json');
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...manifests]) {
    mkdirSync(dirname(join(context, path)), { recursive: true });
    copyFileSync(join(root, path), join(context, path));
  }
  const links = manifests.map(path => ({ name: JSON.parse(readFileSync(join(root, path), 'utf8')).name, path: dirname(path) }));
  writeFileSync(join(context, 'link-workspaces.mjs'), `import {mkdirSync,rmSync,symlinkSync} from 'node:fs';\nimport {dirname} from 'node:path';\nfor(const item of ${JSON.stringify(links)}) { const dest='/node_modules/'+item.name; mkdirSync(dirname(dest),{recursive:true}); rmSync(dest,{recursive:true,force:true}); symlinkSync('/workspace/'+item.path,dest); }\n`);
  for (const name of ['native-test.Dockerfile', 'native-check.mjs', 'native-check.config.mjs']) {
    copyFileSync(join(root, 'infra/docker', name), join(context, name));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, tag] = process.argv.slice(2);
  if (process.argv.length !== 4 || !/^.+@sha256:[a-f0-9]{64}$/.test(base ?? '') || !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$/.test(tag ?? '')) {
    throw new Error('Usage: node infra/docker/build-native-test.mjs <node-alpine@sha256:digest> <local-tag>');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const context = mkdtempSync(join(tmpdir(), 'harness-native-test-build-'));
  try {
    buildContext(root, context);
    const result = spawnSync('docker', ['build', '--build-arg', `BASE_IMAGE=${base}`, '-f', join(context, 'native-test.Dockerfile'), '-t', tag, context], { stdio: 'inherit', shell: false });
    process.exitCode = result.status ?? 1;
  } finally { rmSync(context, { recursive: true, force: true }); }
}
