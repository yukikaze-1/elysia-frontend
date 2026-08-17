# 第三方组件声明 / THIRD-PARTY NOTICES

本目录（`src/renderer/src/live2d/`、`src/renderer/public/live2d/`）vendored 了 Live2D Cubism Web SDK 5-r.5 的部分组件。各组件遵循各自的许可协议，使用前请阅读原文。

来源：Live2D Cubism SDK for Web 5-r.5（`third_party/CubismSdkForWeb-5-r.5/`）。本 vendor 未对源码本体做任何修改。

## 1. Cubism Core（`src/renderer/public/live2d/live2dcubismcore.min.js`、`src/renderer/src/live2d/core/live2dcubismcore.d.ts`）

- 许可：**Live2D Proprietary Software License**（专有软件许可，非开源）
- 版权：Copyright(c) Live2D Inc. All rights reserved.
- 官方链接：
  - <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
  - <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_jp.html>
- 原文随附于 SDK：`Core/LICENSE.md`

## 2. Cubism Web Framework（`src/renderer/src/live2d/framework/`，59 个 .ts）

- 许可：**Live2D Open Software License**（开放软件许可；商业使用者需另行取得 Cubism SDK Release License，见下）
- 版权：Copyright(c) Live2D Inc. All rights reserved.
- 官方链接：
  - <https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html>
  - <https://www.live2d.com/eula/live2d-open-software-license-agreement_jp.html>
- 原文随附于本 vendor：`framework/LICENSE.md`（即 SDK `Framework/LICENSE.md`）
- 商业许可（年营收 ≥ 1000 万日元的企业必须取得）：<https://www.live2d.com/en/download/cubism-sdk/release-license/>

## 3. Cubism WebGL Shaders（`src/renderer/public/live2d/shaders/`，13 文件）

- 随 Cubism Web Framework 一并提供，适用 **Live2D Open Software License**（同第 2 节）。
- 来源目录：SDK `Framework/Shaders/WebGL/`

## 4. 模型资源（尚未 vendored；后续阶段引入时另行声明）

- Live2D 官方示例模型（如 Haru/Hiyori）适用 **Free Material License**（无偿提供素材使用授权）。
- 官方链接：<https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html>

---

本文件由 Cyrene 阶段 5 批次 A Task 1（SDK vendoring）维护；任何第三方组件新增/升级须同步更新本声明。
