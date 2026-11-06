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
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { decode, isSilk } from 'silk-wasm';
import { downloadMediaAttachments, isVoiceContentType, withVoiceAttachment } from '../transport/attachment.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, QuotedAttachment, RawAttachment } from '../types.ts';

const LOCAL_ASR = fileURLToPath(new URL('../../scripts/asr.py', import.meta.url));

interface VoiceTranscript {
  text: string;
  duration?: number;
}

async function transcribeOnPc(filePath: string, contentType: string): Promise<VoiceTranscript | undefined> {
  await using audio = createReadStream(filePath);
  const response = await fetch('http://127.0.0.1:28765/v1/voice/asr', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: Readable.toWeb(audio),
    duplex: 'half',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return;
  const result = await response.json() as VoiceTranscript & { ok: boolean };
  if (result.ok && result.text.trim()) return result;
}

async function transcribeVoice(filePath: string, contentType: string): Promise<VoiceTranscript> {
  const remote = await transcribeOnPc(filePath, contentType).catch(() => undefined);
  if (remote) return remote;

  const audio = await readFile(filePath);
  const silk = isSilk(audio);
  const input = silk ? (await decode(audio, 16000)).data : audio;
  const output = await new Promise<string>((resolve, reject) => {
    const args = silk ? [LOCAL_ASR, '--pcm'] : [LOCAL_ASR];
    const child = execFile('python3', args, { timeout: 10000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin!.on('error', reject).end(input);
  });
  return JSON.parse(output) as VoiceTranscript;
}

export function attachmentProcessor(config: ImQQBotConfig, logger: Logger) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>): Promise<void> => {
    const msg = ctx.message as { attachments?: RawAttachment[] };

    if (config.media.enabled) {
      const voices = (msg.attachments ?? []).filter(att => isVoiceContentType(att.content_type));
      const processed = [];
      for (const att of voices) {
        const existingText = att.asr_refer_text?.trim();
        const result = existingText ? { text: existingText } : await withVoiceAttachment(
          att, config.media, filePath => transcribeVoice(filePath, att.content_type),
        ).catch(() => undefined);
        const text = result?.text.trim();
        processed.push({
          type: 'voice',
          voiceText: text || '[没听清这句语音] 请再发一次',
          voiceSource: text ? 'asr' : 'fallback',
          duration: result?.duration,
        });
      }
      if (processed.length) ctx.state.processedAttachments = processed;
    }

    try {
      // 当前消息附件
      const downloaded = await downloadMediaAttachments(msg.attachments, config.media, logger);
      ctx.state.downloadedFiles = downloaded;

      // 引用消息附件：转成 RawAttachment 结构复用下载（voice 由 downloadMediaAttachments 自动跳过）
      const quoteAttachments = (ctx.state as { quote?: { attachments?: QuotedAttachment[] } }).quote?.attachments;
      if (quoteAttachments && quoteAttachments.length > 0) {
        const rawQuote = quoteAttachments
          .filter(a => a.url)
          .map((a): RawAttachment => ({
            content_type: a.contentType ?? '',
            filename: a.filename ?? '',
            size: 0,
            url: a.url as string,
          }));
        const downloadedQuote = await downloadMediaAttachments(rawQuote, config.media, logger);
        ctx.state.downloadedQuoteFiles = downloadedQuote;
      }
    } catch (err) {
      logger.warn(`im-qqbot: attachment download failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await next();
  };
}
