var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/**
 * 富媒体中间件 — 下载 image/video/file，语音条只保留转录结果。
 *
 * 结果写入 ctx.state.downloadedFiles，供 handleInbound 读取。
 * 下载失败不阻断消息（记录告警后放行），确保附件异常不影响正常文本处理。
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { decode, isSilk } from 'silk-wasm';
import { downloadMediaAttachments, isVoiceContentType, withVoiceAttachment } from "../transport/attachment.js";
const LOCAL_ASR = fileURLToPath(new URL('../../scripts/asr.py', import.meta.url));
async function transcribeOnPc(filePath, contentType) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const audio = __addDisposableResource(env_1, createReadStream(filePath), true);
        const response = await fetch('http://127.0.0.1:28765/v1/voice/asr', {
            method: 'POST',
            headers: { 'Content-Type': contentType },
            body: Readable.toWeb(audio),
            duplex: 'half',
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
            return;
        const result = await response.json();
        if (result.ok && result.text.trim())
            return result;
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        const result_1 = __disposeResources(env_1);
        if (result_1)
            await result_1;
    }
}
async function transcribeVoice(filePath, contentType) {
    const remote = await transcribeOnPc(filePath, contentType).catch(() => undefined);
    if (remote)
        return remote;
    const audio = await readFile(filePath);
    const silk = isSilk(audio);
    const input = silk ? (await decode(audio, 16000)).data : audio;
    const output = await new Promise((resolve, reject) => {
        const args = silk ? [LOCAL_ASR, '--pcm'] : [LOCAL_ASR];
        const child = execFile('python3', args, { timeout: 10000 }, (error, stdout) => {
            if (error)
                reject(error);
            else
                resolve(stdout);
        });
        child.stdin.on('error', reject).end(input);
    });
    return JSON.parse(output);
}
export function attachmentProcessor(config, logger) {
    return async (ctx, next) => {
        const msg = ctx.message;
        if (config.media.enabled) {
            const voices = (msg.attachments ?? []).filter(att => isVoiceContentType(att.content_type));
            const processed = [];
            for (const att of voices) {
                const existingText = att.asr_refer_text?.trim();
                const result = existingText ? { text: existingText } : await withVoiceAttachment(att, config.media, filePath => transcribeVoice(filePath, att.content_type)).catch(() => undefined);
                const text = result?.text.trim();
                processed.push({
                    type: 'voice',
                    voiceText: text || '[没听清这句语音] 请再发一次',
                    voiceSource: text ? 'asr' : 'fallback',
                    duration: result?.duration,
                });
            }
            if (processed.length)
                ctx.state.processedAttachments = processed;
        }
        try {
            // 当前消息附件
            const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
            ctx.state.downloadedFiles = downloaded;
            // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）
            const quoteAttachments = ctx.state.quote?.attachments;
            if (quoteAttachments && quoteAttachments.length > 0) {
                const rawQuote = quoteAttachments
                    .filter(a => a.url)
                    .map((a) => ({
                    content_type: a.contentType ?? '',
                    filename: a.filename ?? '',
                    size: 0,
                    url: a.url,
                }));
                const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);
                ctx.state.downloadedQuoteFiles = downloadedQuote;
            }
        }
        catch (err) {
            logger.warn(`im-qqbot: attachment download failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await next();
    };
}
//# sourceMappingURL=attachment.js.map