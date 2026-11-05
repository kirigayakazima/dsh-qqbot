import type { SessionManager } from '../session/index.ts';
import type { ReplyTarget } from '../types.ts';

/** Resolve only the actual execution session. Never use the latest active peer as a guess. */
export function sessionReplyTarget(manager: SessionManager, sessionId: string): ReplyTarget | undefined {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const record = manager.findBySessionId(sessionId);
  return record ? { ...record.replyTarget } : undefined;
}
