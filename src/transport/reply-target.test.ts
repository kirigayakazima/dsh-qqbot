import { describe, it, expect, vi } from 'vitest';
import type { QQBot } from '@tencent-connect/qqbot-nodejs';
import { ReplyLimiter } from './reply-limiter.ts';
import { cacheMsgId, cacheEventId } from './msgid-cache.ts';
import { resolveReplyTarget, sendResolvedMarkdown } from './reply-target.ts';
import type { ReplyTarget } from '../types.ts';

function makeTarget(msgId?: string, targetId = 'peer-1'): ReplyTarget {
  return { scope: 'c2c', targetId, msgId };
}

describe('resolveReplyTarget', () => {
  it('prefers explicit target.msgId (cached & within window)', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheMsgId('c2c', 'peer-1', 'm1');
    const result = resolveReplyTarget(makeTarget('m1'), limiter, true);
    expect(result.msgId).toBe('m1');
    expect(result.eventId).toBeUndefined();
    expect(result.refMsgId).toBe('m1');
  });

  it('falls back to cached msgId after target.msgId is exhausted, preserving refMsgId', () => {
    const limiter = new ReplyLimiter({ limit: 1 });
    cacheMsgId('c2c', 'peer-2', 'cached-1');
    limiter.record('m-exhausted');
    const result = resolveReplyTarget(makeTarget('m-exhausted', 'peer-2'), limiter, true);
    expect(result.msgId).toBe('cached-1');
    expect(result.refMsgId).toBe('m-exhausted');
  });

  it('drops explicit msgId beyond the platform window: falls back to a fresher cached candidate', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cacheMsgId('c2c', 'peer-10', 'stale-id');
      vi.setSystemTime(Date.now() + 31 * 60 * 1000); // c2c TTL 30min 过期
      cacheMsgId('c2c', 'peer-10', 'fresh-id'); // 窗口过期后用户又发了一条
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-10'), limiter, true);
      expect(result.msgId).toBe('fresh-id');
      expect(result.refMsgId).toBe('stale-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops explicit msgId beyond the platform window: no candidates → proactive, preserving refMsgId', () => {
    vi.useFakeTimers();
    try {
      const limiter = new ReplyLimiter({ limit: 4 });
      cacheMsgId('c2c', 'peer-11', 'stale-id');
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      const result = resolveReplyTarget(makeTarget('stale-id', 'peer-11'), limiter, true);
      expect(result.msgId).toBeUndefined();
      expect(result.eventId).toBeUndefined();
      expect(result.refMsgId).toBe('stale-id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips event candidates when allowEvent is false', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-3', 'evt-1');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-3'), limiter, false);
    expect(result.eventId).toBeUndefined();
    expect(result.msgId).toBeUndefined();
  });

  it('returns eventId when allowEvent is true', () => {
    const limiter = new ReplyLimiter({ limit: 4 });
    cacheEventId('c2c', 'peer-4', 'evt-2');
    const result = resolveReplyTarget(makeTarget(undefined, 'peer-4'), limiter, true);
    expect(result.eventId).toBe('INTERACTION_CREATE:evt-2');
    expect(result.msgId).toBeUndefined();
  });
});

describe('sendResolvedMarkdown', () => {
  it('fills event_id via bot.send when target has eventId', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', eventId: 'INTERACTION_CREATE:evt' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      extra: { event_id: 'INTERACTION_CREATE:evt' },
    }));
  });

  it('uses bot.send with messageReference for msgId targets (default quote reply)', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
      sendMarkdown: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, 'hello');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      target,
      markdown: { content: 'hello' },
      messageReference: { message_id: 'm1', ignore_get_message_error: true },
    }));
  });

  it('allows specifying refMsgId via opts or target', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'group', targetId: 'g1', msgId: 'm-current' };
    await sendResolvedMarkdown(bot, target, 'specific reply', { refMsgId: 'm-target-custom' });
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      target,
      markdown: { content: 'specific reply' },
      messageReference: { message_id: 'm-target-custom', ignore_get_message_error: true },
    }));
  });

  it('parses <reply id="..." /> from content, quotes that id and strips the tag', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'group', targetId: 'g1', msgId: 'm-current' };
    await sendResolvedMarkdown(bot, target, '<reply id="MSG_888" /> 收到，马上处理！');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      markdown: { content: '收到，马上处理！' },
      messageReference: { message_id: 'MSG_888', ignore_get_message_error: true },
    }));
  });

  it('parses <qqbot-reply id="..." /> from content', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'group', targetId: 'g1', msgId: 'm-current' };
    await sendResolvedMarkdown(bot, target, '<qqbot-reply id="MSG_999" />姐姐在吗');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      markdown: { content: '姐姐在吗' },
      messageReference: { message_id: 'MSG_999', ignore_get_message_error: true },
    }));
  });

  it('supports <no-reply /> tag in content to suppress quote reply', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, '<no-reply /> 不需要引用的独立通知');
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      markdown: { content: '不需要引用的独立通知' },
      messageReference: undefined,
    }));
  });

  it('supports quoteReply: false in opts to suppress quote reply', async () => {
    const bot = {
      send: vi.fn(async () => ({})),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    await sendResolvedMarkdown(bot, target, 'segment 2 without quote', { quoteReply: false });
    expect(bot.send).toHaveBeenCalledWith(expect.objectContaining({
      markdown: { content: 'segment 2 without quote' },
      messageReference: undefined,
    }));
  });

  it('falls back to proactive send without quote on initial error', async () => {
    const bot = {
      send: vi.fn()
        .mockRejectedValueOnce(new Error('passive ticket expired'))
        .mockResolvedValueOnce({ id: 'fallback-ok' }),
    } as unknown as QQBot;
    const target: ReplyTarget = { scope: 'c2c', targetId: 'p', msgId: 'm1' };
    const res = await sendResolvedMarkdown(bot, target, 'test message');
    expect(bot.send).toHaveBeenCalledTimes(2);
    // 第一次调用带 msgId 和 messageReference
    expect((bot.send as ReturnType<typeof vi.fn>).mock.calls[0][0].messageReference).toEqual({
      message_id: 'm1',
      ignore_get_message_error: true,
    });
    // 第二次降级重试为主动推送，清除 msgId 和 messageReference
    expect((bot.send as ReturnType<typeof vi.fn>).mock.calls[1][0].target.msgId).toBeUndefined();
    expect((bot.send as ReturnType<typeof vi.fn>).mock.calls[1][0].messageReference).toBeUndefined();
    expect(res).toEqual({ id: 'fallback-ok' });
  });
});
