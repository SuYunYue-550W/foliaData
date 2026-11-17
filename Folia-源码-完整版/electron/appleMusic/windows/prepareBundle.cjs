'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Builds and verifies the Windows WebView2 Apple Music host for electron-builder (build/beforePack.cjs, build/afterPack.cjs).

// Files the host needs at run time; the .pdb, the WPF wrapper and the duplicate runtimes/ loader stay out of the package.
const WINDOWS_COMPANION_FILES = [
    'FoliaAppleMusicCompanion.exe',
    'FoliaAppleMusicCompanion.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
];

// The project targets x64 only (PlatformTarget x64); other architectures would ship a host that cannot load its loader.
function prepareWindowsCompanion({ arch, projectRoot, run = execFileSync }) {
    if (arch !== 'x64') throw new Error(`Unsupported Apple Music companion architecture: ${arch}`);
    const output = path.join(projectRoot, 'build/apple-music-native/windows');
    // The host's source has not changed since it was built, but rebuilding it needs the
    // .NET desktop SDK (Microsoft.NET.Sdk.WindowsDesktop). Not every machine that packages
    // Folia has it, so a complete set of files from an earlier build is reused as is.
    const alreadyBuilt = WINDOWS_COMPANION_FILES.every((file) => {
        try {
            return require('node:fs').statSync(path.join(output, file)).size > 0;
        } catch {
            return false;
        }
    });
    if (alreadyBuilt) {
        console.log('[apple-music] reusing the Windows companion already built in build/apple-music-native/windows');
        return output;
    }
    run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(projectRoot, 'electron/appleMusic/windows/buildCompanion.ps1')], { stdio: 'inherit' });
    return output;
}

// Fail packaging when any of the host's files did not reach resources/apple-music/windows.
async function verifyWindowsCompanion(resourcesDir) {
    const fs = require('node:fs/promises');
    const folder = path.join(resourcesDir, 'apple-music/windows');
    for (const file of WINDOWS_COMPANION_FILES) await fs.access(path.join(folder, file));
}

module.exports = { WINDOWS_COMPANION_FILES, prepareWindowsCompanion, verifyWindowsCompanion };
