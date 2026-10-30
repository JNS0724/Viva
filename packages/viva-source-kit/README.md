# viva-source-kit

[English](README.md) · [简体中文](README.zh-CN.md)

Tools for building [Viva](https://github.com/JNS0724/Viva) message sources:

- `defineSource({ check, poll })`: reads requests, writes responses, and handles errors.
- `viva-source test <folder>`: checks a source using Viva’s own validation and runtime rules.
- `viva-source new <folder> [--template js|python|command]`: starts from a template.
- `--language en|zh-CN`: selects CLI output language; English is the default.

See [docs/sources.md](https://github.com/JNS0724/Viva/blob/main/docs/sources.md).

`dist/` is generated from app sources by `scripts/build-source-kit.mjs` before packaging. Do not edit it manually.
