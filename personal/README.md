# personal/ —— 私有定制层

这个目录是**我们自己的地盘**，存放所有"项目独有的、与第三方代码无关"的东西。

本项目是自研的，第三方代码只有一处：`packages/foliate-js/`（git submodule，MIT 协议）。
把内容放进 `personal/` **永远不会和第三方依赖的升级产生 git 冲突**。

## 约定

| 子目录 | 放什么 |
| --- | --- |
| `config/` | 应用标识（`app-identity.json`）、构建 profile、`.env.*.example` 模板 |
| `scripts/` | 环境安装、构建、打包、签名等辅助脚本 |
| `patches/` | 万不得已要改第三方代码时的补丁（`.patch`）与变更台账 `CHANGELOG.md` |
| `notes/` | 环境备忘、踩坑记录、依赖版本追踪 |
| `keystore/` | Android 签名证书（**已被 .gitignore 排除，永不提交**） |

## 改代码前的优先级

1. **能不能用配置解决？** —— 改 `personal/config/`。
2. **能不能用环境变量 / 构建 profile 解决？** —— 改 `personal/config/`。
3. **能不能加文件而不是改文件？** —— 放进 `personal/` 或 `src/`。
4. **实在不行才改第三方代码**（目前只有 foliate-js）—— 加 `// [Inkwell]` 标记，
   并登记到 `patches/CHANGELOG.md`，这样升级依赖时能立刻定位冲突。
