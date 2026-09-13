import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { OpenAICompatibleModel, CompleteModelAdapter, MAX_MODEL_REASONING_CHARS } from '@harness/models';
import { createBoundedTool, ToolRegistry } from '@harness/tools';
import { openSqliteStore, SessionEventStore } from '../../sessions/src';
import { MinimalAgentRuntime, type AgentEvent, type EventStore } from '../src';
import { createMessageState, buildModelContext } from '../src/state';
import { contextOccupancy } from '../src/context';
const drain = async (stream: AsyncIterable<AgentEvent>) => { const events: AgentEvent[] = []; for await (const event of stream) events.push(event); return events; };

it('keeps provider reasoning after SQLite reopen without repeating a completed tool', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reasoning-restart-'));
  let time = '2026-01-01T00:00:00Z';
  const path = join(root, 'session.db');
  let store = openSqliteStore(path, { now: () => time });
  let effects = 0, requests = 0, dead = false;
  const reasoning = 'opaque provider continuation fixture';
  const tools = new ToolRegistry([createBoundedTool({ name: 'effect', description: 'counter', parameters: z.object({}), inputSchema: { type: 'object' }, execute: () => ({ count: ++effects }) }, { kind: 'pure' })]);
  const model = (first: boolean) => new CompleteModelAdapter(new OpenAICompatibleModel({ baseUrl: 'https://provider.test/v1', model: 'fixture', fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!first) {
      expect(body.messages.find((m: any) => m.role === 'assistant')).toMatchObject({ reasoning, content: null });
      expect(body.messages.at(-1)).toMatchObject({ role: 'tool' });
    }
    return new Response(JSON.stringify({ id: first ? 'one' : 'two', choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: { role: 'assistant', content: first ? '' : 'done', ...(first ? { reasoning, tool_calls: [{ id: 'call-one', type: 'function', function: { name: body.tools[0].function.name, arguments: '{}' } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  } }));
  try {
    await store.createSession({ sessionId: 's', metadata: { ownerId: 'old', leaseExpiresAt: '2026-01-01T00:00:01Z' } });
    const original = new SessionEventStore(store, 's', 'old');
    const crash: EventStore = { checkpointVersion: 1, readSession: original.readSession.bind(original), async append(e) {
      if (e.type === 'model.request' && ++requests === 2) dead = true;
      if (dead) throw Error('lost process at safe boundary');
      await original.append(e);
    } };
    const input = { runId: 'r', sessionId: 's', turnId: 't', input: 'work', model: 'fixture', tools };
    await expect(drain(new MinimalAgentRuntime().run({ ...input, modelAdapter: model(true), eventStore: crash }))).rejects.toThrow();
    expect(effects).toBe(1);
    store.close(); time = '2026-01-01T00:00:02Z'; store = openSqliteStore(path, { now: () => time });
    const recovered = new SessionEventStore(store, 's', 'new');
    await drain(await new MinimalAgentRuntime().continue({ ...input, modelAdapter: model(false), eventStore: recovered }));
    expect(effects).toBe(1);
    const events = await drain(recovered.readSession('s'));
    expect(events.filter(e => e.type === 'model.reasoning')).toMatchObject([{ data: { reasoning } }]);
    expect(events.filter(e => e.type === 'tool.call')).toHaveLength(1);
    expect(events.filter(e => e.type === 'runtime.continued')).toHaveLength(1);
    expect(events.filter(e => e.type === 'message.completed').every(e => !JSON.stringify(e.data).includes(reasoning))).toBe(true);
    expect(new Set(events.map(e => e.eventId)).size).toBe(events.length);
    expect(events.findLast(e => e.type === 'turn.completed')).toMatchObject({ data: { status: 'completed' } });
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
it('includes reasoning in immutable context accounting and rejects invalid restored state', () => {
  const plain = createMessageState([{ role: 'assistant', content: '' }]);
  const state = createMessageState([{ role: 'assistant', content: '', reasoning: 'x'.repeat(100) }]);
  expect(buildModelContext(state).messages[0]).toMatchObject({ reasoning: 'x'.repeat(100) });
  expect(contextOccupancy(state.messages, [])).toBeGreaterThan(contextOccupancy(plain.messages, []) + 100);
  for (const reasoning of [null, 42, 'x'.repeat(MAX_MODEL_REASONING_CHARS + 1)]) {
    expect(() => buildModelContext({ version: 1, revision: 1, messages: [{ role: 'assistant', content: '', reasoning }] } as any)).toThrow(/reasoning/);
  }
});

it.each([42, 'x'.repeat(MAX_MODEL_REASONING_CHARS + 1)])('rejects malformed model reasoning before publishing it (%#)', async reasoning => {
  const events: AgentEvent[] = [];
  const modelAdapter = { async *stream() { yield { type: 'response.completed' as const, response: { id: 'one', content: 'answer', reasoning, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } as any }; } };
  await expect(drain(new MinimalAgentRuntime().run({ runId: 'r', sessionId: 's', turnId: 't', input: 'work', model: 'fixture', modelAdapter, eventStore: { append: async event => { events.push(event); }, async *readSession() { yield* events; } } }))).rejects.toMatchObject({ code: 'RUNTIME_MODEL_STREAM_INVALID' });
  expect(events.some(e => e.type === 'model.reasoning')).toBe(false);
});
