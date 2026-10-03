import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

/**
 * 轻量 PCM 容器：WAV 读写 + 可选的 ffmpeg 解码后端。
 * 所有分析都在 f32 交错 PCM 上进行，采样率统一上采样/下采样到工作采样率。
 */

export interface PcmContainer {
  sampleRate: number;
  channels: number;
  /** 交错 f32 样本，值域 [-1, 1] */
  data: Float32Array;
}

export class PcmDecodeError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_WAV" | "UNSUPPORTED_WAV" | "EMPTY_PCM" | "FFMPEG_UNAVAILABLE" | "FFMPEG_FAILED",
  ) {
    super(message);
    this.name = "PcmDecodeError";
  }
}

const readAscii = (buffer: Buffer, offset: number, length: number) => buffer.toString("latin1", offset, offset + length);

function findChunk(buffer: Buffer, id: string, start: number, end: number): { offset: number; size: number } | null {
  let cursor = start;
  while (cursor + 8 <= end) {
    const chunkId = readAscii(buffer, cursor, 4);
    const chunkSize = buffer.readUInt32LE(cursor + 4);
    if (chunkId === id) return { offset: cursor + 8, size: chunkSize };
    cursor += 8 + chunkSize + (chunkSize & 1);
  }
  return null;
}

/** 解码 PCM WAV（8/16/24/32-bit 整型与 32-bit 浮点），返回交错 f32。 */
export function decodeWav(buffer: Buffer): PcmContainer {
  if (buffer.length < 12 || readAscii(buffer, 0, 4) !== "RIFF" || readAscii(buffer, 8, 4) !== "WAVE") {
    throw new PcmDecodeError("不是 WAV 文件", "NOT_WAV");
  }
  const fmt = findChunk(buffer, "fmt ", 12, buffer.length);
  const dataChunk = findChunk(buffer, "data", 12, buffer.length);
  if (!fmt || !dataChunk) throw new PcmDecodeError("WAV 缺少 fmt/data 块", "UNSUPPORTED_WAV");

  const audioFormat = buffer.readUInt16LE(fmt.offset);
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);
  if (channels < 1 || channels > 6) throw new PcmDecodeError("不支持的声道数", "UNSUPPORTED_WAV");
  if (sampleRate < 8000 || sampleRate > 192000) throw new PcmDecodeError("不支持的采样率", "UNSUPPORTED_WAV");

  // 1 = PCM, 3 = IEEE float, 0xFFFE = EXTENSIBLE（子格式 GUID 位于 fmt 数据偏移 24）
  let format = audioFormat;
  if (audioFormat === 0xfffe && fmt.size >= 40) {
    format = buffer.readUInt16LE(fmt.offset + 24);
  }
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  if (frameBytes === 0) throw new PcmDecodeError("无效的位深", "UNSUPPORTED_WAV");
  const frameCount = Math.floor(Math.min(dataChunk.size, buffer.length - dataChunk.offset) / frameBytes);
  if (frameCount === 0) throw new PcmDecodeError("音频没有任何样本", "EMPTY_PCM");

  const data = new Float32Array(frameCount * channels);
  const base = dataChunk.offset;

  if (format === 1) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const pos = base + (frame * channels + channel) * bytesPerSample;
        let value = 0;
        if (bitsPerSample === 8) value = buffer.readUInt8(pos) / 128 - 1;
        else if (bitsPerSample === 16) value = buffer.readInt16LE(pos) / 32768;
        else if (bitsPerSample === 24) {
          const int = buffer.readIntLE(pos, 3) & 0xffffff;
          value = (int > 0x7fffff ? int - 0x1000000 : int) / 8388608;
        } else if (bitsPerSample === 32) value = buffer.readInt32LE(pos) / 2147483648;
        else throw new PcmDecodeError("不支持的 PCM 位深", "UNSUPPORTED_WAV");
        data[frame * channels + channel] = value;
      }
    }
  } else if (format === 3 && bitsPerSample === 32) {
    for (let index = 0; index < data.length; index += 1) {
      data[index] = buffer.readFloatLE(base + index * 4);
    }
  } else {
    throw new PcmDecodeError("仅支持 PCM 与 32-bit 浮点 WAV", "UNSUPPORTED_WAV");
  }
  return { sampleRate, channels, data };
}

/** 交错 f32 编码为 16-bit PCM WAV。 */
export function encodeWavPcm16(container: PcmContainer): Buffer {
  const { sampleRate, channels, data } = container;
  const frameCount = Math.floor(data.length / channels);
  const dataBytes = frameCount * channels * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "latin1");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "latin1");
  buffer.write("fmt ", 12, "latin1");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "latin1");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frameCount * channels; index += 1) {
    const sample = Math.max(-1, Math.min(1, data[index] ?? 0));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
  }
  return buffer;
}

/**
 * 用 ffmpeg 把任意压缩格式解码为单声道 f32 PCM。
 * 无 ffmpeg 时以 FFMPEG_UNAVAILABLE 失败，调用方可据此给出可续跑的错误码。
 */
export async function decodeWithFfmpeg(
  filePath: string,
  targetSampleRate: number,
  ffmpegPath = "ffmpeg",
): Promise<PcmContainer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let stderr = "";
    let child;
    try {
      child = spawn(
        ffmpegPath,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          filePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(targetSampleRate),
          "-f",
          "f32le",
          "pipe:1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch {
      reject(new PcmDecodeError("系统未安装 ffmpeg，无法解析压缩音频", "FFMPEG_UNAVAILABLE"));
      return;
    }
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("latin1").slice(0, 4000);
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new PcmDecodeError("系统未安装 ffmpeg，无法解析压缩音频", "FFMPEG_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new PcmDecodeError(stderr.trim() || `ffmpeg exited with ${code}`, "FFMPEG_FAILED"));
        return;
      }
      const bytes = Buffer.concat(chunks);
      const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (data.length === 0) {
        reject(new PcmDecodeError("音频没有任何样本", "EMPTY_PCM"));
        return;
      }
      resolve({ sampleRate: targetSampleRate, channels: 1, data });
    });
  });
}

/** 读取整个文件到 Buffer（供 WAV 直通解析）。 */
export async function readFileBuffer(filePath: string): Promise<Buffer> {
  const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
