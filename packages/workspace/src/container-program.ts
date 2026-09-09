/** Reviewed Node 22+ bootstrap passed as one argv item, never through a shell.
 * Only /workspace is exported. Docker owns the process, mount and resource boundary.
 */
export const CONTAINER_PROGRAM = String.raw`
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
(async () => {
  let input = '', size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw Error('input limit');
    input += chunk;
  }
  const request = JSON.parse(input);
  const { files, command, limits } = request;
  const safe = p => typeof p === 'string' && p.length && !p.startsWith('/') &&
    !/[\x00-\x1f\x7f\\]/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..' || s.toLowerCase() === '.git');
  for (const [p, data] of Object.entries(files)) {
    if (!safe(p) || typeof data !== 'string') throw Error('invalid input file');
    fs.mkdirSync(path.dirname('/workspace/' + p), { recursive: true, mode: 0o700 });
    fs.writeFileSync('/workspace/' + p, data, { flag: 'wx', mode: 0o600 });
  }
  let stdout = '', stderr = '', bytes = 0, exceeded = false, timedOut = false;
  const cwd = command.cwd === undefined || command.cwd === '.' ? '/workspace' : '/workspace/' + command.cwd;
  if (cwd !== '/workspace' && !safe(command.cwd)) throw Error('invalid cwd');
  const child = cp.spawn(command.argv[0], command.argv.slice(1), {
    cwd, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', TMPDIR: '/tmp' }
  });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const timer = setTimeout(() => { timedOut = true; kill(); }, command.timeoutMs);
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limits.outputBytes) { exceeded = true; kill(); return; }
      if (name === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    });
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code === null ? 124 : code));
  }).finally(() => { clearTimeout(timer); kill(); });
  if (exceeded) throw Error('output limit');
  const output = Object.create(null);
  let total = 0, entries = 0;
  const scan = directory => {
    for (const name of fs.readdirSync(directory)) {
      if (++entries > limits.files * 2) throw Error('entry limit');
      const absolute = directory + '/' + name, relative = absolute.slice('/workspace/'.length);
      if (!safe(relative)) throw Error('invalid output path');
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw Error('unsafe output link or type');
      if (stat.isDirectory()) { scan(absolute); continue; }
      if ((stat.mode & 0o111) !== 0) throw Error('unsupported executable mode');
      total += stat.size;
      if (stat.size > limits.fileBytes || total > limits.totalBytes || Object.keys(output).length >= limits.files) throw Error('file limit');
      const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || !opened.isFile()) throw Error('file changed');
        const data = Buffer.alloc(limits.fileBytes + 1);
        let bytes = 0, count;
        do { count = fs.readSync(fd, data, bytes, data.length - bytes, null); bytes += count; } while (count && bytes < data.length);
        if (bytes > limits.fileBytes) throw Error('read limit');
        output[relative] = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytes));
      } finally { fs.closeSync(fd); }
    }
  };
  scan('/workspace');
  process.stdout.write(JSON.stringify({ version: 1, files: output, result: { exitCode, stdout, stderr, timedOut } }));
})().catch(() => { process.stderr.write('workspace container operation failed'); process.exitCode = 1; });
`;
