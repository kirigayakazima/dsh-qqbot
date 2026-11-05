/** Resolve only the actual execution session. Never use the latest active peer as a guess. */
export function sessionReplyTarget(manager, sessionId) {
    if (typeof sessionId !== 'string' || !sessionId)
        return undefined;
    const record = manager.findBySessionId(sessionId);
    return record ? { ...record.replyTarget } : undefined;
}
//# sourceMappingURL=session-target.js.map