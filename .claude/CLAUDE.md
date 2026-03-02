# Chronicle - CLAUDE.md

MCP Server für persistentes Code-Indexing. Ermöglicht Claude Code schnelle, präzise Suchen statt Grep/Glob.

**Version:** 1.9.0 | **Sprachen:** 11 | **Repo:** https://github.com/CSCSoftware/Chronicle

## Build & Run

```bash
npm install && npm run build    # Einmalig
npm run build                   # Nach Code-Änderungen
```

Registriert als MCP Server `chronicle` (Prefix: `mcp__chronicle__chronicle_*`).

**Claude Code** (`~/.claude/settings.json`):
```json
"mcpServers": {
  "chronicle": {
    "command": "node",
    "args": ["Q:/develop/Tools/CodeGraph/build/index.js"]
  }
}
```

**Claude Desktop** (`%APPDATA%/Claude/claude_desktop_config.json`):
```json
"mcpServers": {
  "chronicle": {
    "command": "C:\\Program Files\\nodejs\\node.exe",
    "args": ["Q:\\develop\\Tools\\CodeGraph\\build\\index.js"]
  }
}
```

**Nach Änderungen:** Build ausführen, dann Claude Code neu starten.
**MCP-Name:** Server muss als `"chronicle"` registriert sein → Prefix wird `mcp__chronicle__chronicle_*`.

## Tools (22)

### Suche & Index
| Tool | Beschreibung |
|------|--------------|
| `chronicle_init` | Projekt indexieren |
| `chronicle_query` | Terme suchen (exact/contains/starts_with), Zeit-Filter |
| `chronicle_status` | Index-Statistiken |
| `chronicle_update` | Einzelne Datei neu indexieren |
| `chronicle_remove` | Datei aus Index entfernen |

### Signaturen (statt Read!)
| Tool | Beschreibung |
|------|--------------|
| `chronicle_signature` | Datei-Signatur (Types + Methods) |
| `chronicle_signatures` | Mehrere Dateien (Glob-Pattern) |

### Projekt-Übersicht
| Tool | Beschreibung |
|------|--------------|
| `chronicle_summary` | Projekt-Übersicht mit Entry Points |
| `chronicle_tree` | Dateibaum mit Stats |
| `chronicle_describe` | Dokumentation zu summary.md |
| `chronicle_files` | Projektdateien nach Typ, `modified_since` |

### Cross-Project
| Tool | Beschreibung |
|------|--------------|
| `chronicle_link/unlink/links` | Dependencies verlinken |
| `chronicle_scan` | Indexierte Projekte finden |

### Session (v1.2+)
| Tool | Beschreibung |
|------|--------------|
| `chronicle_session` | Session starten, externe Änderungen erkennen |
| `chronicle_note` | Session-Notizen (persistiert in DB) |
| `chronicle_viewer` | Browser-Explorer mit Live-Reload (v1.3) |

### Task Backlog (v1.8+)
| Tool | Beschreibung |
|------|--------------|
| `chronicle_task` | Task CRUD + Log (create/read/update/delete/log) |
| `chronicle_tasks` | Tasks auflisten, filtern nach Status/Priority/Tag |

Status: `backlog → active → done | cancelled`

### Screenshots (v1.9+)
| Tool | Beschreibung |
|------|--------------|
| `chronicle_screenshot` | Screenshot aufnehmen (fullscreen/active_window/window/region) |
| `chronicle_windows` | Offene Fenster auflisten (Helper für window-Modus) |

## Sprachen

C# · TypeScript · JavaScript · Rust · Python · C · C++ · Java · Go · PHP · Ruby

## Architektur

```
src/
├── index.ts              # Entry Point (MCP + CLI)
├── server/
│   ├── mcp-server.ts     # MCP Protocol
│   └── tools.ts          # Tool-Handler
├── commands/             # Tool-Implementierungen
│   ├── init.ts, query.ts, signature.ts, update.ts
│   ├── summary.ts, link.ts, scan.ts, files.ts
│   ├── session.ts, note.ts, task.ts
│   ├── screenshot/              # Plattform-Screenshots
│   └── viewer/server.ts
├── db/
│   ├── database.ts       # SQLite (WAL)
│   ├── queries.ts        # Prepared Statements
│   └── schema.sql
└── parser/
    ├── tree-sitter.ts    # Parser (1MB Buffer)
    ├── extractor.ts      # Identifier + Signaturen
    └── languages/        # Keyword-Filter (11 Sprachen)
```

## Datenbank-Tabellen

| Tabelle | Inhalt |
|---------|--------|
| `files` | Dateibaum (path, hash, last_indexed) |
| `lines` | Zeilen mit line_hash, modified Timestamp |
| `items` | Indexierte Terme (case-insensitive) |
| `occurrences` | Term-Vorkommen |
| `methods` | Methoden-Prototypen |
| `types` | Klassen/Structs/Interfaces |
| `signatures` | Header-Kommentare |
| `project_files` | Alle Dateien mit Typ |
| `metadata` | Key-Value (Sessions, Notizen) |
| `tasks` | Backlog-Tasks (Priority, Status, Tags) |
| `task_log` | Task-Historie (Auto-Log bei Änderungen) |

## Wichtige Features

### Zeit-Filter (v1.1)
```
chronicle_query({ term: "render", modified_since: "2h" })
chronicle_files({ path: ".", modified_since: "30m" })
```
Formate: `30m`, `2h`, `1d`, `1w`, ISO-Datum

### Session-Notizen (v1.2)
```
chronicle_note({ path: ".", note: "Fix testen" })     # Schreiben
chronicle_note({ path: ".", append: true, note: "+" }) # Anhängen
chronicle_note({ path: "." })                          # Lesen
chronicle_note({ path: ".", clear: true })             # Löschen
```

### Interactive Viewer (v1.3)
```
chronicle_viewer({ path: "." })                        # http://localhost:3333
chronicle_viewer({ path: ".", action: "close" })
```
- Dateibaum mit Klick-Navigation
- Signaturen anzeigen
- Live-Reload (chokidar)
- Syntax-Highlighting
- Git-Status mit Katzen-Icons (v1.3.1)

### Task Backlog (v1.8)
```
chronicle_task({ path: ".", action: "create", title: "Bug fixen", priority: 1, tags: "bug" })
chronicle_task({ path: ".", action: "read", id: 1 })           # Task + Log lesen
chronicle_task({ path: ".", action: "update", id: 1, status: "done" })
chronicle_task({ path: ".", action: "log", id: 1, note: "Root cause gefunden" })
chronicle_task({ path: ".", action: "delete", id: 1 })
chronicle_tasks({ path: "." })                                  # Alle Tasks
chronicle_tasks({ path: ".", status: "active", tag: "bug" })    # Gefiltert
```
- Priority: 1=high, 2=medium (default), 3=low
- Status: backlog → active → done | cancelled
- Auto-Log bei Status-Änderungen und Task-Erstellung
- Viewer: Tasks-Tab mit Priority-Farben, Done-Toggle, Cancelled-Sektion (durchgestrichen)

### Screenshots (v1.9)
```
chronicle_screenshot()                                             # Ganzer Bildschirm
chronicle_screenshot({ mode: "active_window" })                    # Aktives Fenster
chronicle_screenshot({ mode: "window", window_title: "VS Code" })  # Bestimmtes Fenster
chronicle_screenshot({ mode: "region" })                           # Rechteck aufziehen
chronicle_screenshot({ delay: 3 })                                 # 3 Sek. warten
chronicle_windows({ filter: "chrome" })                            # Fenster finden
```
- Kein Index nötig - standalone Tool
- Cross-Platform: Windows (PowerShell), macOS (screencapture), Linux (maim/scrot)
- Default: Speichert in `os.tmpdir()/chronicle-screenshot.png` (überschreibt immer)
- Optional: `filename` und `save_path` für andere Pfade
- Rückgabe: Dateipfad → Claude kann sofort `Read` aufrufen

### Auto-Cleanup (v1.3.1)
`chronicle_init` entfernt automatisch Dateien die jetzt excluded sind (z.B. build/).
Zeigt "Files removed: N" im Ergebnis.

## CLI

```bash
node build/index.js              # MCP Server
node build/index.js scan <path>  # Projekte finden
node build/index.js init <path>  # Indexieren
```

## Implementierungsdetails

- **Tree-sitter:** 1MB Buffer für große Dateien
- **Hash-Diff:** Zeilen-Timestamps bleiben bei unverändertem Hash
- **Arrow Functions:** Werden als Methods erkannt (gewollt, etwas Noise)
- **Keyword-Filter:** Pro Sprache in `src/parser/languages/`

## Dokumentation

| Datei | Inhalt |
|-------|--------|
| `README.md` | Öffentliche Doku |
| `MCP-API-REFERENCE.md` | Vollständige API |
| `CHANGELOG.md` | Versionshistorie |
