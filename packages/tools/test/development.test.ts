import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentTools } from '../src/development';
import { compileRules } from '../../policy/src';
import permissions from '../../../infra/docker/m18-permissions.json';
import { MinimalAgentRuntime, type AgentEvent } from '../../kernel/src';
import { FakeModel } from '../../models/src';
import { LocalWorkspace } from '../../workspace/src';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('explains and validates relative process cwd before execution', () => {
  const tool = createDevelopmentTools('/reviewed/root').get('process.exec')!;
  expect(tool.description).toContain('never use /workspace');
  expect(() => tool.parameters.parse({ argv: ['node'], cwd: '/workspace' })).toThrow('workspace-relative');
  expect(tool.parameters.parse({ argv: ['node'] })).toEqual({ argv: ['node'] });
  expect(tool.parameters.parse({ argv: ['node'], cwd: '.' })).toEqual({ argv: ['node'], cwd: '.' });
});

describe('M18 enforced policy', () => {
  const rules = compileRules(permissions as Parameters<typeof compileRules>[0]);
  it('allows diagnostic reads and only the fixed check or trusted full test command', () => {
    expect(rules.decide('fs.read', 'apps/cli/src/main.ts').effect).toBe('allow');
    expect(rules.decide('process.exec', 'node /opt/harness/native-check.mjs apps/cli/test/doctor.test.ts').effect).toBe('allow');
    expect(rules.decide('process.exec', 'pnpm test').effect).toBe('allow');
  });
  it.each(['apps/cli/src/run.ts', 'apps/cli/src/git.ts', 'apps/cli/test/run.test.ts',
    'packages/kernel/src/runtime.ts', 'apps/cli/src/../src/git.ts'])('denies unrelated read %s', path => {
      expect(rules.decide('fs.read', path).effect).toBe('deny');
    });
  it.each(['node -e console.log(1)', 'node infra/docker/native-check.mjs apps/cli/test/doctor.test.ts',
    'node /opt/harness/native-check.mjs apps/cli/test/doctor.test.ts --help', 'pnpm test --update'])('denies generic command %s', command => {
      expect(rules.decide('process.exec', command).effect).toBe('deny');
    });
  it('denies directory listing and diffs', () => {
    expect(rules.decide('fs.list', '.').effect).toBe('deny');
    expect(rules.decide('git.diff').effect).toBe('deny');
  });
  it('kernel blocks denied reads before touching the file or sending content to the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm18-policy-'));
    const workspace = new LocalWorkspace({ root, allowedPaths: ['**'], developerOnly: true });
    try {
      mkdirSync(join(root, 'apps/cli/src'), { recursive: true });
      writeFileSync(join(root, 'apps/cli/src/git.ts'), 'DENIED_CONTENT_SENTINEL');
      writeFileSync(join(root, 'apps/cli/src/main.ts'), 'allowed diagnostic entrypoint');
      const read = vi.spyOn(workspace, 'readFile');
      const model = new FakeModel([
        { toolCalls: [{ id: 'denied', name: 'fs.read', arguments: { path: 'apps/cli/src/git.ts' } }] },
        { toolCalls: [{ id: 'allowed', name: 'fs.read', arguments: { path: 'apps/cli/src/main.ts' } }] },
        { content: 'done' },
      ]);
      const events: AgentEvent[] = [];
      const eventStore = { async append(event: AgentEvent) { events.push(event); }, async *readSession() { yield* events; } };
      for await (const _ of new MinimalAgentRuntime().run({ runId: 'policy', sessionId: 'session', turnId: 'turn',
        input: 'read', model: 'fake', modelAdapter: model, eventStore, workspace,
        tools: createDevelopmentTools(root), permission: { decide: intent => rules.decide(intent.action, intent.subject) } })) { /* drain */ }
      expect(read.mock.calls).toEqual([['apps/cli/src/main.ts']]);
      expect(JSON.stringify(model.requests)).not.toContain('DENIED_CONTENT_SENTINEL');
      expect(events.some(event => event.type === 'policy.decision' && event.data.effect === 'deny')).toBe(true);
    } finally { await workspace.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
});
