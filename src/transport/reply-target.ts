/**
 * 出站回复目标解析与发送 — 被动回复三级兜底 + msg_id/event_id 区分 + 引用回复 (message_reference)。
 *
 * 从 gateway 层抽离，保持 bootstrap 只做组装。三级兜底：
 *   1. 优先显式 target.msgId；
 *   2. 超频/过期后，用缓存里「最近一条未超频未过期」的 target；
 *   3. 全部候选都超频/过期，才降级为主动推送（proactive）。
 */
import { QQBot, MsgType } from '@tencent-connect/qqbot-nodejs';
import type { ReplyTarget } from '../types.ts';
import type { SendMarkdownOptions } from './outbound-buffer.ts';
import { getCachedReplyIds } from './msgid-cache.ts';
import type { CachedReplyId } from './msgid-cache.ts';
import type { ReplyLimiter } from './reply-limiter.ts';

/**
 * 解析被动回复目标。
 *
 * 显式 msgId 须经 cache 确认未超平台被动窗口（群 5min/私聊 30min），
 * 否则跳过（延迟投递携带的旧 id 会被平台 40034005 拒绝）。
 *
 * 保留原始引用的 refMsgId（显式 refMsgId 或初始 target.msgId），
 * 确保即使被动配额超限降级为主动推送，仍可附带 message_reference 引用原文。
 *
 * @param allowEvent 是否允许返回互动事件 eventId。markdown 发送支持 event_id
 *   （bot.send 的 extra），传 true；文件发送 SDK 暂不支持 event_id，传 false
 *   跳过 event 候选，降级为 msg 候选或主动推送。
 */
export function resolveReplyTarget(
  target: ReplyTarget,
  limiter: ReplyLimiter,
  allowEvent: boolean,
): ReplyTarget {
  const cached = getCachedReplyIds(target.scope, target.targetId);
  const explicitMsgId = target.msgId;
  const initialRefId = target.refMsgId || explicitMsgId;
  const candidates: CachedReplyId[] = [];
  // 显式 id 在 cache TTL 内（未超平台被动窗口）才置顶优先，否则跳过
  if (explicitMsgId !== undefined && cached.some((c) => c.id === explicitMsgId)) {
    candidates.push({ kind: 'msg', id: explicitMsgId });
  }
  for (const c of cached) {
    if (c.id === explicitMsgId) continue; // undefined 时恒 false，安全
    candidates.push(c);
  }

  for (const c of candidates) {
    if (c.kind === 'event' && !allowEvent) continue;
    if (limiter.checkLimit(c.id).allowed) {
      limiter.record(c.id);
      if (c.kind === 'event') {
        return { ...target, msgId: undefined, eventId: c.id, refMsgId: initialRefId };
      }
      return { ...target, msgId: c.id, eventId: undefined, refMsgId: initialRefId };
    }
  }

  return { ...target, msgId: undefined, eventId: undefined, refMsgId: initialRefId };
}

/**
 * 发送 markdown：统一透传 msg_id、event_id 与 message_reference 引用卡片。
 *
 * 引用解析优先级：
 * 1. content 中的引用标签 `<qqbot-reply id="..." />`、`<reply id="..." />` 或 `<quote id="..." />`
 * 2. opts.refMsgId 或 opts.messageReference.message_id
 * 3. target.refMsgId
 * 4. target.msgId
 *
 * 若检测到 `<no-reply />`、`<no-quote />` 或 opts/target.quoteReply === false，则不带引用卡片。
 */
export async function sendResolvedMarkdown(
  bot: QQBot,
  target: ReplyTarget,
  content: string,
  opts?: SendMarkdownOptions,
): Promise<unknown> {
  let effectiveContent = content;
  let parsedRefId = opts?.refMsgId;
  let parsedQuoteReply = opts?.quoteReply ?? target.quoteReply;

  // 1. 检查正文中是否有关闭引用的标签
  if (/<(?:no-reply|no-quote)\s*\/?>/i.test(effectiveContent)) {
    effectiveContent = effectiveContent.replace(/<(?:no-reply|no-quote)\s*\/?>\s*/gi, '');
    parsedQuoteReply = false;
  }

  // 2. 检查正文中是否指定了引用特定消息 ID
  const replyTagMatch = effectiveContent.match(/<(?:qqbot-reply|qq-reply|reply|quote)\s+id=["']([^"']+)["']/i);
  if (replyTagMatch && replyTagMatch[1]) {
    parsedRefId = replyTagMatch[1].trim();
    effectiveContent = effectiveContent.replace(/<(?:qqbot-reply|qq-reply|reply|quote)\s+id=["'][^"']+["']\s*\/?>/gi, '');
    effectiveContent = effectiveContent.replace(/<\/(?:qqbot-reply|qq-reply|reply|quote)>/gi, '');
    if (parsedQuoteReply === undefined) {
      parsedQuoteReply = true;
    }
  }
  effectiveContent = effectiveContent.trimStart();

  const trySend = async (tgt: ReplyTarget, isRetry = false) => {
    const quoteEnabled = !isRetry && (parsedQuoteReply ?? true);
    const refId = parsedRefId || opts?.messageReference?.message_id || tgt.refMsgId || (quoteEnabled ? tgt.msgId : undefined);
    const msgRef = (quoteEnabled && refId) ? {
      message_id: refId,
      ignore_get_message_error: opts?.messageReference?.ignore_get_message_error ?? true,
    } : undefined;

    if (tgt.eventId) {
      return bot.send({
        target: { scope: tgt.scope, targetId: tgt.targetId, msgId: undefined },
        msgType: MsgType.MARKDOWN,
        markdown: { content: effectiveContent },
        keyboard: opts?.keyboard,
        messageReference: msgRef as { message_id: string } | undefined,
        extra: { ...(opts?.extra || {}), event_id: tgt.eventId },
      });
    }

    return bot.send({
      target: tgt,
      msgType: MsgType.MARKDOWN,
      markdown: { content: effectiveContent },
      keyboard: opts?.keyboard,
      messageReference: msgRef as { message_id: string } | undefined,
      ...(opts?.extra ? { extra: opts.extra } : {}),
    });
  };

  try {
    const res = await trySend(target);
    console.log(
      `[qqsend] sendResolvedMarkdown OK (scope=${target.scope}, targetId=${target.targetId}, msgId=${target.msgId ?? 'none'}, refMsgId=${parsedRefId || target.refMsgId || target.msgId || 'none'}, eventId=${target.eventId ?? 'none'})`,
    );
    return res;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[qqsend] sendResolvedMarkdown 初次发送失败 (msgId=${target.msgId ?? 'none'}, eventId=${target.eventId ?? 'none'}): ${errMsg}`,
    );

    // 若原带有被动回复标识 (msgId 或 eventId)，自动降级为主动推送重发保底（重发关闭引用，确保投递）
    if (target.msgId || target.eventId) {
      const fallbackTarget: ReplyTarget = {
        ...target,
        msgId: undefined,
        eventId: undefined,
        refMsgId: undefined,
        quoteReply: false,
      };
      console.warn(`[qqsend] 尝试主动推送降级重发 (targetId=${target.targetId})...`);
      try {
        const fallbackRes = await trySend(fallbackTarget, true);
        console.log(`[qqsend] 主动推送降级重发成功！`);
        return fallbackRes;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.error(`[qqsend] 主动推送降级重发亦失败: ${retryMsg}`);
        throw retryErr;
      }
    }
    throw err;
  }
}
