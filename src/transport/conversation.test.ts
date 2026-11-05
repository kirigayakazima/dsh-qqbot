import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOutboundHandler } from './outbound.ts';
import { handleInbound } from './inbound.ts';
import type { SessionManager, SessionRecord } from '../session/index.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger } from '../types.ts';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { Context } from '@deepseek-ai/cordis';
// Exercise the real companion wrapper and real driver routing together, without QQ network.
// @ts-expect-error the companion's JS package is intentionally untyped at this cross-repo test boundary
import { apply } from '../../../lucidheart/packages/qq-plus/lib/index.js';

const logger = (): Logger => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() });
const record = (id = 's1'): SessionRecord => ({ sessionId: id, replyTarget: { scope: 'c2c', targetId: id, msgId: 'm1' } } as SessionRecord);
function setup() {
  const a = record(), b = record('s2'), log = logger();
  const sender = { sendMarkdown: vi.fn(async () => ({ ok: true })), openStream: vi.fn(() => { throw new Error('must buffer locally'); }) };
  const cleanups: Array<() => void> = [];
  apply({ qqbotSender: sender, get: () => undefined, effect: (fn: () => () => void) => cleanups.push(fn()), on() {} },
    { persona: 'xiaoman', ignoreLocalFile: true, split: { minChars: 1, targetChars: 100, maxSegments: 4, delayMs: 600 } });
  const manager = { findBySessionId: (id: string) => id === 's1' ? a : id === 's2' ? b : undefined } as SessionManager;
  const outbound = createOutboundHandler(manager, sender, { streaming: true, textChunkLimit: 4500 } as ImQQBotConfig, log);
  const route = (type: string, data = {}, id = 's1') => outbound.routeSessionEvent({ header: { id } }, { type, data });
  const message = (text: string, id = 's1') => route('assistant/message', { message: { content: [{ type: 'text', text }] } }, id);
  return { sender, outbound, route, message, log, a, b, dispose: () => { outbound.dispose(); cleanups.forEach(fn => fn()); } };
}

describe('conversation delivery across the driver and QQPlus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('cancel after first static bubble drops queued text and late events until a real new turn', async () => {
    const h = setup();
    // Keep the original transport mock; QQPlus replaces sender.sendMarkdown.
    h.route('turn/start'); h.message('第一句。\n\n第二句。');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1 });
    h.outbound.cancelSession('s1');
    h.message('迟到的旧回复。');
    h.outbound.routeStreamFrame('s1', { kind: 'text-delta', attemptId: 'late', text: '旧片段' });
    await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1 });
    h.route('turn/start'); h.message('新回合。');
    await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 2 });
    h.dispose();
  });

  it('native agent chunks enter semantic delivery; interruption during complete does not leak the second bubble', async () => {
    const h = setup(); h.route('turn/start');
    h.outbound.routeStreamFrame('s1', { kind: 'attempt-start', attemptId: '1' });
    h.outbound.routeStreamFrame('s1', { kind: 'text-delta', attemptId: '1', text: '一段。\n\n二段。' });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 0, semanticStreams: 1 });
    h.message('一段。\n\n二段。'); await vi.advanceTimersByTimeAsync(0);
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1 });
    h.route('turn/end', { reason: { kind: 'interrupted' } });
    await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1, activeStreams: 0 });
    h.dispose();
  });

  it('peer isolation and unload: cancelling one target preserves the other, disposal drains neither', async () => {
    const h = setup(); h.route('turn/start'); h.route('turn/start', {}, 's2');
    h.message('A一段。\n\nA二段。'); h.message('B一段。\n\nB二段。', 's2');
    await vi.advanceTimersByTimeAsync(0); h.outbound.cancelSession('s1');
    await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 3 });
    h.route('turn/start', {}, 's2'); h.message('C一段。\n\nC二段。', 's2');
    await vi.advanceTimersByTimeAsync(0); h.outbound.dispose(); await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 4 });
    h.dispose();
  });

  it('host turn rejects old attempts after a new turn; duplicate starts do not cancel current delivery', async () => {
    const h = setup(); h.route('turn/start', { turn: 1 }); h.outbound.cancelSession('s1');
    h.route('turn/start', { turn: 2 });
    h.outbound.routeStreamFrame('s1', { kind: 'attempt-start', attemptId: 'new', turn: 2, revision: 1 });
    h.outbound.routeStreamFrame('s1', { kind: 'text-delta', attemptId: 'new', turn: 2, revision: 2, text: '新的内容。' });
    h.outbound.routeStreamFrame('s1', { kind: 'attempt-start', attemptId: 'old', turn: 1, revision: 900 });
    h.route('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    h.route('turn/start', { turn: 2 });
    h.message('新的内容。'); await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1 });
    h.dispose();
  });

  it('a legitimate retry/replacement may reset revision within the same turn', async () => {
    const h = setup(); h.route('turn/start', { turn: 1 });
    h.outbound.routeStreamFrame('s1', { kind: 'attempt-start', attemptId: 'a', turn: 1, revision: 10 });
    h.outbound.routeStreamFrame('s1', { kind: 'text-delta', attemptId: 'a', turn: 1, revision: 11, text: '旧草稿' });
    h.outbound.routeStreamFrame('s1', { kind: 'attempt-start', attemptId: 'b', turn: 1, revision: 0 });
    h.outbound.routeStreamFrame('s1', { kind: 'text-delta', attemptId: 'b', turn: 1, revision: 1, text: '重试后的回复。' });
    h.message('重试后的回复。'); await vi.runAllTimersAsync();
    expect(h.sender.conversationDiagnostics?.()).toMatchObject({ sends: 1 });
    h.dispose();
  });

  it('accepted inbound invokes cancellation before followup and preserves the user message', async () => {
    const order: string[] = [];
    const a = { ...record(), agent: { followup: vi.fn(() => order.push('followup')), whenIdle: async () => {} } };
    const manager = { getOrCreate: async () => a, cancelOutput: () => order.push('cancel-output') } as unknown as SessionManager;
    const ctx = { message: { kind: 'c2c', senderId: 'u', content: '只分析别执行', messageId: 'm', timestamp: '' }, state: {}, bot: {} } as unknown as MiddlewareContext;
    await handleInbound(ctx, manager, {} as ImQQBotConfig, logger());
    expect(order).toEqual(['cancel-output', 'followup']);
    const message = a.agent.followup.mock.calls[0]?.[0] as { content: Array<{ text: string }> };
    expect(message.content[0]?.text).toContain('只分析别执行');
  });
});

it('actual Cordis 4.0.1 late optional Heart service and dispose operate without undeclared-property access', async () => {
  const context = new Context();
  let snapshotCalls = 0;
  const original = vi.fn(async () => ({ ok: true }));
  const sender = { sendMarkdown: original };
  const provider = await context.plugin({ name: 'conversation-test-provider', apply(ctx: Context) { ctx.provide('qqbotSender', sender); } });
  const companion = await context.plugin({ name: 'conversation-test-wrapper', inject: ['qqbotSender'],
    apply(ctx: Context) { apply(ctx, { persona: 'xiaoman', ignoreLocalFile: true, split: { delayMs: 0 } }); } });
  const heart = await context.plugin({ name: 'conversation-test-heart', apply(ctx: Context) {
    ctx.provide('heart', { getSnapshot() { snapshotCalls++; return { mood: { energy: .1 } }; } });
  } });
  try {
    await sender.sendMarkdown({ scope: 'c2c', targetId: 'synthetic' }, '只测试本地。');
    expect(snapshotCalls).toBeGreaterThan(0);
    await companion.dispose();
    expect(sender.sendMarkdown).toBe(original);
  } finally { await companion.dispose(); await heart.dispose(); await provider.dispose(); }
});
