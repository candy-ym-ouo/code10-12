/** WAV(RIFF) 解码/编码：PCM 16/24/32 位整型与 32/64 位浮点，含 WAVE_FORMAT_EXTENSIBLE。 */

export interface WavData {
  sampleRate: number;
  channels: Float32Array[];
}

export function decodeWav(buffer: Buffer): WavData {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("NOT_A_WAV_FILE");
  }
  let offset = 12;
  let audioFormat = 0;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + chunkSize > buffer.length) break;
    if (chunkId === "fmt ") {
      audioFormat = buffer.readUInt16LE(body);
      numChannels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
      if (audioFormat === 0xfffe && chunkSize >= 40) {
        // WAVE_FORMAT_EXTENSIBLE：子格式 GUID 前两字节给出真实编码
        audioFormat = buffer.readUInt16LE(body + 24);
      }
    } else if (chunkId === "data") {
      dataStart = body;
      dataLength = chunkSize;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (dataStart < 0 || numChannels === 0 || sampleRate === 0) throw new Error("WAV_MISSING_FMT_OR_DATA");
  if (audioFormat !== 1 && audioFormat !== 3) throw new Error(`WAV_UNSUPPORTED_FORMAT_${audioFormat}`);

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * numChannels));
  if (frameCount === 0) throw new Error("WAV_EMPTY_DATA");
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c += 1) channels.push(new Float32Array(frameCount));

  for (let i = 0; i < frameCount; i += 1) {
    const frameBase = dataStart + i * bytesPerSample * numChannels;
    for (let c = 0; c < numChannels; c += 1) {
      const p = frameBase + c * bytesPerSample;
      let value: number;
      if (audioFormat === 3 && bitsPerSample === 32) {
        value = buffer.readFloatLE(p);
      } else if (audioFormat === 3 && bitsPerSample === 64) {
        value = buffer.readDoubleLE(p);
      } else if (bitsPerSample === 16) {
        value = buffer.readInt16LE(p) / 32768;
      } else if (bitsPerSample === 24) {
        const raw = buffer.readUIntLE(p, 3);
        value = ((raw & 0x800000) !== 0 ? raw - 0x1000000 : raw) / 8388608;
      } else if (bitsPerSample === 32) {
        value = buffer.readInt32LE(p) / 2147483648;
      } else {
        throw new Error(`WAV_UNSUPPORTED_BITS_${bitsPerSample}`);
      }
      channels[c]![i] = value;
    }
  }
  return { sampleRate, channels };
}

/** 编码为 16 位 PCM WAV（供测试夹具与可选的对齐产物使用）。 */
export function encodeWav16(channels: Float32Array[], sampleRate: number): Buffer {
  const numChannels = channels.length;
  const frameCount = channels[0]?.length ?? 0;
  const dataSize = frameCount * numChannels * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * numChannels * 2, 28);
  buffer.writeUInt16LE(numChannels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const v = Math.max(-1, Math.min(1, channels[c]![i]!));
      buffer.writeInt16LE(Math.round(v * 32767), offset);
      offset += 2;
    }
  }
  return buffer;
}

/** 多声道平均下混为单声道。 */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(n);
  const scale = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < n; i += 1) out[i] = out[i]! + ch[i]! * scale;
  }
  return out;
}

/** 线性插值重采样（仅用于采样率不一致的输入对齐到统一率，非母带级精度）。 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  if (fromRate <= 0 || toRate <= 0) throw new Error("INVALID_SAMPLE_RATE");
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}
