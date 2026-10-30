# 开发约定

- 新增测试使用 TypeScript（`*.test.ts`）；新增源码和内部脚本优先使用 TypeScript。
- 逐步将仓库迁移到 TypeScript：修改现有 JavaScript 模块时，优先迁移本次涉及的模块、测试和内部 fixture，并保持每批改动可独立验证。不要为了改扩展名一次性重写整个仓库。
- 迁移必须补充有效类型并进入类型检查，不用 `@ts-nocheck`、新增宽泛 `any` 或关闭 strict 掩盖问题。保留现有行为与测试覆盖。
- 测试通过 Node/Electron 原生类型擦除直接运行源码，使用可擦除的 TypeScript 语法和 `import type`；源码导入保留 `.ts` 扩展名。
- 迁移期间测试和覆盖率入口必须同时发现 `.test.ts` 与尚未迁移的 `.test.js`；迁移后删除旧文件，避免重复运行或漏跑。
- 外部工具要求的 CommonJS 入口、对外发布的 JavaScript 模板和生成产物保留其必要格式；如迁移相关源文件，同时验证构建、打包和下游调用。
- 验证改动时运行相关测试及 `npm run typecheck`；测试入口或构建配置改变后，确认完整测试集合仍被发现。

## Development conventions (English)

The Chinese and English sections describe the same rules.

- Write new tests in TypeScript (`*.test.ts`); prefer TypeScript for new source and internal scripts.
- Migrate touched JavaScript modules, tests, and internal fixtures incrementally, keeping each batch independently verifiable. Do not rewrite the repository merely to change extensions.
- Add meaningful types and include migrated files in typechecking. Do not hide errors with `@ts-nocheck`, broad new `any`, or disabled strict checks. Preserve behavior and coverage.
- Tests run source directly through Node/Electron native type stripping: use erasable syntax, `import type`, and `.ts` source import extensions.
- During migration, test and coverage discovery must include both `.test.ts` and remaining `.test.js`; remove migrated duplicates.
- Keep formats required by external tools, published JavaScript templates, and generated outputs. Validate build, packaging, and downstream invocation when migrating their sources.
- Run relevant tests and `npm run typecheck`. After changing discovery/build configuration, verify the full test collection is still discovered.
