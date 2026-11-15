# Folia · Integrated Enhanced Edition (foliaData)

A full-screen immersive lyrics player built on Folia-major 0.7.25. This edition adds a
dispersion-glass navigation bar and a self-developed **microRender** GPU budget scheduler,
and ships both desktop (Electron) and mobile (Capacitor) builds.

For the complete project description, the full change declaration and the algorithm
documentation, see the Chinese [README](README.md), the delivery declaration
[`声明文件-FoliaData.md`](../声明文件-FoliaData.md) and
[`microRender-算法说明.md`](../microRender-算法说明.md).

## At a glance

| Item | Value |
|---|---|
| Base project | Folia `folia-major` v0.7.25 (`0.7.25.dev2`) |
| Stack | React 19 + TypeScript 6 + Vite 8, three / R3F / pixi.js, Electron 43, Capacitor 8 |
| Visualizers | 28 modes + 6 background modes |
| License | AGPL-3.0 (see `LICENSE`) |
| Updates | Served from this repository's Releases only |

## Quick start

Requires **Node >= 24**.

```bash
npm ci
npm run dev                   # web dev server
npm run dev:electron          # desktop dev
npm run typecheck
npm run test:unit
npm run ci:local              # same gates as CI
npm run build:electron        # Windows installer
npm run build:android:debug   # Android debug APK
```

Project conventions live in `AGENTS.md` and the 12 skills under `skills/`.
The most important ones: online songs go only through `src/services/onlineMusic/omni.ts`,
never hand-write native `<button>` / `<input>` / `<select>` / `<textarea>`,
all UI strings go through the three i18n locale files, and a single file must stay under 800 lines.

## microRender in one paragraph

A frame-budget scheduling micro-kernel that never touches a shader or a render pass.
It samples real frame intervals, feeds p90 and the slow-frame ratio into a pure-function state
machine, and only then nudges the existing frame-rate / pixel-ratio master switches.
The user's setting is always the ceiling; degradation lowers frame rate before resolution,
restoration runs in reverse; two bad windows are needed to step down and six good ones to step up,
each change followed by a 2.5s / 8s cooldown. See the standalone algorithm document for details.

## License and notes

AGPL-3.0. Third-party components keep their own copyright notices, and online music,
lyrics and cover art belong to their respective rights holders. This repository is for
personal study, technical exchange and non-commercial testing only.
The bundled Windows installer is unsigned and the Android package uses a debug signature.
