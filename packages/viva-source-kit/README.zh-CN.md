# viva-source-kit

[English](README.md) | 简体中文

写 [Viva](https://github.com/JNS0724/Viva) 消息源用的小工具：

- `defineSource({ check, poll })`：消息源程序的运行时，读请求、写回答、处理出错
- `viva-source test <文件夹>`：用 Viva 自己的校验代码，按 Viva 的方式跑一遍
- `viva-source new <文件夹> [--template js|python|command]`：从模板开始

完整说明见 Viva 仓库的 [docs/sources.md](https://github.com/JNS0724/Viva/blob/main/docs/sources.md)。

`dist/` 由 Viva 仓库的 `scripts/build-source-kit.mjs` 从 app 源码生成（打包前自动运行），不要手改。
