// 生成"叮咚"双音提示音（纯 Node 合成，无依赖）：G#5 → Eb5，指数衰减
// 用法: node make-chime.mjs [输出路径]
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || path.join(import.meta.dirname, 'dingdong.wav');
const SAMPLE_RATE = 44_100;

/** 一段带指数衰减包络的正弦音 */
function tone(freq, durSec, { amp = 0.5, decay = 5, attackMs = 6 } = []) {
  const n = Math.round(durSec * SAMPLE_RATE);
  const buf = new Float64Array(n);
  const attackN = Math.round((attackMs / 1000) * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.exp(-t * decay) * (i < attackN ? i / attackN : 1);
    buf[i] = amp * env * Math.sin(2 * Math.PI * freq * t);
  }
  return buf;
}

// 叮(高) 0.5s + 间隙 0.05s + 咚(低) 0.7s
const ding = tone(830.61, 0.5, { amp: 0.5, decay: 6 });
const gap = new Float64Array(Math.round(0.05 * SAMPLE_RATE));
const dong = tone(622.25, 0.7, { amp: 0.55, decay: 4.5 });
const total = ding.length + gap.length + dong.length;

// 归一化 + 转十六位 PCM
const pcm = Buffer.alloc(total * 2);
let peak = 0;
for (const seg of [ding, gap, dong]) for (const v of seg) peak = Math.max(peak, Math.abs(v));
const norm = peak > 0 ? 0.86 / peak : 1;
let idx = 0;
for (const seg of [ding, gap, dong]) {
  for (const v of seg) {
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * norm * 32767))), idx * 2);
    idx++;
  }
}

// WAV 头（16-bit 单声道）
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);        // PCM
header.writeUInt16LE(1, 22);        // 单声道
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);  // byte rate
header.writeUInt16LE(2, 32);        // block align
header.writeUInt16LE(16, 34);       // bits
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, pcm]));
console.log(`已生成: ${out} (${((44 + pcm.length) / 1024).toFixed(1)} KB, ${(total / SAMPLE_RATE).toFixed(2)}s)`);
