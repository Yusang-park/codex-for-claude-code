# Changelog

## v0.2.6 - 2026-04-27

### Fixed

- Fixed global skills configured in Claude so they are also available in `claude-codex` sessions.

### Added

- Added `gpt-5.5` as the default Codex model option.
- Added startup self-update: `claude-codex` now installs the latest npm package automatically when possible, then restarts into the updated version. If the update cannot run, it prints `npm install -g codex-for-claude-code@latest` and continues with the installed version.
