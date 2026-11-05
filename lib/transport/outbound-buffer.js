import { chunkMarkdownText } from "./chunker.js";
import { StreamingWriter } from "./streaming-writer.js";
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
export class OutboundBuffer {
    buffer = '';
    flushing = false;
    writer;
    record;
    bot;
    limit;
    logger;
    controller = new AbortController();
    signal;
    target;
    constructor(record, bot, limit, logger, streamingEnabled, signal) {
        this.record = record;
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
        this.target = { ...record.replyTarget };
        this.writer = streamingEnabled
            ? new StreamingWriter({ bot, target: { ...record.replyTarget }, logger, throttleMs: STREAM_THROTTLE_MS, signal: this.signal })
            : null;
    }
    /** 追加文本增量 */
    append(text) {
        if (this.signal.aborted)
            return;
        this.buffer += text;
        this.writer?.append(text);
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
    reset() {
        this.buffer = '';
        this.writer?.reset();
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.signal.aborted || this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            if (this.writer) {
                await this.writer.finish();
                if (this.signal.aborted)
                    return;
                // 流式成功（未降级）→ 直接返回
                if (!this.writer.shouldFallback)
                    return;
            }
            // 降级：静态发送（writer 不存在 or 流式失败）
            const chunks = chunkMarkdownText(this.buffer, this.limit);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (this.signal.aborted)
                    return;
                if (chunk === undefined)
                    continue;
                const opts = i === 0 ? { signal: this.signal } : { quoteReply: false, signal: this.signal };
                const result = await this.bot.sendMarkdown(this.target, chunk, opts);
                if (this.signal.aborted || result?.cancelled)
                    return;
                console.log(`[qqsend] OutboundBuffer.flush sent ${chunk.length} chars to ${this.record.replyTarget.scope}:${this.record.replyTarget.targetId}`);
            }
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[qqsend] OutboundBuffer.flush failed: ${errMsg}`);
            this.logger.error(`im-qqbot: flush failed: ${errMsg}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.controller.abort();
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map