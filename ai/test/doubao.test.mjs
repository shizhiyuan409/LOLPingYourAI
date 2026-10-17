import test from 'node:test';
import assert from 'node:assert/strict';
import { DoubaoAdapter, doubaoModels, DEFAULT_BASE_URL } from '../harness/doubao.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const skillPath = fileURLToPath(new URL('../../skills/lolping-your-ai/SKILL.md', import.meta.url));
const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const sse = events => 'data: ' + events.map(e => JSON.stringify(e)).join('\ndata: ') + '\ndata: [DONE]\n\n';
const delta = (content, extra = {}) => ({ choices: [{ delta: { role: 'assistant', content }, ...extra }, { delta: {}, finish_reason: null }] });

function fixture(overrides = {}) {
  const calls = [];
  const a = new DoubaoAdapter({ cwd: '/tmp/fixture', skillPath, mcp: { command: process.execPath, args: [], env: {} }, apiKey: 'test-key', ...overrides });
  a.connect = async () => {};
  a.persist = async () => {};
  a.toolDefinitions = async () => [{ name: 'get_context', description: 'Read context', inputSchema: { type: 'object', properties: {}, required: [] } }];
  a.callTool = async (name, args) => { calls.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }; };
  return { a, calls };
}

test('Doubao resolves the API key from the constructor, env, config store and key file, in that order', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.ARK_API_KEY; delete process.env.DOUBAO_API_KEY;
    const store = { read: async () => ({ doubaoApiKey: 'stored-key' }) };
    const a = new DoubaoAdapter({ cwd: '/tmp', skillPath, mcp: {}, apiKey: '', store });
    assert.equal(await a.key(), 'stored-key');
    process.env.ARK_API_KEY = 'env-key';
    assert.equal(await a.key(), 'env-key');
    process.env.DOUBAO_API_KEY = 'env-key-2';
    assert.equal(await a.key(), 'env-key-2');
    delete process.env.ARK_API_KEY; delete process.env.DOUBAO_API_KEY;
    const dir = await mkdtemp(join(tmpdir(), 'doubao-key-'));
    await writeFile(join(dir, 'doubao-key.txt'), 'file-key\nignored\n');
    const b = new DoubaoAdapter({ cwd: dir, skillPath, mcp: {}, apiKey: '', store: { read: async () => ({}) } });
    assert.equal(await b.key(), 'file-key');
    await rm(dir, { recursive: true, force: true });
  } finally { Object.assign(process.env, saved); }
});

test('Doubao refuses to send before an API key is configured', async () => {
  const saved = { ...process.env };
  try {
    delete process.env.DOUBAO_API_KEY; delete process.env.ARK_API_KEY;
    const a = new DoubaoAdapter({ cwd: '/tmp', skillPath, mcp: {}, apiKey: '', store: { read: async () => ({}) } });
    a.persist = async () => {};
    const id = await a.create();
    await assert.rejects(a.send(id, 'Hi'), /API key is not configured/);
    assert.equal(a.active.size, 0);
  } finally { Object.assign(process.env, saved); }
});

test('Doubao streams text deltas as teammate events and completes', async () => {
  const { a } = fixture();
  let body, url;
  globalThis.fetch = async (u, init) => {
    url = u; body = JSON.parse(init.body);
    return new Response(sse([delta('Hello '), delta('there'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 });
  };
  const texts = [];
  a.on('event', e => { if (e.method === 'dsh/message') texts.push(e.params.message.content[0].text); });
  let completed;
  a.on('completed', p => { completed = p; });
  const id = await a.create();
  await a.send(id, 'Hi', undefined, { model: 'doubao-1-5-flash-32k-250115' });
  await a.active.get(id).finished;
  assert.equal(url, `${DEFAULT_BASE_URL}/chat/completions`);
  assert.deepEqual(texts, ['Hello ', 'there']);
  assert.equal(completed.turn.status, 'completed');
  assert.equal(body.model, 'doubao-1-5-flash-32k-250115');
  assert.equal(a.effectiveModel, 'doubao-1-5-flash-32k-250115');
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages.at(-1).content[0].text, /Hi/);
  assert.equal(a.history.get(id).at(-1).role, 'assistant');
});

test('Doubao sends the pinged screenshot as a vision image_url and keeps it out of history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doubao-image-'));
  const imagePath = join(dir, 'shot.png');
  await writeFile(imagePath, png1x1);
  const { a } = fixture();
  let body;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }); };
  const id = await a.create();
  await a.send(id, 'Look', imagePath);
  await a.active.get(id).finished;
  const user = body.messages.at(-1);
  assert.equal(user.content[0].type, 'text');
  assert.equal(user.content[1].type, 'image_url');
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(a.history.get(id).some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')), false);
  await rm(dir, { recursive: true, force: true });
});

test('Doubao executes MCP tool calls in a loop and feeds results back to the model', async () => {
  const { a, calls } = fixture();
  let step = 0;
  const toolCallEvent = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_context', arguments: '{"contextId":"c"}' } }] } }] };
  const toolFinishEvent = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  globalThis.fetch = async () => {
    step++;
    if (step === 1) return new Response(sse([toolCallEvent, toolFinishEvent]), { status: 200 });
    return new Response(sse([delta('The context is loaded.'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 });
  };
  const texts = [];
  a.on('event', e => { if (e.method === 'dsh/message') texts.push(e.params.message.content[0].text); });
  const id = await a.create();
  await a.send(id, 'Work');
  await a.active.get(id).finished;
  assert.deepEqual(calls, [{ name: 'get_context', args: { contextId: 'c' } }]);
  assert.deepEqual(texts, ['The context is loaded.']);
  const history = a.history.get(id);
  assert.equal(history.some(m => m.role === 'tool' && m.tool_call_id === 'call_1'), true);
  assert.equal(history.some(m => m.role === 'assistant' && m.tool_calls?.length), true);
});

test('Doubao cancellation interrupts an in-flight request without a failure event', async () => {
  const { a } = fixture();
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
  let completed; const failures = [];
  a.on('completed', p => { completed = p; });
  a.on('failure', e => failures.push(e));
  const id = await a.create();
  await a.send(id, 'Work');
  await a.cancel(id);
  assert.equal(completed.turn.status, 'interrupted');
  assert.equal(a.active.size, 0);
  assert.equal(failures.length, 0);
});

test('Doubao queues steering follow-ups into the active turn and rejects image steering', async () => {
  const { a } = fixture();
  let step = 0, releaseFirst;
  globalThis.fetch = async () => {
    step++;
    if (step === 1) return new Promise(resolve => { releaseFirst = () => resolve(new Response(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 })); });
    return new Response(sse([delta('Follow-up answered.'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 });
  };
  const id = await a.create();
  const sending = a.send(id, 'Work');
  await new Promise(r => setTimeout(r, 10)); // let the first request start
  await assert.rejects(a.steer(id, 'Look', '/tmp/x.png'), /cannot steer images/);
  await a.steer(id, 'Nice');
  releaseFirst();
  await sending;
  await a.active.get(id).finished;
  const history = a.history.get(id);
  assert.equal(history.some(m => m.role === 'user' && /Nice/.test(m.content[0].text)), true);
  assert.equal(history.some(m => m.role === 'assistant' && /Follow-up answered/.test(m.content)), true);
});

test('Doubao lists curated models without a key and merges account endpoints on refresh', async () => {
  const { a } = fixture();
  const curated = await a.listModels();
  assert.equal(curated.defaultModel, doubaoModels[0].id);
  assert.ok(curated.models.length >= doubaoModels.length);
  let called = false;
  globalThis.fetch = async url => {
    if (url.endsWith('/models')) { called = true; return new Response(JSON.stringify({ data: [{ id: 'ep-20261018-abcde', name: 'My endpoint' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    throw new Error(`Unexpected URL ${url}`);
  };
  const merged = await a.listModels({ refresh: true });
  assert.equal(called, true);
  assert.ok(merged.models.some(m => m.id === 'ep-20261018-abcde'));
  assert.equal(merged.models.every(m => m.fastMode === false), true);
});

test('Doubao persists text history to disk and reloads it for a resumed session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doubao-session-'));
  try {
    const a = new DoubaoAdapter({ cwd: dir, skillPath, mcp: {}, apiKey: 'k', store: { read: async () => ({}) } });
    a.connect = async () => {};
    a.toolDefinitions = async () => [];
    globalThis.fetch = async () => new Response(sse([delta('Persisted.'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 });
    const id = await a.create();
    await a.send(id, 'Hi');
    await a.active.get(id).finished;
    const file = join(dir, 'doubao-sessions.json');
    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(onDisk.sessions[id].some(m => m.role === 'assistant'));
    const b = new DoubaoAdapter({ cwd: dir, skillPath, mcp: {}, apiKey: 'k', store: { read: async () => ({}) } });
    await b.resume(id);
    assert.equal(b.history.get(id).at(-1).role, 'assistant');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
