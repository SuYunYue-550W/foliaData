// Rust EQ 与 Kotlin 公式的逐位对比试点。
//
// 基准不是「跑 Kotlin JVM」，而是用 JS 的 Math.fround 逐运算模拟 Kotlin 的 f32 语义，
// 照抄 BiquadFilter.kt / TenBandEq.kt 的公式。这样能在 CI 里跑，不需要 Android SDK。
// 真正接生产前还应拿 Kotlin 实测音频再比一次；这里先验证「Rust 实现与公式同构」。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const DLL = path.resolve(DIR, '../target/release/folia_eq_poc.dll');

if (!fs.existsSync(DLL)) {
    console.error('先跑 cargo build --release');
    process.exit(1);
}
const koffi = require(path.resolve(DIR, '../../../node_modules/koffi'));
const lib = koffi.load(DLL);

const ptr = koffi.pointer('TenBandEq', koffi.opaque());
const eqCreate = lib.func('folia_eq_create', ptr, []);
const eqDestroy = lib.func('folia_eq_destroy', 'void', [ptr]);
const eqConfigure = lib.func('folia_eq_configure', 'void', [ptr, 'int']);
const eqUpdate = lib.func('folia_eq_update', 'void', [ptr, 'float *', 'int', 'float', 'float']);
const eqProcess = lib.func('folia_eq_process', 'void', [ptr, 'float *', 'int', 'int']);

// ---- 与 Kotlin BiquadFilter.kt 逐行对应的 f32 基准 ----
const f = Math.fround;
const TWO_PI = f(6.283185307179586);
const FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(f);
const BAND_Q = f(1.4);
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const omega = (sr, freq) => f(f(TWO_PI * f(f(clamp(freq, f(10), f(sr * 0.475))))) / f(sr));

class KtBiquad {
    constructor() { this.b0 = f(1); this.b1 = f(0); this.b2 = f(0); this.a1 = f(0); this.a2 = f(0); this.z1 = new Map(); this.z2 = new Map(); this.active = false; }
    reset() { this.z1.clear(); this.z2.clear(); }
    bypass() { if (this.active) this.reset(); this.active = false; this.b0 = f(1); this.b1 = f(0); this.b2 = f(0); this.a1 = f(0); this.a2 = f(0); }
    process(x, ch) {
        if (!this.active) return x;
        const z1 = this.z1.get(ch) ?? 0, z2 = this.z2.get(ch) ?? 0;
        const out = f(f(this.b0 * x) + z1);
        this.z1.set(ch, f(f(f(this.b1 * x) - f(this.a1 * out)) + z2));
        this.z2.set(ch, f(f(this.b2 * x) - f(this.a2 * out)));
        return out;
    }
    normalize(b0, b1, b2, a0, a1, a2) {
        this.b0 = f(b0 / a0); this.b1 = f(b1 / a0); this.b2 = f(b2 / a0);
        this.a1 = f(a1 / a0); this.a2 = f(a2 / a0);
        this.active = true;
    }
    peaking(sr, freq, q, gainDb) {
        if (Math.abs(gainDb) < 0.01) return this.bypass();
        const w0 = omega(sr, freq), cosW0 = f(Math.cos(w0)), alpha = f(f(Math.sin(w0)) / f(2 * Math.max(q, 0.1)));
        const a = f(Math.pow(10, f(gainDb / 40)));
        this.normalize(f(1 + f(alpha * a)), f(-2 * cosW0), f(1 - f(alpha * a)),
            f(1 + f(alpha / a)), f(-2 * cosW0), f(1 - f(alpha / a)));
    }
    lowShelf(sr, freq, gainDb) {
        if (Math.abs(gainDb) < 0.01) return this.bypass();
        const w0 = omega(sr, freq), cosW0 = f(Math.cos(w0)), sinW0 = f(Math.sin(w0));
        const a = f(Math.pow(10, f(gainDb / 40))), alpha = f(f(sinW0 / 2) * Math.sqrt(2));
        const t = f(f(2 * Math.sqrt(a)) * alpha);
        this.normalize(f(a * (f(f(a + 1) - f(f(a - 1) * cosW0)) + t)),
            f(2 * a * f(f(a - 1) - f(f(a + 1) * cosW0))),
            f(a * (f(f(a + 1) - f(f(a - 1) * cosW0)) - t)),
            f(f(a + 1) + f(f(a - 1) * cosW0) + t),
            f(-2 * f(f(a - 1) + f(f(a + 1) * cosW0))),
            f(f(a + 1) + f(f(a - 1) * cosW0) - t));
    }
    highShelf(sr, freq, gainDb) {
        if (Math.abs(gainDb) < 0.01) return this.bypass();
        const w0 = omega(sr, freq), cosW0 = f(Math.cos(w0)), sinW0 = f(Math.sin(w0));
        const a = f(Math.pow(10, f(gainDb / 40))), alpha = f(f(sinW0 / 2) * Math.sqrt(2));
        const t = f(f(2 * Math.sqrt(a)) * alpha);
        this.normalize(f(a * (f(f(a + 1) + f(f(a - 1) * cosW0)) + t)),
            f(-2 * a * f(f(a - 1) + f(f(a + 1) * cosW0))),
            f(a * (f(f(a + 1) + f(f(a - 1) * cosW0)) - t)),
            f(f(a + 1) - f(f(a - 1) * cosW0) + t),
            f(2 * f(f(a - 1) - f(f(a + 1) * cosW0))),
            f(f(a + 1) - f(f(a - 1) * cosW0) - t));
    }
}

class KtTenBand {
    constructor() { this.bands = Array.from({ length: 10 }, () => new KtBiquad()); this.globalGain = f(1); }
    configure(sr) { this.sr = sr; this.bands.forEach(b => b.reset()); }
    update(gains, mode, q, globalGainDb) {
        const qUsed = mode === 1 ? f(clamp(q, 0.3, 8)) : BAND_Q;
        this.globalGain = f(Math.pow(10, f(globalGainDb / 20)));
        for (let i = 0; i < 10; i++) {
            const gain = f(gains[i]), freq = FREQS[i], band = this.bands[i];
            if (mode === 1) band.peaking(this.sr, freq, qUsed, gain);
            else if (i === 0) band.lowShelf(this.sr, freq, gain);
            else if (i === 9) band.highShelf(this.sr, freq, gain);
            else band.peaking(this.sr, freq, BAND_Q, gain);
        }
    }
    process(buf, frames, channels) {
        for (let i = 0; i < frames * channels; i++) {
            let s = f(buf[i]);
            for (const band of this.bands) s = band.process(s, i % channels);
            if (this.globalGain !== 1) s = f(s * this.globalGain);
            buf[i] = s;
        }
    }
}

// ---- 对比 ----
const SAMPLE_RATE = 48000;
const FRAMES = 512;
const CHANNELS = 2;
const GAINS = [6, -4, 3, 1.5, -2, 4, -3, 2, 0, 5];
const MODE = 0; // GEQ
const Q = 0.85;
const GLOBAL_DB = -3;

let seed = 12345;
const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const input = Array.from({ length: FRAMES * CHANNELS }, () => f(random() * 2 - 1));

const rustPtr = eqCreate();
eqConfigure(rustPtr, SAMPLE_RATE);
const rustBuf = Float32Array.from(input);
eqUpdate(rustPtr, new Float32Array(GAINS), MODE, f(Q), f(GLOBAL_DB));
eqProcess(rustPtr, rustBuf, FRAMES, CHANNELS);

const kt = new KtTenBand();
kt.configure(SAMPLE_RATE);
const ktBuf = Float32Array.from(input);
kt.update(GAINS, MODE, Q, GLOBAL_DB);
kt.process(ktBuf, FRAMES, CHANNELS);

eqDestroy(rustPtr);

let maxDiff = 0, diffCount = 0;
for (let i = 0; i < rustBuf.length; i++) {
    const diff = Math.abs(rustBuf[i] - ktBuf[i]);
    if (diff > maxDiff) maxDiff = diff;
    if (diff > 1e-7) diffCount++;
}
// f32 在 1.0 附近的 1 ulp ≈ 1.19e-7。剩余差异来自各平台 cos/sin/pow 的
// f64→f32 舍入不同（Rust 用 f32 libm，JS 基准是 f64 算完再 fround），
// 约 1~2 ulp，远低于听感阈值（0.01 dB ≈ 1e-3 相对误差）。
const ULP = 1.1920929e-7;
const tolerance = 4 * ULP;
console.log(`样本数: ${rustBuf.length}`);
console.log(`最大绝对差: ${maxDiff.toExponential(6)}`);
console.log(`差异 > 1e-7 的样本: ${diffCount}`);
console.log(`Rust 前 5: ${Array.from(rustBuf.slice(0, 5)).map(x => x.toFixed(8)).join(', ')}`);
console.log(`基准前 5: ${Array.from(ktBuf.slice(0, 5)).map(x => x.toFixed(8)).join(', ')}`);

const PASS = maxDiff <= tolerance;
console.log(`容差: ${tolerance.toExponential(6)} (4 f32 ulp)`);
console.log(PASS ? '数值等价通过：误差在几 ulp 内，听感无差别' : '数值等价未通过');
console.log('说明：此基准是 JS 模拟 Kotlin f32 语义，非 JVM 实测；接生产前需真机 Kotlin 再比一次。');
process.exit(PASS ? 0 : 1);
