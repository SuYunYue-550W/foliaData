# Rust EQ 试点（不进生产构建）

验证「一份 Rust DSP 三端复用」是否可行的最小实验。只实现 10 段 EQ，不改任何生产代码路径，不进 electron-builder / Gradle / Vite。

## 为什么选 EQ

全仓唯一「同一套算法、两份实现」的明显重复：

- Android：`android/app/src/main/java/top/izuna/foliamajor/player/dsp/` 下 `BiquadFilter.kt` + `TenBandEq.kt`（纯 f32 数学，RBJ Cookbook + DF2T）
- Web/桌面：`src/services/audioEffects/` 下 20+ 文件，用 Web Audio 的 `BiquadFilterNode`

Rust 版若能对齐，理论上可编成 WASM（Web）+ JNI（Android）+ cdylib（桌面走已有的 koffi 通路），一份代码三端用。

## 做了什么

- `src/lib.rs`：照搬 Kotlin 公式的 `BiquadFilter` + `TenBandEq`，全程 f32，无堆分配，带 C ABI（`folia_eq_create/update/process/...`）
- 两种产物都编得出来：
  - cdylib：149 KB DLL → 桌面可走 koffi（项目已依赖）
  - wasm32-unknown-unknown：66 KB WASM → Web 端潜力
- `test/compare.mjs`：用 `Math.fround` 逐运算模拟 Kotlin 的 f32 语义作基准，与 Rust DLL 对比 1024 个样本（GEQ、8 kHz 附近增益、总增益 -3 dB）

## 结果

```
最大绝对差: 1.788139e-7   (约 2 个 f32 ulp)
容差:        4.768372e-7  (4 ulp)
判定:        数值等价通过
```

剩余差异来自各平台 `cos/sin/pow` 的舍入不同（Rust 用 f32 libm，JS 基准是 f64 算完再 fround），不是实现错误。1.8e-7 相对满幅是 -175 dB，远低于听感阈值。

## 重要限制

- **基准不是 JVM 实测**。要接生产前，必须跑真机 Kotlin 的同一组样本再比一次。
- **「逐位相同」做不到也不必要**。项目里 WGSL 那边的红线是 ≤0.01 dB，这个误差低五个数量级。
- 本试点**没有**验证 JNI 链路（Android `build.gradle` 目前没有 NDK/CMake）、WASM 在 Android WebView 的加载兼容性（项目已有 AudioWorklet `addModule` 的坑记录）、以及 28 个可视化模式与 EQ 同时跑的性能。

## 复现

```bash
cargo test                      # 3 个单测
cargo build --release           # DLL，给 compare.mjs 用
cargo build --release --target wasm32-unknown-unknown
node test/compare.mjs           # 逐位对比
```

## 结论

技术上可行：Rust 版与现公式数值等价、两种目标都能编出、体积可接受。

是否铺开是另一回事：真正的工作量在三端接线（JNI + WASM 构建配置 + koffi），以及音色对齐的回归测试。**建议下一步只做真机 Kotlin 基准对比**，确认后再决定是否值得动生产代码。
