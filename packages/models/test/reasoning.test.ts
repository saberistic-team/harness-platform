import { expect, it } from 'vitest';
import { OpenAICompatibleModel, MAX_MODEL_REASONING_CHARS, estimateTokens, type ChatMessage } from '../src';

const response = (reasoning: unknown, usage = true) => ({
  id: 'response-1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'answer', reasoning } }],
  ...(usage ? { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } : {}),
});
function fixture(raw: unknown, options = {}) {
  const requests: any[] = [];
  const model = new OpenAICompatibleModel({ baseUrl: 'https://provider.test/v1', model: 'fixture',
    fetch: async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify(raw)); }, ...options });
  return { model, requests };
}
it('preserves Ollama reasoning separately from answer text and returns it in assistant history', async () => {
  const { model, requests } = fixture(response('provider continuation'));
  const result = await model.complete({ messages: [{ role: 'user', content: 'start' }] });
  expect(result).toMatchObject({ content: 'answer', reasoning: 'provider continuation' });
  for (const toolCalls of [undefined, [], [{ id: 'call-1', name: 'echo', arguments: {} }]]) {
    await model.complete({ messages: [{ role: 'assistant', content: '', reasoning: result.reasoning, toolCalls }] });
    expect(requests.at(-1).messages[0]).toMatchObject({ reasoning: 'provider continuation' });
  }
});
it.each([null, 42, {}, 'x'.repeat(MAX_MODEL_REASONING_CHARS + 1)])('rejects malformed or oversized provider reasoning (%#)', async reasoning => {
  await expect(fixture(response(reasoning)).model.complete({ messages: [] })).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
});
it('rejects malformed historical reasoning before transport, including accessors', async () => {
  for (const reasoning of [null, 42, 'x'.repeat(MAX_MODEL_REASONING_CHARS + 1)]) {
    const { model, requests } = fixture(response('ok'));
    await expect(model.complete({ messages: [{ role: 'assistant', content: '', reasoning } as ChatMessage] })).rejects.toMatchObject({ code: 'MODEL_INVALID_REQUEST' });
    expect(requests).toHaveLength(0);
  }
  let invoked = false;
  const message = { role: 'assistant', content: '', get reasoning() { invoked = true; return 'unsafe'; } } as ChatMessage;
  await expect(fixture(response('ok')).model.complete({ messages: [message] })).rejects.toMatchObject({ code: 'MODEL_INVALID_REQUEST' });
  expect(invoked).toBe(false);
});
it('charges reasoning to estimated usage and request byte limits', async () => {
  const { model } = fixture(response('r'.repeat(800), false));
  const result = await model.complete({ messages: [] });
  expect(result.usage.completionTokens).toBe(estimateTokens('answer\n' + 'r'.repeat(800)));
  const bounded = fixture(response('ok'), { maxRequestBytes: 512 });
  await expect(bounded.model.complete({ messages: [{ role: 'assistant', content: '', reasoning: 'r'.repeat(1024) }] })).rejects.toMatchObject({ code: 'MODEL_INVALID_REQUEST' });
  expect(bounded.requests).toHaveLength(0);
});
it('leaves completions without reasoning unchanged', async () => {
  const { model, requests } = fixture(response(undefined));
  const result = await model.complete({ messages: [{ role: 'assistant', content: 'previous' }] });
  expect(result).not.toHaveProperty('reasoning');
  expect(requests[0].messages[0]).toEqual({ role: 'assistant', content: 'previous' });
});
