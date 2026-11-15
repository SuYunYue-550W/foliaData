'use strict';

const path = require('node:path');

// Keep release resource paths separate from development outputs and explicit developer overrides.
function resolveNativeExecutable({ platform, isPackaged, resourcesPath, projectRoot, override = '', arch = 'x64' }) {
    if (platform !== 'darwin' && platform !== 'win32') return '';
    if (!isPackaged && override) return path.isAbsolute(override) ? override : '';
    const root = isPackaged ? path.join(resourcesPath, 'apple-music') : path.join(projectRoot, 'build/apple-music-native');
    // 打包态由 extraResources 放到 apple-music/FoliaAppleMusicCompanion.app；开发态
    // prepareBundle.cjs 按目标架构输出到 build/apple-music-native/darwin-${arch}/。
    return platform === 'darwin'
        ? path.join(root, isPackaged ? '' : `darwin-${arch}`, 'FoliaAppleMusicCompanion.app/Contents/MacOS/FoliaAppleMusicCompanion')
        : path.join(root, 'windows/FoliaAppleMusicCompanion.exe');
}

module.exports = { resolveNativeExecutable };
