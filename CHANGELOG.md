# Changelog

All notable changes to Chronicle will be documented in this file.

## [0.1.3] - 2026-03-05

### Viewer
- **Task filtering**: Multi-select dropdown filter by tag and status with active filter pills
- **Inline editing**: Click-to-edit task titles and tags
- **Group by tag**: Collapsible tag sections toggle
- **Status labels**: "active" displays as "In Progress", action buttons for all statuses
- **Drag-and-drop**: Task resequencing within status groups

### Changed
- **Decomposed server.ts**: Extracted inline CSS (1859 lines) and JS (1345 lines) into separate `viewer.css` and `viewer-client.js` files, reducing server.ts from 4322 to 1064 lines
- **Code quality**: Added `broadcastTasks()` helper, `LANG_MAP` constant, `TASKS_DDL` constant, `ensureTasksTable()` helper, `VALID_STATUSES` constant

## [0.1.2] - 2026-03-03

### Viewer
- **Redesigned tree badges**: New visual design for file type and status badges
- **Legend tooltip**: Hover tooltip explaining badge colors and icons
- **Line numbers**: Added line number display in signature view
- **Layout improvements**: Refined overall viewer layout and spacing

## [0.1.1] - 2026-03-02

### Changed
- **CI: Release-triggered publishing**: Switched from tag-push to GitHub Release trigger for npm publish workflow
- **Provenance**: Added `--provenance` flag and `id-token: write` permission for npm supply chain security
- **Auto version sync**: Release tag version is now written to package.json automatically in CI

### Removed
- Demo GIF from README (replaced by static screenshot)

## [0.1.0] - 2026-03-01

Initial public release on npm as `@tensakulabs/chronicle`.

### Core
- **11 Language Support**: C#, TypeScript, JavaScript, Rust, Python, C, C++, Java, Go, PHP, Ruby
- **Tree-sitter parsing** for accurate identifier extraction
- **SQLite with WAL mode** for fast, reliable storage
- **Keyword filtering** per language (excludes language keywords from index)
- **1MB parser buffer** for large files
- **MCP Server** protocol implementation

### Search & Index
- `chronicle_init` — Index a project (with auto-cleanup of excluded files)
- `chronicle_query` — Search terms (exact/contains/starts_with) with time-based filtering (`modified_since`, `modified_before`)
- `chronicle_status` — Index statistics
- `chronicle_update` — Re-index single files (respects exclude patterns)
- `chronicle_remove` — Remove files from index

### Signatures
- `chronicle_signature` — File signature (types + methods)
- `chronicle_signatures` — Batch signatures with glob patterns

### Project Overview
- `chronicle_summary` — Project overview with auto-detected entry points
- `chronicle_tree` — File tree with statistics
- `chronicle_describe` — Generate documentation to summary.md
- `chronicle_files` — Query project files by type, with `modified_since` filter

### Cross-Project
- `chronicle_link` / `chronicle_unlink` / `chronicle_links` — Link and manage dependency projects
- `chronicle_scan` — Find all indexed projects in directory tree

### Session Management
- `chronicle_session` — Session tracking with external change detection and auto-reindex
- `chronicle_note` — Persistent session notes (write, append, read, clear)

### Interactive Viewer
- `chronicle_viewer` — Browser-based project explorer at `http://localhost:3333`
  - Interactive file tree with click navigation
  - Signature viewing (types, methods)
  - Live reload via chokidar + WebSocket
  - Syntax highlighting with highlight.js
  - Git status with cat icons (pushed, modified, staged, untracked)
  - Theme switcher

### Task Backlog
- `chronicle_task` — Task CRUD with priority, tags, descriptions, and auto-logging
- `chronicle_tasks` — List and filter tasks by status, priority, or tag
- Priorities: high, medium, low
- Statuses: backlog → active → done | cancelled
- Viewer integration with priority-colored task list

### Screenshots
- `chronicle_screenshot` — Cross-platform screenshot capture (fullscreen, active_window, window, region)
- `chronicle_windows` — List open windows for window-mode targeting
- Supports Windows (PowerShell), macOS (screencapture), Linux (maim/scrot)

### CLI & Setup
- `chronicle setup` — Auto-register as MCP server in Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code Copilot
- `chronicle unsetup` — Remove registration from all clients
- CLI commands: `scan`, `init`
- Postinstall hint after npm install

### Infrastructure
- GitHub Actions CI/CD with npm provenance
- MIT License
