# Changelog

All notable changes to Chronicle will be documented in this file.

## [1.9.0] - 2026-02-06

### Added
- **Cross-Platform Screenshots**: New `chronicle_screenshot` tool for capturing screenshots directly from AI assistants
  - 4 capture modes: `fullscreen`, `active_window`, `window` (by title), `region` (interactive selection)
  - Cross-platform: Windows (PowerShell + .NET), macOS (screencapture), Linux (maim/scrot)
  - Multi-monitor support (select monitor by index)
  - Delay parameter (wait N seconds before capture)
  - Default: Saves to temp directory with fixed filename (overwrites for quick iteration)
  - Custom filename and save path supported
  - Returns file path so AI can immediately `Read` the image
  - No project index required - standalone utility
- **Window Listing**: New `chronicle_windows` tool to list all open windows
  - Shows title, PID, and process name
  - Optional substring filter (case-insensitive)
  - Helper for `chronicle_screenshot` mode="window"

### Technical
- New directory module: `src/commands/screenshot/` with platform-specific implementations
- Windows: PowerShell scripts written to temp .ps1 files (avoids quoting issues with inline C#)
- macOS: Uses native `screencapture` command (interactive selection built-in)
- Linux: Uses `maim` (preferred) with `scrot` fallback; `xdotool`/`wmctrl` for window operations
- Synchronous delay via `Atomics.wait` (Node >= 18)

## [1.8.1] - 2026-02-02

### Added
- **Cancelled status** for tasks: `backlog → active → done | cancelled`
  - Cancelled tasks preserved as documentation (not deleted)
  - Viewer: collapsible ❌ Cancelled section with strikethrough styling

### Fixed
- **`chronicle_update` now respects exclude patterns**: Files in `build/`, `node_modules/`, `.gitignore` patterns are rejected
  - Previously the viewer's file watcher could re-index excluded files via `chronicle_update`

### Technical
- Auto-migration: existing `tasks` table CHECK constraint updated to include `cancelled`
- Exported `DEFAULT_EXCLUDE` and `readGitignore` from `init.ts` for reuse

## [1.8.0] - 2026-02-02

### Added
- **Task Backlog**: Built-in project task management persisted in Chronicle database
  - `chronicle_task` - Create, read, update, delete tasks with priority, tags, and descriptions
  - `chronicle_tasks` - List and filter tasks by status, priority, or tag
  - **Auto-logging**: Status changes and task creation are automatically recorded in task history
  - **Manual log entries**: Add notes to any task with the `log` action
  - Priorities: high (🔴), medium (🟡), low (⚪)
  - Statuses: backlog → active → done
  - Sort order support for custom ordering within same priority
- **Viewer Tasks Tab**: Interactive task management in the browser viewer
  - Priority-colored task list grouped by status
  - Done toggle directly from the viewer
  - Tag display

### Technical
- New database tables: `tasks` and `task_log` with auto-migration
- Tasks survive between sessions (persisted in SQLite)

## [1.7.0] - 2026-02-01

### Added
- **Gemini CLI support**: `chronicle setup` now detects and registers Chronicle with Gemini CLI (`~/.gemini/settings.json`)
- **VS Code Copilot support**: `chronicle setup` now detects and registers Chronicle with VS Code (`mcp.json` with `"servers"` key and `"type": "stdio"`)

### Changed
- JSON client config is now flexible: supports custom server key (`serversKey`) and extra fields (`extraFields`) per client
- Updated README with Gemini CLI and VS Code Copilot config examples

## [1.6.1] - 2026-02-01

### Fixed
- **MCP Server version**: Now reads version dynamically from package.json (was hardcoded to 1.3.0)
- **`chronicle setup` for local installs**: Detects if `chronicle` is globally available; falls back to `node /full/path/index.js` when not installed globally

## [1.6.0] - 2026-02-01

### Added
- **Auto CLAUDE.md instructions**: `chronicle setup` now installs AI instructions in `~/.claude/CLAUDE.md`
  - Tells Claude to auto-run `chronicle_init` when no `.chronicle/` exists
  - Provides tool usage guide (prefer Chronicle over Grep/Glob)
  - `chronicle unsetup` cleanly removes the instructions block
- **Idempotent setup**: Re-running `chronicle setup` updates existing config without errors

## [1.5.2] - 2026-02-01

### Fixed
- **`chronicle setup` for Claude Code**: Uses `claude mcp add --scope user` instead of editing settings.json directly
- Claude Desktop, Cursor, Windsurf still use JSON config editing

## [1.5.1] - 2026-01-31

### Fixed
- **`chronicle setup`**: Now creates config file if client directory exists but config is missing (e.g. fresh Claude Code install)

## [1.5.0] - 2026-01-31

### Added
- **`chronicle setup`**: Auto-register Chronicle as MCP server in all detected AI clients
  - Supports: Claude Code, Claude Desktop, Cursor, Windsurf
  - Cross-platform: Windows, macOS, Linux
- **`chronicle unsetup`**: Remove Chronicle registration from all clients
- **Postinstall hint**: Shows `Run "chronicle setup"` after npm install

## [1.4.2] - 2026-01-31

### Added
- **npm package**: Published as `@tensakulabs/chronicle` on npm (`npm install -g @tensakulabs/chronicle`)
- **Dual CLI commands**: Both `chronicle` and `@tensakulabs/chronicle` work as command names
- **npm-publish.bat**: Script for easy npm publishing

### Changed
- README updated with npm install instructions

## [1.4.1] - 2026-01-31

### Fixed
- **Git Status for Subfolder Projects**: Viewer now correctly shows git status for projects that are subdirectories of a git repo (e.g., a library inside a monorepo)
  - `isGitRepo()` now uses `simpleGit().checkIsRepo()` instead of checking for `.git` directory — traverses parent dirs
  - New `toProjectRelative()` helper maps git-root-relative paths to project-relative paths
  - Files outside the project subfolder are properly filtered out

## [1.4.0] - 2026-01-31

### Breaking Changes
- **Renamed from CodeGraph to Chronicle**: Package name, MCP server name, and all internal references updated
  - MCP prefix changes from `mcp__codegraph__` to `mcp__chronicle__` (requires config update)
  - Index directory changed from `.codegraph/` to `.chronicle/`
  - Batch scripts renamed: `codegraph-scan.bat` → `chronicle-scan.bat`, `codegraph-init-all.bat` → `chronicle-init-all.bat`
  - Old `.codegraph/` directories can be safely deleted

### Added
- **Automatic Cleanup**: `chronicle_init` now removes files that became excluded (e.g., build outputs)
  - Reports `filesRemoved` count in result
  - Uses minimatch for proper glob pattern matching
- **Git Status in Viewer**: File tree now shows git status with cat icons
  - 🟢 Pushed (committed and up-to-date)
  - 🟡 Modified (uncommitted changes)
  - 🔵 Staged (added to index)
  - ⚪ Untracked (new files)
- **chronicle-init-all.bat**: New batch script to recursively index all git projects in a directory tree

### Changed
- Added minimatch dependency for exclude pattern handling
- Updated all documentation (README, CLAUDE.md, MCP-API-REFERENCE) with correct MCP prefix info

## [1.3.0] - 2026-01-27

### Added
- **Interactive Viewer**: New `chronicle_viewer` tool opens a browser-based project explorer
  - Interactive file tree (click to expand directories)
  - Click files to view signatures (types, methods)
  - Tabs: Code files / All files, Overview / Source code
  - **Live reload** with chokidar file watcher
  - WebSocket for real-time updates
  - Syntax highlighting with highlight.js
  - Runs on `http://localhost:3333`
- **Recent Files Filter**: New `modified_since` parameter for `chronicle_files`
  - Find files changed in current session: `modified_since: "30m"`
  - Supports relative time (`2h`, `1d`, `1w`) and ISO dates

### Changed
- Viewer auto-reindexes changed files before refreshing tree

### Fixed
- Server version now correctly reports 1.3.0

## [1.2.0] - 2026-01-27

### Added
- **Session Notes**: New `chronicle_note` tool to persist reminders between sessions
  - Write, append, read, and clear notes
  - Stored in SQLite database (survives restarts)
  - Use cases: handover notes, test reminders, context for next session
- **Session Tracking**: New `chronicle_session` tool for automatic session management
  - Detects new sessions (>5 min since last activity)
  - Records session start/end times
  - Detects files modified externally (outside sessions)
  - Auto-reindexes changed files on session start
  - Returns session note if one exists

### Changed
- Database schema: Added `metadata` table for key-value storage (session times, notes)

## [1.1.0] - 2026-01-27

### Added
- **Time-based Filtering**: New `modified_since` and `modified_before` parameters for `chronicle_query`
  - Relative time: `30m`, `2h`, `1d`, `1w`
  - ISO dates: `2026-01-27` or `2026-01-27T14:30:00`
  - Track line-level changes across updates
- **Project Structure**: New `chronicle_files` tool to query all project files
  - File types: `code`, `config`, `doc`, `asset`, `test`, `other`, `dir`
  - Glob pattern filtering
  - Statistics by file type

### Changed
- `chronicle_init` now indexes complete project structure (all files, not just code)
- `chronicle_update` preserves modification timestamps for unchanged lines (hash-based diff)
- Path normalization to forward slashes across all commands

### Technical
- New `project_files` table in database schema
- New `line_hash` and `modified` columns in `lines` table
- Hash-based change detection for accurate timestamps

## [1.0.0] - 2026-01-27

### Added
- **11 Language Support**: C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby
- **Core Tools**:
  - `chronicle_init` - Index a project
  - `chronicle_query` - Search terms (exact/contains/starts_with)
  - `chronicle_signature` - Get file signatures (methods, types)
  - `chronicle_signatures` - Batch signatures with glob patterns
  - `chronicle_update` - Re-index single files
  - `chronicle_remove` - Remove files from index
  - `chronicle_summary` - Project overview with auto-detected entry points
  - `chronicle_tree` - File tree with statistics
  - `chronicle_describe` - Add documentation to summary
  - `chronicle_status` - Index statistics
- **Cross-Project Support**:
  - `chronicle_link` - Link dependency projects
  - `chronicle_unlink` - Remove linked projects
  - `chronicle_links` - List all linked projects
- **Discovery**:
  - `chronicle_scan` - Find all indexed projects in directory tree
  - CLI commands: `scan`, `init`
- **Technical**:
  - Tree-sitter parsing for accurate identifier extraction
  - SQLite with WAL mode for fast, reliable storage
  - Keyword filtering per language (excludes language keywords from index)
  - 1MB parser buffer for large files

### Infrastructure
- MCP Server protocol implementation
- MIT License
- Comprehensive documentation
