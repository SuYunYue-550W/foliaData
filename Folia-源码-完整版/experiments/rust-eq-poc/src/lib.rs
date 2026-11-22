// folia-eq-poc — 10 段 EQ 的 Rust 试点，验证「一份 DSP 三端复用」是否可行。
//
// 这里逐位照搬 Android 侧的 Kotlin 实现：
//   android/app/src/main/java/top/izuna/foliamajor/player/dsp/BiquadFilter.kt
//   android/app/src/main/java/top/izuna/foliamajor/player/dsp/TenBandEq.kt
// 系数用 RBJ Audio EQ Cookbook，运算是 Direct Form II Transposed，全程 f32。
// 不改生产代码：本 crate 只做实验与逐位对比，不进 electron-builder / Gradle。

const MAX_CHANNELS: usize = 8;
const TWO_PI: f32 = 6.283185307179586_f32;
const BAND_FREQUENCIES: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];
const BAND_Q: f32 = 1.4;
const MIN_Q: f32 = 0.3;
const MAX_Q: f32 = 8.0;

/// 单个二阶节。状态按声道保留（与 Kotlin 的 z1/z2 FloatArray 一致）。
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: [f32; MAX_CHANNELS],
    z2: [f32; MAX_CHANNELS],
    pub active: bool,
}

impl Biquad {
    pub fn new() -> Self {
        Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, z1: [0.0; MAX_CHANNELS], z2: [0.0; MAX_CHANNELS], active: false }
    }

    pub fn reset(&mut self) {
        self.z1.fill(0.0);
        self.z2.fill(0.0);
    }

    pub fn bypass(&mut self) {
        if self.active { self.reset(); }
        self.active = false;
        self.b0 = 1.0; self.b1 = 0.0; self.b2 = 0.0; self.a1 = 0.0; self.a2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, input: f32, channel: usize) -> f32 {
        if !self.active { return input; }
        let i = if channel < MAX_CHANNELS { channel } else { 0 };
        let output = self.b0 * input + self.z1[i];
        self.z1[i] = self.b1 * input - self.a1 * output + self.z2[i];
        self.z2[i] = self.b2 * input - self.a2 * output;
        output
    }

    fn omega(sample_rate: i32, frequency: f32) -> f32 {
        let fs = sample_rate as f32;
        TWO_PI * frequency.clamp(10.0, fs * 0.475) / fs
    }

    fn normalize(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        self.b0 = b0 / a0; self.b1 = b1 / a0; self.b2 = b2 / a0;
        self.a1 = a1 / a0; self.a2 = a2 / a0;
        self.active = true;
    }

    pub fn set_peaking(&mut self, sample_rate: i32, frequency: f32, q: f32, gain_db: f32) {
        if gain_db.abs() < 0.01 { self.bypass(); return; }
        let w0 = Self::omega(sample_rate, frequency);
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q.max(0.1));
        let a = 10.0_f32.powf(gain_db / 40.0);
        self.normalize(
            1.0 + alpha * a, -2.0 * cos_w0, 1.0 - alpha * a,
            1.0 + alpha / a, -2.0 * cos_w0, 1.0 - alpha / a,
        );
    }

    pub fn set_low_shelf(&mut self, sample_rate: i32, frequency: f32, gain_db: f32) {
        if gain_db.abs() < 0.01 { self.bypass(); return; }
        let w0 = Self::omega(sample_rate, frequency);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let a = 10.0_f32.powf(gain_db / 40.0);
        let alpha = sin_w0 / 2.0 * 2.0_f32.sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        self.normalize(
            a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
            a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
            (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
            -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
            (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
        );
    }

    pub fn set_high_shelf(&mut self, sample_rate: i32, frequency: f32, gain_db: f32) {
        if gain_db.abs() < 0.01 { self.bypass(); return; }
        let w0 = Self::omega(sample_rate, frequency);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let a = 10.0_f32.powf(gain_db / 40.0);
        let alpha = sin_w0 / 2.0 * 2.0_f32.sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        self.normalize(
            a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
            a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
            (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
            2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
            (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
        );
    }
}

/// 10 段 EQ。GEQ 首末是 shelf、中间 peaking(Q=1.4)；PEQ 全部 peaking(Q 可调)。
pub struct TenBandEq {
    bands: [Biquad; 10],
    sample_rate: i32,
    global_gain: f32,
    last_gains: [f32; 10],
    last_mode: i32,
    last_q: f32,
    last_global_gain_db: f32,
}

impl TenBandEq {
    pub fn new() -> Self {
        Self {
            bands: std::array::from_fn(|_| Biquad::new()),
            sample_rate: 0,
            global_gain: 1.0,
            last_gains: [f32::NAN; 10],
            last_mode: -1,
            last_q: f32::NAN,
            last_global_gain_db: f32::NAN,
        }
    }

    pub fn configure(&mut self, sample_rate: i32) {
        self.sample_rate = sample_rate;
        self.last_gains = [f32::NAN; 10];
        self.last_mode = -1;
        self.last_q = f32::NAN;
        self.last_global_gain_db = f32::NAN;
        self.reset();
    }

    pub fn reset(&mut self) { for band in &mut self.bands { band.reset(); } }

    pub fn update(&mut self, gains: &[f32; 10], mode: i32, q: f32, global_gain_db: f32) {
        if self.sample_rate <= 0 { return; }
        // mode: 0 = GEQ, 1 = PEQ（对齐 EqCurveMode）
        let q_used = if mode == 1 { q.clamp(MIN_Q, MAX_Q) } else { BAND_Q };
        if mode == self.last_mode
            && q_used == self.last_q
            && global_gain_db == self.last_global_gain_db
            && self.last_gains == *gains { return; }

        self.last_mode = mode;
        self.last_q = q_used;
        self.last_global_gain_db = global_gain_db;
        self.global_gain = 10.0_f32.powf(global_gain_db / 20.0);
        self.last_gains = *gains;

        for (index, band) in self.bands.iter_mut().enumerate() {
            let gain = gains[index];
            let frequency = BAND_FREQUENCIES[index];
            if mode == 1 {
                band.set_peaking(self.sample_rate, frequency, q_used, gain);
            } else if index == 0 {
                band.set_low_shelf(self.sample_rate, frequency, gain);
            } else if index == 9 {
                band.set_high_shelf(self.sample_rate, frequency, gain);
            } else {
                band.set_peaking(self.sample_rate, frequency, BAND_Q, gain);
            }
        }
    }

    /// 交错的多声道缓冲，与 Kotlin process(buffer, offset, frames, channels) 语义一致。
    pub fn process(&mut self, buffer: &mut [f32], frames: usize, channels: usize) {
        let count = frames * channels;
        for index in 0..count {
            let channel = index % channels;
            let mut sample = buffer[index];
            for band in &mut self.bands { sample = band.process(sample, channel); }
            if self.global_gain != 1.0 { sample *= self.global_gain; }
            buffer[index] = sample;
        }
    }

    pub fn is_active(&self) -> bool {
        self.bands.iter().any(|b| b.active) || (self.global_gain - 1.0).abs() > 0.0001
    }
}

// ---- 无 std 的 C ABI：桌面走 koffi 可直接加载；WASM 也能导出 ----
#[no_mangle]
pub extern "C" fn folia_eq_create() -> *mut TenBandEq {
    Box::into_raw(Box::new(TenBandEq::new()))
}

#[no_mangle]
pub unsafe extern "C" fn folia_eq_destroy(ptr: *mut TenBandEq) {
    if !ptr.is_null() { drop(Box::from_raw(ptr)); }
}

#[no_mangle]
pub unsafe extern "C" fn folia_eq_configure(ptr: *mut TenBandEq, sample_rate: i32) {
    if let Some(eq) = ptr.as_mut() { eq.configure(sample_rate); }
}

#[no_mangle]
pub unsafe extern "C" fn folia_eq_update(
    ptr: *mut TenBandEq, gains: *const f32, mode: i32, q: f32, global_gain_db: f32,
) {
    if let Some(eq) = ptr.as_mut() {
        if !gains.is_null() {
            let mut values = [0.0_f32; 10];
            for i in 0..10 { values[i] = *gains.add(i); }
            eq.update(&values, mode, q, global_gain_db);
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn folia_eq_process(
    ptr: *mut TenBandEq, buffer: *mut f32, frames: i32, channels: i32,
) {
    if let (Some(eq), Some(buf)) = (ptr.as_mut(), buffer.as_mut()) {
        if frames > 0 && channels > 0 {
            let len = frames as usize * channels as usize;
            eq.process(std::slice::from_raw_parts_mut(buf, len), frames as usize, channels as usize);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_eq_is_identity() {
        let mut eq = TenBandEq::new();
        eq.configure(48000);
        eq.update(&[0.0; 10], 0, 0.85, 0.0);
        let input = [0.1_f32, -0.2, 0.3, 0.4];
        let mut buf = input.to_vec();
        eq.process(&mut buf, 2, 2);
        for (actual, expected) in buf.iter().zip(input.iter()) {
            assert!((actual - expected).abs() < 1e-9, "flat EQ must be identity");
        }
    }

    #[test]
    fn boosted_eq_changes_signal() {
        let mut eq = TenBandEq::new();
        eq.configure(48000);
        eq.update(&[6.0; 10], 0, 0.85, 0.0);
        let mut buf = vec![0.1_f32; 128];
        eq.process(&mut buf, 128, 1);
        assert!(buf.iter().any(|s| *s > 0.11));
        assert!(eq.is_active());
    }

    #[test]
    fn peaking_and_geq_differ() {
        let gains = [3.0, -2.0, 1.0, 0.5, -1.0, 2.0, -3.0, 1.5, 0.0, 4.0];
        let mut geq = TenBandEq::new(); geq.configure(48000); geq.update(&gains, 0, 0.85, 0.0);
        let mut peq = TenBandEq::new(); peq.configure(48000); peq.update(&gains, 1, 0.85, 0.0);
        let mut a = vec![0.37_f32; 64]; let mut b = a.clone();
        geq.process(&mut a, 64, 1); peq.process(&mut b, 64, 1);
        assert!(a.iter().zip(b.iter()).any(|(x, y)| (x - y).abs() > 1e-6));
    }
}
