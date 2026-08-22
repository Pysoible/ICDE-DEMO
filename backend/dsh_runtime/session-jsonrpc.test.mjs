import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionJsonRpcServer } from './session-jsonrpc.mjs';

function fixture({ resumeError } = {}) {
  const calls = [];
  const session = { id: 's1', seq: 4, header: { meta: { cwd: process.cwd() } }, events: [] };
  const agent = {
    id: 's1', session, status: 'idle',
    cancel(cause, options) { calls.push(['cancel', cause, options]); },
    async whenIdle() { calls.push(['idle']); },
  };
  const handle = { agent, async dispose() { calls.push(['dispose']); } };
  const ctx = {
    on() { return () => {}; },
    agents: {
      get() { return agent; },
      async create() { calls.push(['create']); return handle; },
      async resume() {
        calls.push(['resume']);
        if (resumeError) throw resumeError;
        return handle;
      },
    },
    sessions: { async flush() { calls.push(['flush']); } },
    subagents: { async drainContinuableDescendants() { calls.push(['drain']); } },
    get(name) { return name === 'subagents' ? this.subagents : undefined; },
  };
  const transport = { notify() {} };
  const server = new SessionJsonRpcServer(ctx, transport);
  server.cwd = process.cwd();
  return { server, calls };
}

test('session/open explicitly resumes a persisted identity', async () => {
  const { server, calls } = fixture();
  const result = await server.open({ sessionId: 's1', mode: 'resume' });
  assert.equal(result.source, 'resumed');
  assert.deepEqual(calls, [['resume']]);
});

test('recovery resumes first and creates the same identity only when DSH reports absence', async () => {
  const { server, calls } = fixture({ resumeError: new Error('session "s1" not found') });
  const result = await server.open({ sessionId: 's1', mode: 'recover' });
  assert.equal(result.source, 'created');
  assert.deepEqual(calls, [['resume'], ['create']]);
});

test('recovery never hides persistence corruption behind create', async () => {
  const { server, calls } = fixture({ resumeError: new Error('stored session "s1" failed validation') });
  await assert.rejects(server.open({ sessionId: 's1', mode: 'recover' }), /failed validation/);
  assert.deepEqual(calls, [['resume']]);
});

test('pause waits for idle, drains descendants, then flushes', async () => {
  const { server, calls } = fixture();
  await server.open({ sessionId: 's1', mode: 'create' });
  calls.length = 0;
  const result = await server.pause({ sessionId: 's1' });
  assert.equal(result.checkpointSeq, 3);
  assert.deepEqual(calls.map((call) => call[0]), ['cancel', 'idle', 'drain', 'flush']);
});

test('checkpoint rejects a running agent', async () => {
  const { server } = fixture();
  await server.open({ sessionId: 's1', mode: 'create' });
  server.sessions.get('s1').handle.agent.status = 'running';
  await assert.rejects(server.checkpoint({ sessionId: 's1' }), /running session/);
});
