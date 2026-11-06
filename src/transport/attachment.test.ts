import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import * as dns from 'node:dns';
import { execFile } from 'node:child_process';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import { MEDIA_ROOT } from '../media/media-cleaner.ts';
import { attachmentProcessor } from '../middleware/attachment.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { SessionManager } from '../session/index.ts';
import { downloadMediaAttachments, imageExtension, correctImageExt } from './attachment.ts';
import { handleInbound } from './inbound.ts';
import type { Logger } from '../types.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: vi.fn(),
}));

vi.mock('../media/media-cleaner.ts', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { MEDIA_ROOT: mkdtempSync(join(tmpdir(), 'dsh-qqbot-attachment-')) };
});

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

beforeEach(() => {
  vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['8.8.8.8']);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  rmSync(MEDIA_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(MEDIA_ROOT, { recursive: true, force: true });
});

describe('voice attachments', () => {
  it.each(['pc', 'phone', 'unclear'])('passes only text onward and removes the voice file (%s)', async (channel) => {
    const voiceDir = join(MEDIA_ROOT, 'tmp_voice');
    const audio = new Uint8Array(Buffer.from('RIFF-test'));
    const transcript = { text: '晚上吃什么', duration: 3.2 };
    vi.stubGlobal('fetch', vi.fn(async (url, request) => {
      if (new URL(url).hostname === 'example.com') return new Response(audio);
      expect(String(url)).toBe('http://127.0.0.1:28765/v1/voice/asr');
      expect(readdirSync(voiceDir)).toHaveLength(1);
      expect(new Uint8Array(await new Response(request.body).arrayBuffer())).toEqual(audio);
      return channel === 'pc' ? Response.json({ ok: true, ...transcript }) : new Response(null, { status: 503 });
    }));
    vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => {
      const stdin = { on: () => stdin, end: (input: Buffer) => {
        expect(new Uint8Array(input)).toEqual(audio);
        if (channel === 'phone') callback?.(null, JSON.stringify(transcript), '');
        else callback?.(new Error('ASR unavailable'), '', '');
      } };
      return { stdin } as ReturnType<typeof execFile>;
    });

    const ctx = {
      message: {
        kind: 'c2c', senderId: 'user', messageId: 'voice',
        attachments: [{
          filename: 'voice.wav', content_type: 'audio/wav', size: audio.length, url: '//example.com/voice',
        }],
      },
      state: {},
    } as unknown as MiddlewareContext;
    const followup = vi.fn();
    const manager = {
      getOrCreate: async () => ({ sessionId: 'session', agent: { followup, whenIdle: async () => {} } }),
    } as unknown as SessionManager;
    const config = { media: { enabled: true, maxMB: 1, ttlHours: 24 } } as ImQQBotConfig;
    const next = vi.fn(async () => {
      expect(readdirSync(voiceDir)).toEqual([]);
      expect(ctx.state.downloadedFiles).toEqual([]);
      expect(ctx.state.processedAttachments).toEqual([{
        type: 'voice',
        voiceText: channel === 'unclear' ? '[没听清这句语音] 请再发一次' : transcript.text,
        voiceSource: channel === 'unclear' ? 'fallback' : 'asr',
        duration: channel === 'unclear' ? undefined : transcript.duration,
      }]);
      await handleInbound(ctx, manager, config, logger);
    });
    await attachmentProcessor(config, logger)(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledTimes(channel === 'pc' ? 0 : 1);
    const expected = channel === 'unclear' ? '[Voice message] [没听清这句语音] 请再发一次' : '[Voice message (3.2s)] 晚上吃什么';
    expect(followup.mock.calls[0]?.[0].content).toEqual([{ type: 'text', text: expected }]);
  });
});

describe('downloadMediaAttachments', () => {
  it.each([
    { name: 'GIF89a 修正为 .gif', filename: 'photo.png', bytes: gif, contentType: 'image/png', ext: '.gif' },
    { name: 'JPEG 修正为 .jpg', filename: 'photo.png', bytes: jpeg, contentType: 'image/png', ext: '.jpg' },
    { name: '真实 PNG 保留 .png', filename: 'photo.png', bytes: png, contentType: 'image/png', ext: '.png' },
    { name: 'JPEG 保留 .jpeg', filename: 'photo.jpeg', bytes: jpeg, contentType: 'image/png', ext: '.jpeg' },
    { name: '未知格式保留 .png', filename: 'photo.png', bytes: Buffer.from('unknown'), contentType: 'image/png', ext: '.png' },
    { name: '非图片不修正扩展名', filename: 'data.bin', bytes: gif, contentType: 'file', ext: '.bin' },
    { name: '无扩展名补全', filename: 'photo', bytes: gif, contentType: 'image', ext: '.gif' },
    { name: '扩展名比较忽略大小写', filename: 'photo.JPEG', bytes: jpeg, contentType: 'image/png', ext: '.JPEG' },
    { name: 'GIF87a 修正扩展名', filename: 'photo.png', bytes: Buffer.from('GIF87a'), contentType: 'image/png', ext: '.gif' },
    { name: 'WebP 修正扩展名', filename: 'photo.png', bytes: Buffer.from('RIFF0000WEBP'), contentType: 'image/png', ext: '.webp' },
    { name: 'BMP 修正扩展名', filename: 'photo.png', bytes: Buffer.from('BM0000'), contentType: 'image/png', ext: '.bmp' },
  ])('$name', async ({ filename, bytes, contentType, ext }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array(bytes))));

    const results = await downloadMediaAttachments(
      [{ filename, content_type: contentType, size: bytes.length, url: 'https://example.com/image' }],
      { enabled: true, maxMB: 1, ttlHours: 24 },
      logger,
    );

    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(extname(result.localPath)).toBe(ext);
    expect(result.filename).toBe(filename);
    expect(result.contentType).toBe(contentType === 'file' ? 'file' : 'image');
    expect(readFileSync(result.localPath)).toEqual(bytes);
    expect(readdirSync(MEDIA_ROOT)).toEqual([basename(result.localPath)]);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining(`→ ${result.localPath}`));
  });
});

describe('imageExtension（纯函数：magic bytes 识别）', () => {
  it.each([
    { name: 'GIF89a', buf: Buffer.from('GIF89a\x01\x00', 'latin1'), ext: '.gif' },
    { name: 'GIF87a', buf: Buffer.from('GIF87a', 'latin1'), ext: '.gif' },
    { name: 'PNG', buf: Buffer.from('89504e470d0a1a0a', 'hex'), ext: '.png' },
    { name: 'JPEG', buf: Buffer.from('ffd8ffe0', 'hex'), ext: '.jpg' },
    { name: 'WebP', buf: Buffer.from('RIFF0000WEBP', 'latin1'), ext: '.webp' },
    { name: 'BMP', buf: Buffer.from('BM00', 'latin1'), ext: '.bmp' },
  ])('识别 $name → $ext', ({ buf, ext }) => {
    expect(imageExtension(buf)).toBe(ext);
  });

  it('未知格式 → undefined', () => {
    expect(imageExtension(Buffer.from('unknown-bytes'))).toBeUndefined();
  });

  it('短 buffer 不越界（安全落到 undefined）', () => {
    expect(imageExtension(Buffer.from([0xff]))).toBeUndefined();          // JPEG 需 3 字节
    expect(imageExtension(Buffer.from('RIFF', 'latin1'))).toBeUndefined(); // WebP 需 12 字节
    expect(imageExtension(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('correctImageExt（纯函数：扩展名修正）', () => {
  const gif = Buffer.from('GIF89a', 'latin1');
  const jpeg = Buffer.from('ffd8ff', 'hex');

  it('声明与真实不符 → 替换为真实扩展名，主体不变', () => {
    expect(correctImageExt('/m/photo_123.png', gif)).toBe('/m/photo_123.gif');
  });

  it('声明与真实一致 → 原样返回', () => {
    expect(correctImageExt('/m/photo.gif', gif)).toBe('/m/photo.gif');
  });

  it('jpg≈jpeg 视为等价 → 不改名', () => {
    expect(correctImageExt('/m/photo.jpeg', jpeg)).toBe('/m/photo.jpeg');
  });

  it('大小写不敏感比较 → 保留原名', () => {
    expect(correctImageExt('/m/photo.JPEG', jpeg)).toBe('/m/photo.JPEG');
  });

  it('未识别格式 → 原样返回', () => {
    expect(correctImageExt('/m/photo.png', Buffer.from('xx'))).toBe('/m/photo.png');
  });
});
