import { it, expect } from 'vitest';
import { sessionReplyTarget } from './session-target.ts';
import type { SessionManager } from '../session/index.ts';

it('voice target is pinned to the execution session, unknown sessions do not use the latest peer', () => {
  const targets = { a: { scope: 'c2c', targetId: 'A' }, b: { scope: 'group', targetId: 'B' } };
  const manager = { findBySessionId: (id: keyof typeof targets) => targets[id] ? { replyTarget: targets[id] } : undefined } as unknown as SessionManager;
  expect(sessionReplyTarget(manager, 'a')).toEqual(targets.a);
  expect(sessionReplyTarget(manager, 'b')).toEqual(targets.b);
  expect(sessionReplyTarget(manager, 'unknown')).toBeUndefined();
  const snapshot = sessionReplyTarget(manager, 'a')!;
  targets.a.targetId = 'changed';
  expect(snapshot.targetId).toBe('A');
});
