// dev/tools/extract-harmony-plugin-methods.mjs
// 从前端 TS 接口定义里提取各 Capacitor 插件的真实方法表，生成鸿蒙桥的 METHOD_TABLE。
//
// 为什么需要：鸿蒙桥的 JS 侧要声明每个插件有哪些方法，Capacitor core 靠 PluginHeaders
// 决定走 nativePromise 还是 nativeCallback。方法表手写会漂移 —— 之前就漏了
// FoliaPlayback.playFromQueue / requestSkip / consumeLikeOverrides，导致前端调用落空。
// 这里直接从 `interface FoliaXxxPlugin` 的成员签名提取，保证与前端契约同源。
//
// 用法：node dev/tools/extract-harmony-plugin-methods.mjs [--check]
//   默认打印 JSON 片段，可直接粘进 capacitor-harmony-bridge.js；
//   --check 比对桥文件里的 METHOD_TABLE 是否与前端一致，不一致时退出码 1（可接进门禁）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'src');
const BRIDGE = join(ROOT, '../harmony/folia/entry/src/main/resources/rawfile/capacitor-harmony-bridge.js');

/** 递归收集 src 下的 .ts/.tsx 文件 */
function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) out.push(...walk(p));
        else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
}

/** 去掉注释后再按大括号配对截取类型块 */
function sliceBlock(text, startIdx) {
    let depth = 0;
    for (let i = text.indexOf('{', startIdx); i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(startIdx, i);
        }
    }
    return null;
}

/** 去掉块注释与行注释，避免注释里的括号（Player.REPEAT_MODE_ONE(1)）被当成方法 */
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * 从类型块里提取方法名。
 * 不依赖缩进（不同文件缩进不一致），只认 `name(` / `name<` 形式的成员，
 * 并排除控制流关键字与内联对象类型里的字段（字段是 `name:` / `name?:`，不会被匹配）。
 */
function methodsOfBlock(rawBody) {
    const body = stripComments(rawBody);
    const names = new Set();
    const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'typeof', 'await', 'do', 'else', 'try']);
    const re = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        const name = m[1];
        if (KEYWORDS.has(name)) continue;
        // 排除对象字面量里的方法简写 `{ foo() {} }` 之外的误伤：只看前面不是 '.' 或 ':' 的
        const before = body.slice(Math.max(0, m.index - 1), m.index);
        if (before === '.' || before === ':') continue;
        names.add(name);
    }
    return [...names];
}

/** 从 `interface X {` 或 `type X = {` 里提取方法名 */
function methodsOfType(text, typeName) {
    const ifaceRe = new RegExp(`interface\\s+${typeName}\\s*\\{`);
    const typeRe = new RegExp(`type\\s+${typeName}\\s*=\\s*\\{`);
    let m = ifaceRe.exec(text);
    let body = null;
    if (m) {
        body = sliceBlock(text, m.index);
    } else {
        m = typeRe.exec(text);
        if (m) body = sliceBlock(text, text.indexOf('{', m.index));
    }
    if (body === null) return null;
    const methods = methodsOfBlock(body);
    return methods.length ? methods : null;
}

const files = walk(SRC);
const ifaceToPlugin = new Map([
    ['FoliaPlaybackPlugin', 'FoliaPlayback'],
    ['FoliaColorOsLyricsPlugin', 'FoliaColorOsLyrics'],
    ['FoliaLyriconPlugin', 'FoliaLyricon'],
    ['FoliaNativePlugin', 'FoliaNative'],
    ['FoliaQishuiPlugin', 'FoliaQishui'],
    ['FoliaWallpaperPlugin', 'FoliaWallpaper'],
    ['FoliaSpotifyPlugin', 'FoliaSpotify'],
    ['FoliaNativePlayerPlugin', 'FoliaNativePlayer'],
    ['FoliaAppleMusicNative', 'FoliaAppleMusic'],
    ['FoliaYtmStoreNative', 'FoliaYtm'],
]);

const table = new Map();
for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const [typeName, plugin] of ifaceToPlugin) {
        if (table.has(plugin)) continue;
        const methods = methodsOfType(text, typeName);
        if (methods && methods.length) table.set(plugin, methods);
    }
}

// 统一补齐 listener 相关方法（Capacitor 的 addListener/removeListener 在各插件都有）
for (const [plugin, methods] of table) {
    const set = new Set(methods);
    set.add('addListener');
    set.add('removeListener');
    table.set(plugin, [...set].sort());
}

const ordered = [...table.entries()].sort((a, b) => a[0].localeCompare(b[0]));

if (process.argv.includes('--check')) {
    const bridge = readFileSync(BRIDGE, 'utf8');
    const m = bridge.match(/var METHOD_TABLE = \{([\s\S]*?)\n    \};/);
    if (!m) {
        console.error('METHOD_TABLE 未找到');
        process.exit(1);
    }
    const bridgeTable = new Map();
    for (const line of m[1].split('\n')) {
        const mm = line.match(/(\w+):\s*\[(.*?)\]/);
        if (!mm) continue;
        bridgeTable.set(mm[1], mm[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).sort());
    }
    let bad = 0;
    for (const [plugin, methods] of ordered) {
        const cur = bridgeTable.get(plugin) || [];
        const missing = methods.filter((x) => !cur.includes(x));
        const extra = cur.filter((x) => !methods.includes(x));
        if (missing.length || extra.length) {
            bad++;
            console.error(`[${plugin}] 桥缺 ${missing.join(',') || '-'} / 多 ${extra.join(',') || '-'}`);
        }
    }
    for (const plugin of bridgeTable.keys()) {
        if (!table.has(plugin)) {
            bad++;
            console.error(`[${plugin}] 桥里有但前端没有`);
        }
    }
    if (bad) {
        console.error(`\nMETHOD_TABLE 与前端契约不一致（${bad} 处）`);
        process.exit(1);
    }
    console.log('METHOD_TABLE 与前端契约一致');
} else {
    const lines = ordered.map(([plugin, methods]) =>
        `        ${plugin}: [${methods.map((x) => `'${x}'`).join(',')}]`);
    console.log('    var METHOD_TABLE = {');
    console.log(lines.join(',\n'));
    console.log('    };');
}
