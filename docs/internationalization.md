# Internationalization

English | [简体中文](internationalization.zh-CN.md)

## Language behavior

Settings offers Follow system, Simplified Chinese, and English. New profiles follow the system; existing preference files without a language retain Chinese. Simplified Chinese system variants resolve to `zh-CN`; English and other unsupported locales resolve to `en`. Traditional Chinese is not silently presented as a supported translation. The UI setting is independent of the user's conversational language.

Main persists selection and broadcasts to both windows through validated IPC. Renderers initialize before showing text. Switching changes text/cache revisions without reloading the page, creating a new agent session, or clearing the conversation. Named/id form drafts, selection/focus, and identified scroll containers are preserved; composition delays redraw until IME completion.

## Resources

`src/shared/i18n/messages/en.ts` defines typed keys and parameters; `zh-CN.ts` must contain the same keys. `t()` interpolates into plain strings; DOM construction remains text-based. Unknown keys use a readable fallback and log only the key once, never values. Catalog-authored English count phrases inflect before inserting values, so user text is not rewritten. Intl handles localized dates/numbers; calendar-day arithmetic avoids daylight-saving duration errors. Native tray/menu labels use the same process-local locale.

Keep UI literals in catalogs, including accessibility names, validation text, placeholders, and empty/error states. Preserve brands, tool/protocol IDs, file paths, user text, history, and third-party output. Main-process error strings are translated when created; previously captured errors/history are not retroactively rewritten. Moving every error transport to `{code, params}` remains separate compatibility work.

Model persona and plugin instructions are deliberately independent of UI switching. Existing Chinese memory synthesis markers, matching heuristics, historical attachment markers, and retired-field migration labels are compatibility-sensitive. Do not bulk-translate these as UI text: they require bilingual model/fixture coverage and any necessary stored-data migration. Current UI translation does not establish English memory-quality parity.

## Documentation

English is the default README/document entry point; `.zh-CN.md` holds Chinese. Both link to each other. `AGENTS.md` and icon notes are bilingual single files to avoid conflicting development instructions. Historical reports retain dates, counts, evidence limits, and unrun checks. Chinese screenshots and recordings are labeled as such; translating surrounding text does not translate their pixels.

`docs/i18n-manifest.json` records reviewed file pairs and normalized SHA-256 hashes. `npm run check:i18n` checks coverage, reciprocal navigation, local file targets, and freshness; the test suite runs it too. After editing a document, review/update its counterpart before recording both new hashes. Do not regenerate hashes to bypass translation review. This check detects changes, not semantic equivalence or remote URL availability.

## Source kit and promotion

`viva-source new/test --language en|zh-CN` defaults to English. New-source templates follow the selected language; source-owned names/content remain source data. The package includes both READMEs, both template sets, and compiled shared translation resources. Runtime developer errors use English.

Promo captions use their own typed React context/resources. `Promo` defaults to English; Remotion `--props='{"locale":"zh-CN"}'` selects Chinese. Existing screenshot/video media remains Chinese and needs new capture for an entirely English recording. Installer language choices include English and Simplified Chinese; installer execution on each target platform remains an independent acceptance check.

## Verification

Run typecheck, all tests, normal five-phase smoke, and `smoke:language`. The language smoke checks setup/settings, unsaved secret draft and selection/focus preservation, repeated switching, IME deferral, a narrow window, unchanged session identity, and desktop-island synchronization. Unit tests cover locale resolution, preferences migration/persistence, IPC validation, catalogs/parameters, plurals, labels, and calendar days. Source-kit tests validate generated templates and CLI languages.

Release acceptance additionally needs macOS, actual installed-package startup/restart, active streaming/approval/error states in both languages, English screenshot/video capture, and real-model bilingual memory/plugin behavior. Do not treat fake-model or typechecking results as those checks.
