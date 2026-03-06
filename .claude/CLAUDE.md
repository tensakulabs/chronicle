# Chronicle - CLAUDE.md

MCP Server for persistent code indexing. Gives AI assistants instant access to your codebase through pre-built indexes. 50x less context than grep.

**Version:** 0.1.6 | **Languages:** 11 | **Repo:** https://github.com/tensakulabs/chronicle

## Build & Run

```bash
npm install && npm run build    # First time
npm run build                   # After code changes
```

Registered as MCP Server `chronicle` (Prefix: `mcp__chronicle__chronicle_*`).

**Claude Code** (`~/.claude/settings.json`):
```json
"mcpServers": {
  "chronicle": {
    "type": "stdio",
    "command": "chronicle",
    "env": {}
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
"mcpServers": {
  "chronicle": {
    "command": "chronicle"
  }
}
```

**After changes:** Run build, then restart Claude Code.
**MCP Name:** Server must be registered as `"chronicle"` -> Prefix becomes `mcp__chronicle__chronicle_*`.

## Tools (22)

### Search & Index
| Tool | Description |
|------|-------------|
| `chronicle_init` | Index a project |
| `chronicle_query` | Search terms (exact/contains/starts_with), time filter |
| `chronicle_status` | Index statistics |
| `chronicle_update` | Re-index a single file |
| `chronicle_remove` | Remove file from index |

### Signatures (instead of Read!)
| Tool | Description |
|------|-------------|
| `chronicle_signature` | File signature (Types + Methods) |
| `chronicle_signatures` | Multiple files (glob pattern) |

### Project Overview
| Tool | Description |
|------|-------------|
| `chronicle_summary` | Project overview with entry points |
| `chronicle_tree` | File tree with stats |
| `chronicle_describe` | Documentation to summary.md |
| `chronicle_files` | Project files by type, `modified_since` |

### Cross-Project
| Tool | Description |
|------|-------------|
| `chronicle_link/unlink/links` | Link dependencies |
| `chronicle_scan` | Find indexed projects |

### Session (v1.2+)
| Tool | Description |
|------|-------------|
| `chronicle_session` | Start session, detect external changes |
| `chronicle_note` | Session notes (persisted in DB) |
| `chronicle_viewer` | Browser explorer with live reload (v1.3) |

### Task Backlog (v1.8+)
| Tool | Description |
|------|-------------|
| `chronicle_task` | Task CRUD + Log (create/read/update/delete/log) |
| `chronicle_tasks` | List tasks, filter by status/priority/tag |

Status: `backlog -> active -> done | cancelled`

### Screenshots (v1.9+)
| Tool | Description |
|------|-------------|
| `chronicle_screenshot` | Take screenshot (fullscreen/active_window/window/region) |
| `chronicle_windows` | List open windows (helper for window mode) |

## Languages

C# · TypeScript · JavaScript · Rust · Python · C · C++ · Java · Go · PHP · Ruby

## Architecture

```
src/
├── index.ts              # Entry Point (MCP + CLI)
├── server/
│   ├── mcp-server.ts     # MCP Protocol
│   └── tools.ts          # Tool Handler
├── commands/             # Tool Implementations
│   ├── init.ts, query.ts, signature.ts, update.ts
│   ├── summary.ts, link.ts, scan.ts, files.ts
│   ├── session.ts, note.ts, task.ts
│   ├── screenshot/              # Platform Screenshots
│   └── viewer/server.ts
├── db/
│   ├── database.ts       # SQLite (WAL)
│   ├── queries.ts        # Prepared Statements
│   └── schema.sql
└── parser/
    ├── tree-sitter.ts    # Parser (1MB Buffer)
    ├── extractor.ts      # Identifier + Signatures
    └── languages/        # Keyword Filters (11 Languages)
```

## Database Tables

| Table | Contents |
|-------|----------|
| `files` | File tree (path, hash, last_indexed) |
| `lines` | Lines with line_hash, modified timestamp |
| `items` | Indexed terms (case-insensitive) |
| `occurrences` | Term occurrences |
| `methods` | Method prototypes |
| `types` | Classes/Structs/Interfaces |
| `signatures` | Header comments |
| `project_files` | All files with type |
| `metadata` | Key-Value (sessions, notes) |
| `tasks` | Backlog tasks (priority, status, tags) |
| `task_log` | Task history (auto-log on changes) |

## Key Features

### Time Filter (v1.1)
```
chronicle_query({ term: "render", modified_since: "2h" })
chronicle_files({ path: ".", modified_since: "30m" })
```
Formats: `30m`, `2h`, `1d`, `1w`, ISO date

### Session Notes (v1.2)
```
chronicle_note({ path: ".", note: "Test the fix" })        # Write
chronicle_note({ path: ".", append: true, note: "+" })     # Append
chronicle_note({ path: "." })                               # Read
chronicle_note({ path: ".", clear: true })                  # Clear
```

### Interactive Viewer (v1.3)
```
chronicle_viewer({ path: "." })                        # http://localhost:3333
chronicle_viewer({ path: ".", action: "close" })
```
- File tree with click navigation
- Signature display
- Live reload (chokidar)
- Syntax highlighting
- Git status icons (v1.3.1)

### Task Backlog (v1.8)
```
chronicle_task({ path: ".", action: "create", title: "Fix bug", priority: 1, tags: "bug" })
chronicle_task({ path: ".", action: "read", id: 1 })           # Read task + log
chronicle_task({ path: ".", action: "update", id: 1, status: "done" })
chronicle_task({ path: ".", action: "log", id: 1, note: "Root cause found" })
chronicle_task({ path: ".", action: "delete", id: 1 })
chronicle_tasks({ path: "." })                                  # All tasks
chronicle_tasks({ path: ".", status: "active", tag: "bug" })    # Filtered
```
- Priority: 1=high, 2=medium (default), 3=low
- Status: backlog -> active -> done | cancelled
- Auto-log on status changes and task creation
- Viewer: Tasks tab with priority colors, done toggle, cancelled section (strikethrough)

### Screenshots (v1.9)
```
chronicle_screenshot()                                             # Full screen
chronicle_screenshot({ mode: "active_window" })                    # Active window
chronicle_screenshot({ mode: "window", window_title: "VS Code" })  # Specific window
chronicle_screenshot({ mode: "region" })                           # Draw rectangle
chronicle_screenshot({ delay: 3 })                                 # 3 sec delay
chronicle_windows({ filter: "chrome" })                            # Find windows
```
- No index needed - standalone tool
- Cross-platform: Windows (PowerShell), macOS (screencapture), Linux (maim/scrot)
- Default: Saves to `os.tmpdir()/chronicle-screenshot.png` (overwrites each time)
- Optional: `filename` and `save_path` for custom paths
- Returns: File path so Claude can immediately call `Read`

### Auto-Cleanup (v1.3.1)
`chronicle_init` automatically removes files that are now excluded (e.g. build/).
Shows "Files removed: N" in results.

## CLI

```bash
node build/index.js              # MCP Server
node build/index.js scan <path>  # Find projects
node build/index.js init <path>  # Index project
```

## Implementation Details

- **Tree-sitter:** 1MB buffer for large files
- **Hash-Diff:** Line timestamps preserved when hash unchanged
- **Arrow Functions:** Detected as methods (intentional, slight noise)
- **Keyword Filter:** Per language in `src/parser/languages/`

## Documentation

| File | Contents |
|------|----------|
| `README.md` | Public docs |
| `MCP-API-REFERENCE.md` | Complete API reference |
| `CHANGELOG.md` | Version history |
