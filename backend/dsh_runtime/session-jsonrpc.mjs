import Schema from '@deepseek-ai/schemastery';
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol';
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server';
import { SessionId } from '@deepseek-ai/dsh-session';

export const name = 'ts-harness-session-jsonrpc';
export const inject = ['agents', 'sessions'];
export const Config = Schema.object({});

export class SessionJsonRpcServer extends HarnessSdkJsonRpcServer {
  pauseTasks = new Map();

  agentOptions() {
    return {
      provider: this.provider,
      model: this.model,
      ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
    };
  }

  async open(params) {
    if (this.shuttingDown) throw new Error('SDK server is shutting down');
    const sessionId = String(params.sessionId || '');
    if (!sessionId) throw new TypeError('session/open requires sessionId');
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return { sessionId, source: existing.source, lastSeq: existing.handle.agent.session.seq - 1 };
    }
    const pending = this.sessionCreations.get(sessionId);
    if (pending) {
      const rec = await pending;
      return { sessionId, source: rec.source, lastSeq: rec.handle.agent.session.seq - 1 };
    }
    const mode = String(params.mode || '');
    if (!['create', 'resume', 'recover'].includes(mode)) {
      throw new TypeError('session/open mode must be create, resume, or recover');
    }
    let source = mode === 'create' ? 'created' : 'resumed';
    const create = () => this.ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: this.cwd },
          agentOptions: this.agentOptions(),
        });
    const resume = () => this.ctx.agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions: this.agentOptions(),
        });
    const creation = mode === 'create'
      ? create()
      : mode === 'resume'
        ? resume()
        : resume().catch((error) => {
            // A crash can happen after the application reserves an identity
            // but before DSH materializes its log. Resume remains the first
            // operation; only DSH's precise absence result permits creating
            // that same identity. Corruption and I/O failures always surface.
            if (!(error instanceof Error) || error.message !== `session "${sessionId}" not found`) throw error;
            source = 'created';
            return create();
          });
    const recordTask = creation.then((handle) => {
      const storedCwd = handle.agent.session.header?.meta?.cwd ?? handle.agent.session.header?.cwd;
      if (source === 'resumed' && storedCwd !== undefined && storedCwd !== this.cwd) {
        return handle.dispose().then(() => {
          throw new Error(`session cwd mismatch: persisted=${storedCwd}, requested=${this.cwd}`);
        });
      }
      const rec = { handle, source };
      this.sessions.set(sessionId, rec);
      return rec;
    });
    this.sessionCreations.set(sessionId, recordTask);
    try {
      const rec = await recordTask;
      return { sessionId, source, lastSeq: rec.handle.agent.session.seq - 1 };
    } finally {
      this.sessionCreations.delete(sessionId);
    }
  }

  async getOrCreateSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`session ${sessionId} is not open`);
    return rec;
  }

  async checkpoint(params) {
    const rec = await this.getOrCreateSession(String(params.sessionId || ''));
    if (rec.handle.agent.status !== 'idle') throw new Error('cannot checkpoint a running session');
    await this.ctx.get('subagents')?.drainContinuableDescendants([rec.handle.agent]);
    await this.ctx.sessions.flush(rec.handle.agent.session);
    return {
      sessionId: String(rec.handle.agent.session.id),
      checkpointSeq: rec.handle.agent.session.seq - 1,
      turnEnd: rec.handle.agent.session.events.findLast((event) => event.type === 'turn/end') ?? null,
    };
  }

  async pause(params) {
    const sessionId = String(params.sessionId || '');
    const existing = this.pauseTasks.get(sessionId);
    if (existing) return existing;
    const task = (async () => {
      const rec = await this.getOrCreateSession(sessionId);
      rec.handle.agent.cancel({ kind: 'user' }, { keepInbox: false });
      await rec.handle.agent.whenIdle();
      await this.ctx.get('subagents')?.drainContinuableDescendants([rec.handle.agent]);
      await this.ctx.sessions.flush(rec.handle.agent.session);
      return {
        sessionId,
        checkpointSeq: rec.handle.agent.session.seq - 1,
        turnEnd: rec.handle.agent.session.events.findLast((event) => event.type === 'turn/end') ?? null,
      };
    })();
    this.pauseTasks.set(sessionId, task);
    try {
      return await task;
    } finally {
      this.pauseTasks.delete(sessionId);
    }
  }

  async handleRequest(method, params) {
    if (method === 'session/open') return this.open(params ?? {});
    if (method === 'session/checkpoint') return this.checkpoint(params ?? {});
    if (method === 'session/pause') return this.pause(params ?? {});
    return super.handleRequest(method, params);
  }
}

export function apply(ctx, config) {
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, config.output ?? process.stdout);
  const server = new SessionJsonRpcServer(ctx, transport);
  const rootFiber = ctx.root.fiber;
  const exit = config.exit ?? ((code) => process.exit(code));
  let exitTask;
  const disposeAndExit = () => {
    exitTask ??= (async () => {
      await Promise.allSettled([transport.flush()]);
      await Promise.allSettled([rootFiber.dispose()]);
      exit(0);
    })();
    return exitTask;
  };
  transport.onRequest(async (method, params) => {
    if (method === 'initialize') await ctx.get('loader')?.await();
    const result = await server.handleRequest(method, params);
    if (method === 'shutdown') setImmediate(disposeAndExit);
    return result;
  });
  ctx.effect(() => {
    transport.start();
    return async () => {
      await server.shutdown();
      transport.close();
    };
  }, 'ts-harness-jsonrpc.serve');
}
