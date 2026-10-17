import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// Curated Doubao / Seed model IDs on Volcano Ark. Inference endpoint IDs (ep-…)
// and newer model IDs can be typed into the custom model field in settings.
export const doubaoModels = [
  { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6 (vision + tools)' },
  { id: 'doubao-seed-1-6-thinking-250615', name: 'Doubao Seed 1.6 Thinking' },
  { id: 'doubao-1-5-pro-32k-250115', name: 'Doubao 1.5 Pro 32k' },
  { id: 'doubao-1-5-pro-256k-250115', name: 'Doubao 1.5 Pro 256k' },
  { id: 'doubao-1-5-flash-32k-250115', name: 'Doubao 1.5 Flash 32k' },
  { id: 'doubao-1-5-thinking-pro-250615', name: 'Doubao 1.5 Thinking Pro' },
  { id: 'doubao-1-5-vision-pro-32k-250115', name: 'Doubao 1.5 Vision Pro 32k' },
];

const stripImages = messages => messages
  .map(m => Array.isArray(m.content) ? { ...m, content: m.content.filter(p => p.type !== 'image_url') } : m)
  .filter(m => typeof m.content === 'string' || m.content === null || (Array.isArray(m.content) && m.content.length));

/**
 * Native Doubao teammate. Speaks the Volcano Ark OpenAI-compatible API
 * (chat completions + function calling) and drives the local lolpingyourai
 * MCP bridge so the teammate can read context, capture fresh screenshots and
 * operate the pinged window. The API key is never shipped in this file; it is
 * read from DOUBAO_API_KEY / ARK_API_KEY, from the app config, or from
 * doubao-key.txt in the data directory.
 */
export class DoubaoAdapter extends EventEmitter {
  constructor({ cwd, mcp, skillPath, apiKey = '', baseURL = '', store, env = {} }) {
    super();
    Object.assign(this, { cwd, mcp, skillPath, apiKey, store, env });
    this.baseURL = (baseURL || process.env.DOUBAO_BASE_URL || process.env.ARK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.active = new Map();       // session id -> in-flight record
    this.history = new Map();      // session id -> persisted message list
    this.pending = new Map();      // MCP jsonrpc id -> {resolve,reject,timer}
    this.nextId = 1;
    this.ready = null;
    this.closing = false;
    this.historyLoaded = false;
    this.selection = {};
    this.effort = 0;
    this.effectiveEffort = undefined;
    this.effectiveModel = undefined;
    this.effectiveFastMode = false;
    this.observedModel = undefined;
    this.settingsAcknowledged = false;
  }

  // ---- credentials ----
  async key() {
    if (this.apiKey) return this.apiKey;
    if (process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY) return process.env.DOUBAO_API_KEY || process.env.ARK_API_KEY;
    if (this.store) { try { const config = await this.store.read('ai-config', {}); if (config?.doubaoApiKey) return config.doubaoApiKey; } catch { /* keep looking */ } }
    if (this.cwd) { try { const first = (await readFile(join(this.cwd, 'doubao-key.txt'), 'utf8')).split('\n')[0].trim(); if (first) return first; } catch { /* absent file is fine */ } }
    return '';
  }

  // ---- local MCP bridge (stdio JSON-RPC) ----
  connect() { return this.ready ??= this.startMcp().catch(error => { this.ready = null; throw error; }); }
  async startMcp() {
    this.closing = false;
    const child = this.child = spawn(this.mcp.command, this.mcp.args, { env: { ...process.env, ...this.mcp.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    child.stderr.on('data', data => this.emit('diagnostic', data.toString().slice(0, 2000)));
    child.stdin.on('error', () => {});
    const failed = error => {
      if (this.child !== child) return; this.child = null; this.ready = null;
      if (!this.closing) this.emit('failure', error);
    };
    child.on('error', failed); child.on('exit', () => failed(new Error('Doubao bridge exited')));
    createInterface({ input: child.stdout }).on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    });
    await this.rpc('initialize', {}, 15000);
  }
  rpc(method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Doubao bridge is not connected'));
      const id = this.nextId++, timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Doubao bridge ${method} timed out`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async toolDefinitions() { await this.connect(); const result = await this.rpc('tools/list', {}); return result?.tools ?? []; }
  async callTool(name, args) { await this.connect(); return this.rpc('tools/call', { name, arguments: args ?? {} }); }

  // ---- adapter surface used by Teammate ----
  async capabilities() {
    return { images: true, steer: 'after-current-turn', interrupt: true, desktop: 'project-mcp', protocol: 'HTTP · OpenAI-compatible', agent: { name: 'doubao', version: '0.1.0' } };
  }
  async create() { await this.loadHistory(); const id = randomUUID(); if (!this.history.has(id)) this.history.set(id, []); return id; }
  async resume(id) { await this.loadHistory(); if (!this.history.has(id)) this.history.set(id, []); return id; }
  async listModels({ refresh = false } = {}) {
    const models = doubaoModels.map(m => ({ ...m, fastMode: false }));
    const key = await this.key();
    if (refresh && key) {
      try {
        const response = await fetch(`${this.baseURL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
        if (response.ok) {
          const data = await response.json();
          for (const model of data?.data ?? []) if (model?.id && !models.some(m => m.id === model.id)) models.push({ id: model.id, name: model.name ?? model.id, fastMode: false });
        }
      } catch { /* curated list stays when the account endpoint is unreachable */ }
    }
    return { models, defaultModel: models[0]?.id };
  }
  respond() { /* Doubao asks no native permission requests; approvals are handled by the bridge call results */ }

  async send(id, prompt, image, options = {}) {
    if (this.active.has(id)) throw new Error('Doubao turn is still active');
    const key = await this.key();
    if (!key) throw new Error('Doubao API key is not configured. Set ARK_API_KEY or DOUBAO_API_KEY, or save a key in teammate settings.');
    this.selection = { model: '', fastMode: false, ...this.selection, ...options };
    this.effort = options.reasoningEffort ?? this.effort;
    if (this.selection.fastMode) throw new Error('Doubao does not expose a fast-mode control');
    const skill = await readFile(this.skillPath, 'utf8');
    const record = { cancelled: false, followups: [], aborted: null };
    this.active.set(id, record);
    this.effectiveModel = this.selection.model || doubaoModels[0].id;
    this.effectiveFastMode = false;
    this.settingsAcknowledged = true;
    record.finished = (async () => {
      let status = 'completed';
      const turn = [{ role: 'system', content: skill }, ...(this.history.get(id) ?? [])];
      const userContent = [{ type: 'text', text: prompt }];
      if (image) userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${(await readFile(image)).toString('base64')}` } });
      turn.push({ role: 'user', content: userContent });
      try {
        for (;;) {
          if (record.cancelled) { status = 'interrupted'; break; }
          let tools = [];
          try { tools = (await this.toolDefinitions()).filter(t => t?.name).map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } })); }
          catch { /* text-only fallback when the local bridge is unavailable */ }
          record.aborted = new AbortController();
          let response;
          try {
            response = await fetch(`${this.baseURL}/chat/completions`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: this.effectiveModel, messages: turn, stream: true, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }),
              signal: record.aborted.signal,
            });
          } catch (error) { if (record.cancelled) { status = 'interrupted'; break; } throw error; }
          if (!response.ok) { let detail = ''; try { detail = (await response.text()).slice(0, 300); } catch { /* no body */ } throw new Error(`Doubao API ${response.status}${detail ? `: ${detail}` : ''}`); }
          const { text, calls, images, model } = await this.readStream(response, id, record);
          if (model) this.observedModel = model;
          if (record.cancelled) { status = 'interrupted'; break; }
          const assistant = { role: 'assistant', content: text || null };
          if (calls.length) assistant.tool_calls = calls;
          turn.push(assistant);
          if (calls.length) {
            this.emit('event', { method: 'dsh/update', params: { sessionId: id, update: { sessionUpdate: 'tool_use', toolNames: calls.map(c => c.function.name) } } });
            for (const call of calls) {
              let content;
              try {
                const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
                const result = await this.callTool(call.function.name, args);
                content = this.toolText(result);
                for (const source of this.toolImages(result)) images.push(source);
              } catch (error) { content = `Error: ${error.message}`; }
              turn.push({ role: 'tool', tool_call_id: call.id, content });
            }
            if (images.length) turn.push({ role: 'user', content: [{ type: 'text', text: 'The tool call above captured the following image(s). Treat them as the current visual state.' }, ...images.map(source => ({ type: 'image_url', image_url: { url: source } }))] });
            continue;
          }
          if (record.followups.length) { turn.push({ role: 'user', content: [{ type: 'text', text: record.followups.splice(0).join('\n\n') }] }); continue; }
          break;
        }
        if (!record.cancelled) { this.history.set(id, stripImages(turn).slice(-40)); await this.persist(); }
      } catch (error) { status = record.cancelled ? 'interrupted' : 'failed'; if (!record.cancelled) this.emit('failure', error); }
      finally { this.active.delete(id); this.emit('completed', { threadId: id, turn: { id, status: record.cancelled ? 'interrupted' : status } }); }
    })();
    return id;
  }
  async readStream(response, id, record) {
    const decoder = new TextDecoder(); let buffer = '';
    let text = '', model, finishReason;
    const byIndex = new Map(), images = [];
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trimEnd(); buffer = buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') { finishReason ??= 'stop'; continue; }
        let event; try { event = JSON.parse(payload); } catch { continue; }
        if (event.model && !model) model = event.model;
        const choice = event.choices?.[0];
        if (choice?.delta?.content) {
          text += choice.delta.content;
          this.emit('event', { method: 'dsh/message', params: { threadId: id, type: 'assistant', message: { content: [{ type: 'text', text: choice.delta.content }] } } });
        }
        if (choice?.delta?.tool_calls) for (const call of choice.delta.tool_calls) {
          const slot = byIndex.get(call.index) ?? { id: call.id ?? '', name: '', arguments: '' };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.arguments += call.function.arguments;
          byIndex.set(call.index, slot);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      }
      if (record.cancelled) break;
    }
    const calls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } }));
    return { text, calls, images, model, reason: finishReason ?? 'stop' };
  }
  toolText(result) {
    const content = result?.content;
    if (!Array.isArray(content)) return typeof result === 'string' ? result : JSON.stringify(result);
    const texts = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const imageCount = content.filter(c => c.type === 'image').length;
    return texts + (imageCount ? `\n[${imageCount} screenshot image(s) captured — attached as the next user message]` : '');
  }
  toolImages(result) {
    const content = result?.content;
    if (!Array.isArray(content)) return [];
    return content.filter(c => c.type === 'image' && c.data).map(c => `data:${c.mimeType ?? 'image/png'};base64,${c.data}`);
  }
  async steer(id, text, image) {
    const record = this.active.get(id);
    if (!record) return this.send(id, text, image);
    if (image) throw new Error('Doubao cannot steer images during a turn');
    record.followups.push(text);
    return id;
  }
  async cancel(id) {
    const record = this.active.get(id); if (!record) return;
    record.cancelled = true; record.followups.length = 0;
    record.aborted?.abort();
    let timer;
    try { await Promise.race([record.finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Doubao has not confirmed cancellation')), 15000); })]); }
    finally { clearTimeout(timer); }
  }
  async close() {
    this.closing = true; const child = this.child; if (!child) return;
    await new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
  }

  // ---- session continuity ----
  async loadHistory() {
    if (this.historyLoaded) return; this.historyLoaded = true;
    if (!this.cwd) return;
    try { const data = JSON.parse(await readFile(join(this.cwd, 'doubao-sessions.json'), 'utf8')); for (const [id, messages] of Object.entries(data.sessions ?? {})) if (Array.isArray(messages)) this.history.set(id, messages); }
    catch { /* no prior sessions yet */ }
  }
  async persist() {
    if (!this.cwd) return;
    try {
      await mkdir(this.cwd, { recursive: true });
      const sessions = Object.fromEntries([...this.history.entries()].map(([id, messages]) => [id, stripImages(messages)]).filter(([, messages]) => messages.length));
      await writeFile(join(this.cwd, 'doubao-sessions.json'), JSON.stringify({ sessions }), { mode: 0o600 });
    } catch { /* persistence is best-effort */ }
  }
}
