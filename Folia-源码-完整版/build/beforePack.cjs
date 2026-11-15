"use strict";

// build/beforePack.cjs
// Stages native runtimes for electron-builder's target platform and architecture.

const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

exports.default = async (context) => {
  const arch = ARCH_NAMES[context.arch];
  if (!arch)
    throw new Error(
      `Unsupported electron-builder architecture ordinal: ${context.arch}`,
    );
  const { prepareBundledFfmpeg } = await import(
    "../packaging/ffmpeg/fetch-ffmpeg.mjs"
  );
  await prepareBundledFfmpeg({ platform: context.electronPlatformName, arch });
  // The analysis models' runtime (electron/analysis/mnn.cjs), built from the pinned MNN source.
  if (context.electronPlatformName === 'win32') {
    console.log('[beforePack] win32 host build: skipping bundled MNN runtime (analysis falls back to estimator)');
    // Apple Music 的 WebView2 宿主只编 x64（csproj 的 PlatformTarget）；其它架构的包
    // 不带宿主，Apple Music 平台会如实报 runtime-unavailable，而不是让整个打包失败。
    if (arch === 'x64') {
        const { prepareWindowsCompanion } = require('../electron/appleMusic/windows/prepareBundle.cjs');
        prepareWindowsCompanion({ arch, projectRoot: context.packager.projectDir });
    } else {
        console.log(`[beforePack] ${arch}: skipping the x64-only Apple Music companion`);
    }
  } else {
    const { prepareBundledMnn } = await import("./buildMnnRuntime.mjs");
    await prepareBundledMnn({ platform: context.electronPlatformName, arch });
  }
  // The two models (Beat This! final0, htdemucs), verified against shared/modelManifest.json; one
  // file each for every platform.
  const { prepareBundledModels } = await import("./fetchModels.mjs");
  await prepareBundledModels({ outputDir: require("path").join(context.packager.projectDir, "models") });
  if (context.electronPlatformName === 'darwin') {
    const { prepareMacCompanion } = require('../electron/appleMusic/macos/prepareBundle.cjs');
    prepareMacCompanion({ arch, projectRoot: context.packager.projectDir });
    const { prepareBundledKoffi } = await import('../packaging/macos/prepare-koffi.mjs');
    await prepareBundledKoffi({ arch, projectRoot: context.packager.projectDir });
    // The wallpaper's Stage Manager click guard (issue #698), a small native helper.
    const { prepareDesktopClickGuard } = await import('../packaging/macos/build-desktop-click-guard.mjs');
    await prepareDesktopClickGuard({ arch, projectRoot: context.packager.projectDir });
  }
};
