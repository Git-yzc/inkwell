# 第三方组件与许可证声明

> 本项目**不是** Readest 的 fork，**不包含** Readest 的任何代码。
> 它复用的大型第三方组件只有 foliate-js（MIT），详见下方。
>
> 本文件列出会被打包进**发行版二进制**（Windows 安装包 / Android APK）的第三方组件。
> 按 MIT、BSD-3-Clause、Apache-2.0 的要求，分发二进制时需保留相应的版权与许可声明。

最后核对：2026-09-19

---

## 一、直接嵌入应用代码的组件

这几个库的代码会被打包进 `dist/`，进而进入安装包与 APK，**必须保留声明**。

### foliate-js

- 用途：EPUB / MOBI / FB2 等格式的解析与排版渲染内核
- 来源：https://github.com/johnfactotum/foliate-js （以 git submodule 固定到 commit `78914ae`）
- 许可证：**MIT**

```
MIT License

Copyright (c) 2022 John Factotum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> 注：`src/features/reader/engine/index.ts` 里的 `buildCss()` 参考了
> foliate-js 自带示例 `reader.js` 的 `getCSS()` 并做了改写。
> 该部分同样适用上面的 MIT 许可。

### zip.js（随 foliate-js 一起内置）

- 位置：`packages/foliate-js/vendor/zip.js`
- 用途：EPUB（zip 容器）解压
- 来源：https://github.com/gildas-lormeau/zip.js
- 许可证：**BSD-3-Clause**
- 版权：Copyright (c) 2023, Gildas Lormeau

BSD-3-Clause 要求分发时保留版权声明、条件列表与免责声明。
完整文本见 https://github.com/gildas-lormeau/zip.js/blob/master/LICENSE

### fflate（随 foliate-js 一起内置）

- 位置：`packages/foliate-js/vendor/fflate.js`
- 用途：压缩 / 解压
- 来源：https://github.com/101arrowz/fflate
- 许可证：**MIT**
- 版权：Copyright (c) 2020 Arjun Barrett

---

## 二、框架与运行时依赖

以下为直接依赖（版本以 `package.json` 与 `src-tauri/Cargo.toml` 为准）。
它们多为 MIT / Apache-2.0 / BSD 等宽松许可，分发二进制时同样建议保留声明。

### 前端（npm）

| 包 | 许可证 |
| --- | --- |
| react / react-dom | MIT |
| react-router-dom | MIT |
| zustand | MIT |
| @tauri-apps/api | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog / -fs / -opener / -os | MIT OR Apache-2.0 |

### 构建期（npm，不进入发行版）

| 包 | 许可证 |
| --- | --- |
| vite | MIT |
| @vitejs/plugin-react | MIT |
| tailwindcss / @tailwindcss/vite | MIT |
| typescript | Apache-2.0 |
| @biomejs/biome | MIT OR Apache-2.0 |
| @tauri-apps/cli | Apache-2.0 OR MIT |

### 后端（Rust）

| crate | 许可证 |
| --- | --- |
| tauri | MIT OR Apache-2.0 |
| tauri-plugin-log / -opener / -dialog / -fs / -os | Apache-2.0 OR MIT |
| serde / serde_json | MIT OR Apache-2.0 |
| log | MIT OR Apache-2.0 |
| rusqlite | MIT |
| uuid | Apache-2.0 OR MIT |
| sha2 | MIT OR Apache-2.0 |
| zip | MIT |
| quick-xml | MIT |
| thiserror | MIT OR Apache-2.0 |
| base64 | MIT OR Apache-2.0 |
| image | MIT OR Apache-2.0 |

> 以上只列**直接依赖**。传递依赖同样是宽松许可（MIT / Apache-2.0 / BSD / ISC / Zlib 等）。
> 需要完整清单时可分别运行 `pnpm licenses list` 与 `cargo about` 重新生成。

---

## 三、明确**未**包含的组件

| 组件 | 说明 |
| --- | --- |
| Readest（AGPL-3.0） | 仅作为架构参考阅读，**未复制任何代码**。见 `AGENTS.md` §1.1 |
| PDF.js（Apache-2.0） | 打包时已用桩替换（`pdf-stub.js`），未进入发行版 |
| Foliate（GTK 应用，GPL-3.0） | 未使用 |
