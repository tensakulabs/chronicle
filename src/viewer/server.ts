/**
 * Chronicle Viewer - Local HTTP Server with WebSocket
 * Opens an interactive project tree in the browser
 *
 * Features:
 * - Tab-based navigation (Code/All files, Overview/Code view)
 * - Session change indicators (modified/new files)
 * - Syntax highlighting with highlight.js
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { exec } from 'child_process';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import chokidar, { FSWatcher } from 'chokidar';
import { openDatabase, createQueries } from '../db/index.js';
import { update as updateIndex } from '../commands/update.js';
import { getGitStatus, GitStatusInfo, GitFileStatus } from './git-status.js';
import { PRODUCT_NAME, INDEX_DIR } from '../constants.js';
import type Database from 'better-sqlite3';

const PORT = 3333;

let server: ReturnType<typeof createServer> | null = null;
let wss: WebSocketServer | null = null;
let fileWatcher: FSWatcher | null = null;
let viewerDbPath: string | null = null;
let viewerDb: ReturnType<typeof openDatabase> | null = null;

interface ViewerMessage {
    type: 'getTree' | 'getSignature' | 'getFileContent' | 'getTasks' | 'updateTaskStatus' | 'createTask';
    mode?: 'code' | 'all';  // Tree mode
    path?: string;
    file?: string;
    taskId?: number;
    status?: string;
    title?: string;
    priority?: number;
    tags?: string;
    description?: string;
}

interface TreeNode {
    name: string;
    path: string;
    type: 'dir' | 'file';
    fileType?: string;  // code, config, doc, asset, test, other
    children?: TreeNode[];
    stats?: {
        items: number;
        methods: number;
        types: number;
    };
    status?: 'modified' | 'new' | 'unchanged';  // Session change status
    gitStatus?: GitFileStatus;  // Git status for cat icon coloring
}

interface SessionChangeInfo {
    modified: Set<string>;
    new: Set<string>;
}

export async function startViewer(projectPath: string): Promise<string> {
    // Check if already running
    if (server) {
        return `Viewer already running at http://localhost:${PORT}`;
    }

    const dbPath = path.join(projectPath, INDEX_DIR, 'index.db');
    viewerDbPath = dbPath;
    viewerDb = openDatabase(dbPath, true); // readonly for queries
    const sqlite = viewerDb.getDb();
    const queries = createQueries(viewerDb);
    const projectRoot = path.resolve(projectPath);
    const absoluteProjectPath = path.resolve(projectPath); // For updateIndex

    // Track files changed - initialize with DB session changes, then add live changes
    const dbSessionChanges = detectSessionChanges(sqlite);
    const viewerSessionChanges: SessionChangeInfo = {
        modified: new Set(dbSessionChanges.modified),
        new: new Set(dbSessionChanges.new)
    };

    console.error('[Viewer] Session changes from DB:', viewerSessionChanges.modified.size, 'modified,', viewerSessionChanges.new.size, 'new');

    // Git status - fetch once at startup, refresh on file changes
    let cachedGitInfo: GitStatusInfo | undefined;
    const refreshGitStatus = async () => {
        const newInfo = await getGitStatus(projectPath);
        // If refresh returned a degraded result (had remote before, now claims none due to
        // spawn errors like EBADF), preserve the previous state rather than overwriting
        if (cachedGitInfo?.hasRemote && !newInfo.hasRemote && newInfo.fileStatuses.size === 0 && newInfo.isGitRepo) {
            console.error('[Viewer] Git status refresh returned degraded result, keeping previous state');
            return;
        }
        cachedGitInfo = newInfo;
        console.error('[Viewer] Git status:', cachedGitInfo.isGitRepo ? 'repo' : 'no-repo',
            cachedGitInfo.hasRemote ? 'with-remote' : 'no-remote',
            cachedGitInfo.fileStatuses.size, 'files with status');
    };
    await refreshGitStatus();

    const app = express();
    server = createServer(app);
    wss = new WebSocketServer({ server });

    // File watcher for live reload
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChanges: Set<string> = new Set();  // Files changed since last broadcast

    const broadcastTreeUpdate = async () => {
        if (!wss) return;

        // Re-index changed files before refreshing the tree
        if (pendingChanges.size > 0) {
            console.error('[Viewer] Re-indexing', pendingChanges.size, 'changed file(s)');
            for (const changedFile of pendingChanges) {
                // Convert absolute path to relative path
                const relativePath = path.relative(projectRoot, changedFile).replace(/\\/g, '/');
                try {
                    // updateIndex opens its own DB connection with write access
                    const result = updateIndex({ path: absoluteProjectPath, file: relativePath });
                    console.error('[Viewer] Re-indexed:', relativePath, result.success ? '✓' : '✗');
                    // Track as modified in viewer session
                    viewerSessionChanges.modified.add(relativePath);
                } catch (err) {
                    console.error('[Viewer] Failed to re-index:', relativePath, err);
                }
            }
            pendingChanges.clear();
        }

        // Refresh git status on file changes
        await refreshGitStatus();

        // Build fresh trees for both modes using viewer session tracking
        const freshDb = openDatabase(dbPath, true);
        let codeTree, allTree;
        try {
            codeTree = await buildTree(freshDb.getDb(), projectPath, 'code', viewerSessionChanges, cachedGitInfo);
            allTree = await buildTree(freshDb.getDb(), projectPath, 'all', viewerSessionChanges, cachedGitInfo);
        } finally {
            freshDb.close();
        }

        // Broadcast to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'refresh', codeTree, allTree }));
            }
        });

        console.error('[Viewer] Broadcast tree update to', wss.clients.size, 'clients');
    };

    // Use chokidar for reliable cross-platform file watching
    fileWatcher = chokidar.watch(projectRoot, {
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            `**/${INDEX_DIR}/**`,
            '**/build/**',
            '**/dist/**'
        ],
        ignoreInitial: true,
        persistent: true
    });

    fileWatcher.on('ready', () => {
        console.error('[Viewer] Chokidar ready, watching for changes');
    });

    fileWatcher.on('error', (error: unknown) => {
        console.error('[Viewer] Chokidar error:', error);
    });

    fileWatcher.on('all', (event: string, filePath: string) => {
        console.error('[Viewer] Chokidar event:', event, filePath);

        // Track changed files for re-indexing (only for change/add events on code files)
        if ((event === 'change' || event === 'add') && /\.(ts|tsx|js|jsx|cs|rs|py|c|cpp|h|hpp|java|go|php|rb)$/i.test(filePath)) {
            pendingChanges.add(filePath);
        }

        // Debounce: wait 500ms after last change before broadcasting
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            console.error('[Viewer] Broadcasting after debounce');
            broadcastTreeUpdate();
        }, 500);
    });

    console.error('[Viewer] Initializing chokidar for', projectRoot);

    // Serve static HTML
    app.get('/', (req, res) => {
        res.send(getViewerHTML(projectPath));
    });

    // Debug endpoint to manually trigger refresh
    app.get('/refresh', async (req, res) => {
        await broadcastTreeUpdate();
        res.send('Refresh triggered');
    });

    // WebSocket handling
    wss.on('connection', (ws: WebSocket) => {
        console.error('[Viewer] Client connected');

        ws.on('message', async (data: Buffer) => {
            try {
                const msg: ViewerMessage = JSON.parse(data.toString());

                if (msg.type === 'getTree') {
                    const mode = msg.mode || 'code';
                    const freshDb = openDatabase(dbPath, true);
                    try {
                        const tree = await buildTree(freshDb.getDb(), projectPath, mode, viewerSessionChanges, cachedGitInfo);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'tree', mode, data: tree }));
                        }
                    } finally {
                        freshDb.close();
                    }
                }
                else if (msg.type === 'getSignature' && msg.file) {
                    const freshDb = openDatabase(dbPath, true);
                    try {
                        const signature = await getFileSignature(freshDb.getDb(), msg.file);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'signature', file: msg.file, data: signature }));
                        }
                    } finally {
                        freshDb.close();
                    }
                }
                else if (msg.type === 'getFileContent' && msg.file) {
                    const content = getFileContent(projectRoot, msg.file);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'fileContent', file: msg.file, data: content }));
                    }
                }
                else if (msg.type === 'getTasks') {
                    const freshDb = openDatabase(dbPath, true);
                    try {
                        const taskData = getTasksFromDb(freshDb.getDb());
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'tasks', data: taskData }));
                        }
                    } finally {
                        freshDb.close();
                    }
                }
                else if (msg.type === 'updateTaskStatus' && msg.taskId && msg.status) {
                    const taskData = updateTaskStatus(msg.taskId as number, msg.status as string);
                    if (taskData) {
                        // Broadcast updated task list to all clients
                        wss!.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
                            }
                        });
                    }
                }
                else if (msg.type === 'createTask' && msg.title) {
                    const taskData = createTaskInDb(
                        msg.title,
                        msg.priority || 2,
                        msg.tags || '',
                        msg.description || ''
                    );
                    if (taskData) {
                        // Broadcast updated task list to all clients
                        wss!.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
                            }
                        });
                    }
                }
            } catch (err) {
                console.error('[Viewer] Error:', err);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'error', message: String(err) }));
                }
            }
        });

        ws.on('close', () => {
            console.error('[Viewer] Client disconnected');
        });

        // Send initial tree (code files only)
        const initDb = openDatabase(dbPath, true);
        buildTree(initDb.getDb(), projectPath, 'code', viewerSessionChanges, cachedGitInfo).then(tree => {
            initDb.close();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'tree', mode: 'code', data: tree }));
            }
        }).catch(err => {
            initDb.close();
            console.error('[Viewer] Failed to build initial tree:', err);
        });
    });

    return new Promise((resolve, reject) => {
        server!.listen(PORT, () => {
            const url = `http://localhost:${PORT}`;
            console.error(`[Viewer] Server running at ${url}`);

            // Open browser
            openBrowser(url);

            resolve(`Viewer opened at ${url}`);
        });

        server!.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                resolve(`Port ${PORT} already in use - viewer may already be running at http://localhost:${PORT}`);
            } else {
                reject(err);
            }
        });
    });
}

/**
 * Broadcast task updates to all connected viewer clients.
 * Called from task.ts after create/update/delete operations.
 */
export function broadcastTaskUpdate(): void {
    if (!wss || !viewerDbPath) return;

    try {
        const freshDb = openDatabase(viewerDbPath, false);
        const taskData = getTasksFromDb(freshDb.getDb());
        freshDb.close();

        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
            }
        });
        console.error('[Viewer] Broadcast task update to', wss.clients.size, 'clients');
    } catch (err) {
        console.error('[Viewer] Failed to broadcast task update:', err);
    }
}

export function stopViewer(): string {
    if (server) {
        fileWatcher?.close();
        fileWatcher = null;
        wss?.close();
        viewerDb?.close();
        viewerDb = null;
        viewerDbPath = null;
        server.close();
        server = null;
        wss = null;
        return 'Viewer stopped';
    }
    return 'Viewer was not running';
}

function openBrowser(url: string) {
    const platform = process.platform;
    let cmd: string;

    if (platform === 'win32') {
        cmd = `start "" "${url}"`;
    } else if (platform === 'darwin') {
        cmd = `open "${url}"`;
    } else {
        cmd = `xdg-open "${url}"`;
    }

    exec(cmd, (err) => {
        if (err) console.error('[Viewer] Failed to open browser:', err);
    });
}

/**
 * Detect files changed in the current session
 * Uses last_indexed timestamps vs session start time
 */
function detectSessionChanges(db: Database.Database): SessionChangeInfo {
    const changes: SessionChangeInfo = {
        modified: new Set(),
        new: new Set()
    };

    try {
        // Get session start time from metadata
        const sessionStartRow = db.prepare(
            `SELECT value FROM metadata WHERE key = 'current_session_start'`
        ).get() as { value: string } | undefined;

        if (!sessionStartRow) {
            // No session tracking yet - all files are "unchanged"
            return changes;
        }

        const sessionStart = parseInt(sessionStartRow.value, 10);

        // Find files indexed AFTER session start (not AT session start)
        // This ensures a fresh re-index doesn't mark everything as modified
        const recentlyIndexed = db.prepare(`
            SELECT path, last_indexed,
                   (SELECT COUNT(*) FROM lines l WHERE l.file_id = f.id) as line_count
            FROM files f
            WHERE last_indexed > ?
        `).all(sessionStart) as Array<{ path: string; last_indexed: number; line_count: number }>;

        for (const file of recentlyIndexed) {
            // Heuristic: if file has very few lines, it might be new
            // But we can't really distinguish new vs modified without more metadata
            // For now, mark all recently indexed files as "modified"
            changes.modified.add(file.path);
        }
    } catch {
        // Silently fail
    }

    return changes;
}

async function buildTree(
    db: Database.Database,
    projectPath: string,
    mode: 'code' | 'all',
    sessionChanges: SessionChangeInfo,
    gitInfo?: GitStatusInfo
): Promise<TreeNode> {
    let files: Array<{ path: string; items: number; methods: number; types: number; fileType?: string }>;

    if (mode === 'code') {
        // Only indexed code files (original behavior)
        files = db.prepare(`
            SELECT f.path,
                   COUNT(DISTINCT o.item_id) as items,
                   (SELECT COUNT(*) FROM methods m WHERE m.file_id = f.id) as methods,
                   (SELECT COUNT(*) FROM types t WHERE t.file_id = f.id) as types
            FROM files f
            LEFT JOIN lines l ON l.file_id = f.id
            LEFT JOIN occurrences o ON o.file_id = f.id AND o.line_id = l.id
            GROUP BY f.id
            ORDER BY f.path
        `).all() as Array<{ path: string; items: number; methods: number; types: number }>;
    } else {
        // All project files from project_files table
        const projectFiles = db.prepare(`
            SELECT path, type as fileType FROM project_files WHERE type != 'dir' ORDER BY path
        `).all() as Array<{ path: string; fileType: string }>;

        // Get stats for indexed files
        const statsMap = new Map<string, { items: number; methods: number; types: number }>();
        const indexedStats = db.prepare(`
            SELECT f.path,
                   COUNT(DISTINCT o.item_id) as items,
                   (SELECT COUNT(*) FROM methods m WHERE m.file_id = f.id) as methods,
                   (SELECT COUNT(*) FROM types t WHERE t.file_id = f.id) as types
            FROM files f
            LEFT JOIN lines l ON l.file_id = f.id
            LEFT JOIN occurrences o ON o.file_id = f.id AND o.line_id = l.id
            GROUP BY f.id
        `).all() as Array<{ path: string; items: number; methods: number; types: number }>;

        for (const stat of indexedStats) {
            statsMap.set(stat.path, { items: stat.items, methods: stat.methods, types: stat.types });
        }

        files = projectFiles.map(f => ({
            path: f.path,
            fileType: f.fileType,
            items: statsMap.get(f.path)?.items || 0,
            methods: statsMap.get(f.path)?.methods || 0,
            types: statsMap.get(f.path)?.types || 0
        }));
    }

    const root: TreeNode = {
        name: path.basename(path.resolve(projectPath)),
        path: '',
        type: 'dir',
        children: []
    };

    for (const file of files) {
        const parts = file.path.split('/');
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            const currentPath = parts.slice(0, i + 1).join('/');

            let child = current.children?.find(c => c.name === part);

            if (!child) {
                child = {
                    name: part,
                    path: currentPath,
                    type: isFile ? 'file' : 'dir',
                    fileType: isFile ? file.fileType : undefined,
                    children: isFile ? undefined : [],
                    stats: isFile ? { items: file.items, methods: file.methods, types: file.types } : undefined,
                    status: isFile ? getFileStatus(file.path, sessionChanges) : undefined,
                    gitStatus: isFile && gitInfo?.isGitRepo ? getGitFileStatus(file.path, gitInfo) : undefined
                };
                current.children?.push(child);
            }

            current = child;
        }
    }

    // Sort: directories first, then alphabetically
    sortTree(root);
    return root;
}

function getFileStatus(filePath: string, changes: SessionChangeInfo): 'modified' | 'new' | 'unchanged' {
    if (changes.modified.has(filePath)) return 'modified';
    if (changes.new.has(filePath)) return 'new';
    return 'unchanged';
}

function getGitFileStatus(filePath: string, gitInfo: GitStatusInfo): GitFileStatus {
    const status = gitInfo.fileStatuses.get(filePath);
    if (status) return status;
    // File is tracked and clean - show as pushed (green) if remote exists, otherwise committed (blue)
    return gitInfo.hasRemote ? 'pushed' : 'committed';
}

function sortTree(node: TreeNode) {
    if (node.children) {
        node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        node.children.forEach(sortTree);
    }
}

async function getFileSignature(db: Database.Database, filePath: string): Promise<object> {
    // Prevent path traversal in DB lookups
    if (filePath.includes('..')) {
        return { error: 'Access denied: invalid path' };
    }

    const file = db.prepare(`SELECT id FROM files WHERE path = ?`).get(filePath) as { id: number } | undefined;

    if (!file) {
        return { error: 'File not found in index' };
    }

    const signature = db.prepare(`SELECT header_comments FROM signatures WHERE file_id = ?`).get(file.id) as { header_comments: string } | undefined;
    const methods = db.prepare(`
        SELECT prototype, line_number, visibility, is_static, is_async
        FROM methods WHERE file_id = ? ORDER BY line_number
    `).all(file.id) as Array<{ prototype: string; line_number: number; visibility: string; is_static: number; is_async: number }>;
    const types = db.prepare(`
        SELECT name, kind, line_number
        FROM types WHERE file_id = ? ORDER BY line_number
    `).all(file.id) as Array<{ name: string; kind: string; line_number: number }>;

    return {
        header: signature?.header_comments || null,
        methods: methods.map(m => ({
            prototype: m.prototype,
            line: m.line_number,
            visibility: m.visibility,
            static: !!m.is_static,
            async: !!m.is_async
        })),
        types: types.map(t => ({
            name: t.name,
            kind: t.kind,
            line: t.line_number
        }))
    };
}

/**
 * Get file content for the Code tab
 */
function getFileContent(projectRoot: string, filePath: string): { content: string; language: string } | { error: string } {
    const resolvedRoot = path.resolve(projectRoot);
    const fullPath = path.resolve(path.join(projectRoot, filePath));

    // Prevent path traversal
    if (!fullPath.startsWith(resolvedRoot + path.sep) && fullPath !== resolvedRoot) {
        return { error: 'Access denied: path outside project' };
    }

    if (!existsSync(fullPath)) {
        return { error: 'File not found' };
    }

    try {
        const content = readFileSync(fullPath, 'utf-8');
        const language = getLanguageFromExtension(filePath);
        return { content, language };
    } catch (err) {
        return { error: `Failed to read file: ${err}` };
    }
}

/**
 * Map file extension to highlight.js language identifier
 */
function getLanguageFromExtension(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
        '.ts': 'typescript',
        '.tsx': 'typescript',
        '.js': 'javascript',
        '.jsx': 'javascript',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
        '.cs': 'csharp',
        '.rs': 'rust',
        '.py': 'python',
        '.pyw': 'python',
        '.c': 'c',
        '.h': 'c',
        '.cpp': 'cpp',
        '.cc': 'cpp',
        '.cxx': 'cpp',
        '.hpp': 'cpp',
        '.hxx': 'cpp',
        '.java': 'java',
        '.go': 'go',
        '.php': 'php',
        '.rb': 'ruby',
        '.rake': 'ruby',
        '.json': 'json',
        '.xml': 'xml',
        '.html': 'html',
        '.htm': 'html',
        '.css': 'css',
        '.scss': 'scss',
        '.less': 'less',
        '.yaml': 'yaml',
        '.yml': 'yaml',
        '.md': 'markdown',
        '.sql': 'sql',
        '.sh': 'bash',
        '.bash': 'bash',
        '.bat': 'batch',
        '.ps1': 'powershell',
        '.toml': 'toml',
        '.ini': 'ini',
        '.cfg': 'ini'
    };
    return langMap[ext] || 'plaintext';
}

/**
 * Get tasks from the database for the viewer
 */
function getTasksFromDb(db: Database.Database): unknown[] {
    try {
        // Ensure tasks table exists (auto-migration)
        db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
                status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
                tags TEXT,
                source TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );
        `);
        return db.prepare(
            `SELECT * FROM tasks ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 END, priority ASC, sort_order ASC, created_at DESC`
        ).all();
    } catch {
        return [];
    }
}

/**
 * Update a task's status from the viewer
 */
function updateTaskStatus(taskId: number, status: string): unknown[] | null {
    const validStatuses = ['backlog', 'active', 'done', 'cancelled'];
    if (!validStatuses.includes(status) || !viewerDbPath) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false); // writable connection
        const db = writeDb.getDb();
        const now = Date.now();
        const completedAt = (status === 'done' || status === 'cancelled') ? now : null;
        db.prepare(
            `UPDATE tasks SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`
        ).run(status, now, completedAt, taskId);

        // Auto-log status change
        db.prepare(
            `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
        ).run(taskId, `Status changed to: ${status} (via Viewer)`, now);

        // Read back tasks on same writable connection (guaranteed to see the write)
        const taskData = getTasksFromDb(db);
        writeDb.close();
        return taskData;
    } catch (err) {
        console.error('[Viewer] Failed to update task status:', err);
        return null;
    }
}

/**
 * Create a new task from the viewer
 */
function createTaskInDb(title: string, priority: number, tags: string, description: string): unknown[] | null {
    if (!viewerDbPath) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false);
        const db = writeDb.getDb();
        const now = Date.now();

        // Ensure tasks table exists
        db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
                status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog', 'active', 'done', 'cancelled')),
                tags TEXT,
                source TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER
            );
        `);

        const result = db.prepare(
            `INSERT INTO tasks (title, description, priority, status, tags, source, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, 'backlog', ?, 'viewer', 0, ?, ?)`
        ).run(title, description || null, priority, tags || null, now, now);

        // Auto-log creation
        db.prepare(
            `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
        ).run(result.lastInsertRowid, 'Task created (via Viewer)', now);

        const taskData = getTasksFromDb(db);
        writeDb.close();
        return taskData;
    } catch (err) {
        console.error('[Viewer] Failed to create task:', err);
        return null;
    }
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getViewerHTML(projectPath: string): string {
    const projectName = escapeHtml(path.basename(path.resolve(projectPath)));

    return `<!DOCTYPE html>
<html lang="en" data-theme="observatory">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(PRODUCT_NAME)} · ${projectName}</title>

    <!-- Google Fonts: IBM Plex Sans (UI) + JetBrains Mono (code) -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@300;400;500&display=swap" rel="stylesheet">

    <!-- highlight.js: tokyo-night-dark theme -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.0/styles/tokyo-night-dark.min.css">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.0/highlight.min.js"></script>

    <style>
        /* ============================================================
           THEME DEFINITIONS
           ============================================================ */

        /* Observatory — dense dark scientific instrument */
        :root,
        [data-theme="observatory"] {
            --bg-primary:    #0d1117;
            --bg-secondary:  #161b22;
            --bg-tertiary:   #21262d;
            --bg-elevated:   #282e36;
            --text-primary:  #e6edf3;
            --text-secondary:#8b949e;
            --text-muted:    #484f58;
            --accent:        #58a6ff;
            --accent-warm:   #d29922;
            --accent-green:  #3fb950;
            --accent-red:    #f85149;
            --accent-purple: #bc8cff;
            --border:        #30363d;
            --border-subtle: #21262d;

            --scrollbar-track: #0d1117;
            --scrollbar-thumb: #30363d;
            --scrollbar-thumb-hover: #484f58;

            --header-height: 44px;
            --tree-width: 280px;
            --splitter-width: 6px;
            --tab-height: 38px;
        }

        /* Polar — clean light scientific */
        [data-theme="polar"] {
            --bg-primary:    #ffffff;
            --bg-secondary:  #f6f8fa;
            --bg-tertiary:   #eaeef2;
            --bg-elevated:   #dde3ea;
            --text-primary:  #1a2028;
            --text-secondary:#57606a;
            --text-muted:    #9aa0a8;
            --accent:        #0969da;
            --accent-warm:   #bf8700;
            --accent-green:  #1a7f37;
            --accent-red:    #cf222e;
            --accent-purple: #7c3aed;
            --border:        #d0d7de;
            --border-subtle: #eaeef2;

            --scrollbar-track: #f6f8fa;
            --scrollbar-thumb: #d0d7de;
            --scrollbar-thumb-hover: #9aa0a8;
        }

        /* Amber — warm dark charcoal */
        [data-theme="amber"] {
            --bg-primary:    #1a1610;
            --bg-secondary:  #211d15;
            --bg-tertiary:   #2a2418;
            --bg-elevated:   #342e1f;
            --text-primary:  #eddcb0;
            --text-secondary:#b09868;
            --text-muted:    #5c4f30;
            --accent:        #d4a017;
            --accent-warm:   #e8891a;
            --accent-green:  #7aad6b;
            --accent-red:    #d45f4e;
            --accent-purple: #a07ad4;
            --border:        #3d3420;
            --border-subtle: #2a2418;

            --scrollbar-track: #1a1610;
            --scrollbar-thumb: #3d3420;
            --scrollbar-thumb-hover: #5c4f30;
        }

        /* ============================================================
           RESET & BASE
           ============================================================ */

        *,
        *::before,
        *::after {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        html,
        body {
            height: 100%;
            overflow: hidden;
        }

        body {
            font-family: 'IBM Plex Sans', system-ui, sans-serif;
            font-size: 13px;
            line-height: 1.5;
            background: var(--bg-primary);
            color: var(--text-primary);
            display: flex;
            flex-direction: column;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }

        /* ============================================================
           SCROLLBAR STYLING
           ============================================================ */

        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        ::-webkit-scrollbar-track {
            background: var(--scrollbar-track);
        }
        ::-webkit-scrollbar-thumb {
            background: var(--scrollbar-thumb);
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--scrollbar-thumb-hover);
        }

        * {
            scrollbar-width: thin;
            scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
        }

        :focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
            border-radius: 2px;
        }

        /* ============================================================
           HEADER
           ============================================================ */

        #app-header {
            height: var(--header-height);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 0;
            padding: 0 14px;
            background: var(--bg-secondary);
            border-bottom: 1px solid var(--border);
            user-select: none;
            position: relative;
            z-index: 100;
        }

        .header-wordmark {
            font-family: 'IBM Plex Sans', sans-serif;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--accent);
            flex-shrink: 0;
        }

        .header-sep {
            color: var(--text-muted);
            font-size: 16px;
            font-weight: 300;
            margin: 0 10px;
            flex-shrink: 0;
        }

        .header-project {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }

        .header-project-icon {
            width: 14px;
            height: 14px;
            color: var(--text-secondary);
            flex-shrink: 0;
        }

        .header-project-icon svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }

        .header-project-name {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary);
            letter-spacing: 0.01em;
        }

        .header-stats {
            font-size: 11px;
            color: var(--text-muted);
            letter-spacing: 0.02em;
            margin-left: 12px;
            flex-shrink: 0;
        }

        .header-session {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 11px;
            color: var(--accent-warm);
            margin-left: 10px;
            flex-shrink: 0;
        }

        .header-session-dot {
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--accent-warm);
            flex-shrink: 0;
            animation: pulse-dot 2s ease-in-out infinite;
        }

        @keyframes pulse-dot {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
        }

        .header-spacer {
            flex: 1;
        }

        #cmd-palette-trigger {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            background: var(--bg-primary);
            border: 1px solid var(--border);
            border-radius: 6px;
            cursor: pointer;
            font-size: 11px;
            color: var(--text-muted);
            font-family: 'IBM Plex Sans', sans-serif;
            transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            letter-spacing: 0.02em;
            flex-shrink: 0;
            margin-right: 8px;
        }

        #cmd-palette-trigger:hover {
            background: var(--bg-elevated);
            border-color: var(--accent);
            color: var(--text-secondary);
        }

        .cmd-palette-trigger-label {
            color: var(--text-muted);
            font-size: 11px;
        }

        .cmd-palette-trigger-kbd {
            display: flex;
            align-items: center;
            gap: 2px;
            font-size: 10px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 3px;
            padding: 1px 5px;
        }

        /* ============================================================
           MAIN LAYOUT CONTAINER
           ============================================================ */

        #app-container {
            display: flex;
            flex: 1;
            overflow: hidden;
            min-height: 0;
        }

        /* ============================================================
           TREE PANEL (LEFT)
           ============================================================ */

        #tree-panel {
            width: var(--tree-width);
            flex-shrink: 0;
            display: flex;
            flex-direction: column;
            background: var(--bg-secondary);
            border-right: 1px solid var(--border);
            overflow: hidden;
            min-width: 160px;
            max-width: 600px;
        }

        #tree-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 10px;
            border-bottom: 1px solid var(--border-subtle);
            flex-shrink: 0;
            background: var(--bg-secondary);
        }

        .tree-filter-label {
            font-size: 10px;
            font-weight: 500;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .tree-info-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            border: 1px solid var(--border);
            font-size: 9px;
            font-weight: 600;
            color: var(--text-muted);
            cursor: help;
            flex-shrink: 0;
            font-family: 'IBM Plex Sans', sans-serif;
            transition: color 0.15s ease, border-color 0.15s ease;
            position: relative;
        }

        .tree-info-icon:hover {
            color: var(--text-secondary);
            border-color: var(--text-muted);
        }

        .tree-info-tooltip {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            left: 50%;
            transform: translateX(-50%);
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 8px 10px;
            font-size: 11px;
            font-weight: 400;
            letter-spacing: normal;
            text-transform: none;
            color: var(--text-secondary);
            white-space: nowrap;
            z-index: 100;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            line-height: 1.5;
        }

        .tree-info-icon:hover .tree-info-tooltip {
            display: block;
        }

        .tree-filter-pills {
            display: flex;
            flex-shrink: 0;
            border: 1px solid var(--border);
            border-radius: 5px;
            overflow: hidden;
        }

        .tree-filter-pill {
            padding: 2px 10px;
            border-radius: 0;
            font-size: 10px;
            font-weight: 500;
            letter-spacing: 0.04em;
            cursor: pointer;
            border: none;
            border-right: 1px solid var(--border);
            background: transparent;
            color: var(--text-muted);
            font-family: 'IBM Plex Sans', sans-serif;
            transition: background 0.15s ease, color 0.15s ease;
            text-transform: uppercase;
        }

        .tree-filter-pill:last-child {
            border-right: none;
        }

        .tree-filter-pill:hover {
            background: var(--bg-elevated);
            color: var(--text-secondary);
        }

        .tree-filter-pill.active {
            background: var(--accent);
            color: #fff;
        }

        #tree-scroll {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            padding: 4px 0;
        }

        .tree-node {
            display: flex;
            align-items: center;
            gap: 0;
            height: 24px;
            padding-right: 8px;
            cursor: pointer;
            position: relative;
            white-space: nowrap;
            transition: background 0.1s ease;
        }

        .tree-node:hover {
            background: var(--bg-elevated);
        }

        .tree-node.selected {
            background: var(--bg-elevated);
        }

        .tree-node.selected::before {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 2px;
            background: var(--accent);
            border-radius: 0 1px 1px 0;
        }

        .tree-indent {
            display: inline-block;
            flex-shrink: 0;
        }

        .tree-toggle {
            width: 14px;
            height: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            color: var(--text-muted);
            font-size: 9px;
            font-family: 'JetBrains Mono', monospace;
            transition: color 0.15s ease;
        }

        .tree-toggle.is-open::after {
            content: 'v';
        }

        .tree-toggle.is-closed::after {
            content: '>';
        }

        .tree-toggle.leaf {
            /* spacer for files */
        }

        .tree-status-dot {
            width: 5px;
            height: 5px;
            border-radius: 50%;
            flex-shrink: 0;
            margin: 0 5px 0 4px;
        }

        .tree-status-dot.status-unchanged {
            background: var(--accent-green);
            opacity: 0.35;
        }

        .tree-status-dot.status-modified {
            background: var(--accent-warm);
        }

        .tree-status-dot.status-new {
            background: var(--accent);
        }

        .tree-status-dot.no-dot {
            background: transparent;
        }

        .tree-git-dot {
            width: 5px;
            height: 5px;
            border-radius: 1px;
            flex-shrink: 0;
            margin: 0 5px 0 0;
            transform: rotate(45deg);
        }

        .tree-git-dot.git-untracked  { background: var(--text-muted); opacity: 0.5; }
        .tree-git-dot.git-modified   { background: var(--accent-warm); }
        .tree-git-dot.git-committed  { background: var(--accent); }
        .tree-git-dot.git-pushed     { background: var(--accent-green); }
        .tree-git-dot.git-none       { background: transparent; }

        .tree-label {
            font-size: 12px;
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            transition: color 0.1s ease;
        }

        .tree-node.dir .tree-label {
            color: var(--text-secondary);
            font-weight: 500;
        }

        .tree-node.file .tree-label {
            color: var(--text-primary);
            font-weight: 400;
        }

        .tree-node.selected .tree-label {
            color: var(--text-primary);
        }

        .tree-badges {
            display: inline-flex;
            gap: 4px;
            flex-shrink: 0;
            margin-left: auto;
            padding-left: 8px;
        }

        .tree-badge {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            font-weight: 500;
            letter-spacing: 0.02em;
            flex-shrink: 0;
            padding: 1px 5px;
            border-radius: 3px;
            line-height: 1.4;
        }

        .tree-badge-m {
            color: var(--accent);
            background: color-mix(in srgb, var(--accent) 12%, transparent);
        }

        .tree-badge-t {
            color: var(--accent-purple);
            background: color-mix(in srgb, var(--accent-purple) 12%, transparent);
        }

        .tree-children {
        }

        .tree-children.collapsed {
            display: none;
        }

        /* ============================================================
           SPLITTER
           ============================================================ */

        #splitter {
            width: var(--splitter-width);
            flex-shrink: 0;
            background: var(--border-subtle);
            cursor: col-resize;
            transition: background 0.15s ease;
            position: relative;
        }

        #splitter:hover,
        #splitter.dragging {
            background: var(--accent);
        }

        #splitter::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 2px;
            height: 24px;
            border-radius: 1px;
            background: var(--border);
            transition: background 0.15s ease;
        }

        #splitter:hover::before,
        #splitter.dragging::before {
            background: rgba(255,255,255,0.3);
        }

        /* ============================================================
           DETAIL PANEL (RIGHT)
           ============================================================ */

        #detail-panel {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            background: var(--bg-primary);
            min-width: 0;
        }

        #detail-tab-bar {
            display: flex;
            align-items: stretch;
            height: var(--tab-height);
            border-bottom: 1px solid var(--border);
            background: var(--bg-secondary);
            flex-shrink: 0;
            gap: 0;
            padding: 0 16px;
        }

        .detail-tab {
            display: flex;
            align-items: center;
            padding: 0 14px;
            font-weight: 500;
            color: var(--text-muted);
            cursor: pointer;
            border: none;
            background: none;
            border-bottom: 2px solid transparent;
            transition: color 0.15s ease, border-color 0.15s ease;
            white-space: nowrap;
            font-family: 'IBM Plex Sans', sans-serif;
            text-transform: uppercase;
            font-size: 10px;
            letter-spacing: 0.08em;
        }

        .detail-tab:hover {
            color: var(--text-secondary);
        }

        .detail-tab.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 16px;
            height: 16px;
            background: var(--bg-elevated);
            border-radius: 8px;
            font-size: 9px;
            font-family: 'JetBrains Mono', monospace;
            color: var(--text-muted);
            margin-left: 6px;
            padding: 0 4px;
        }

        .detail-tab.active .tab-badge {
            background: var(--accent);
            color: #fff;
        }

        .tab-bar-spacer {
            flex: 1;
        }

        .tab-bar-context {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 10px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
            letter-spacing: 0.02em;
        }

        .tab-bar-context .context-sep {
            color: var(--border);
        }

        .tab-bar-context .context-filename {
            color: var(--text-secondary);
            font-weight: 500;
        }

        #file-header-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 20px;
            border-bottom: 1px solid var(--border-subtle);
            background: var(--bg-secondary);
            flex-shrink: 0;
            min-height: 36px;
        }

        #file-header-bar.hidden {
            display: none;
        }

        .file-breadcrumb {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            font-family: 'JetBrains Mono', monospace;
            flex: 1;
            overflow: hidden;
            min-width: 0;
        }

        .breadcrumb-dir {
            color: var(--text-muted);
            white-space: nowrap;
        }

        .breadcrumb-sep {
            color: var(--text-muted);
            font-size: 10px;
            flex-shrink: 0;
        }

        .breadcrumb-file {
            color: var(--text-primary);
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .file-stat-pills {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-shrink: 0;
        }

        .file-stat-pill {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            letter-spacing: 0.04em;
            padding: 2px 7px;
            border-radius: 10px;
            border: 1px solid var(--border);
            color: var(--text-muted);
            background: var(--bg-tertiary);
        }

        .file-stat-pill.methods { border-color: var(--accent); color: var(--accent); }
        .file-stat-pill.types   { border-color: var(--accent-purple); color: var(--accent-purple); }

        #detail-content {
            flex: 1;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }

        .detail-view {
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            display: none;
            padding: 20px;
        }

        .detail-view.active {
            display: flex;
            flex-direction: column;
        }

        #source-view {
            padding: 0;
        }

        /* ---- Empty State ---- */
        .empty-state {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 10px;
            color: var(--text-muted);
            padding: 40px;
            text-align: center;
        }

        .empty-state-icon {
            width: 32px;
            height: 32px;
            opacity: 0.25;
        }

        .empty-state-icon svg {
            width: 32px;
            height: 32px;
            fill: currentColor;
        }

        .empty-state-label {
            font-size: 12px;
            font-weight: 400;
            letter-spacing: 0.03em;
            color: var(--text-muted);
        }

        .empty-state-hint {
            font-size: 11px;
            color: var(--text-muted);
            opacity: 0.6;
        }

        .loading-state {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--text-muted);
            font-size: 11px;
            padding: 20px;
        }

        .loading-dot {
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: var(--text-muted);
            animation: loading-bounce 1.4s ease-in-out infinite;
        }
        .loading-dot:nth-child(2) { animation-delay: 0.2s; }
        .loading-dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes loading-bounce {
            0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
            40%            { opacity: 1;   transform: scale(1); }
        }

        /* ============================================================
           SIGNATURE VIEW COMPONENTS
           ============================================================ */

        .sig-section {
            margin-bottom: 24px;
        }

        .sig-section-title {
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-muted);
            margin-bottom: 8px;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--border-subtle);
        }

        .sig-header-comment {
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            line-height: 1.6;
            color: var(--accent-green);
            background: var(--bg-secondary);
            border-left: 2px solid var(--accent-green);
            padding: 12px 14px;
            border-radius: 0 4px 4px 0;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .sig-method-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .sig-method-item {
            display: flex;
            align-items: baseline;
            gap: 8px;
            padding: 7px 12px;
            border-radius: 4px;
            background: var(--bg-secondary);
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            transition: background 0.1s ease;
        }

        .sig-method-item:hover {
            background: var(--bg-elevated);
        }

        .sig-method-line {
            font-size: 10px;
            color: var(--text-muted);
            min-width: 32px;
            text-align: right;
            flex-shrink: 0;
            font-family: 'JetBrains Mono', monospace;
        }

        .sig-method-visibility {
            font-size: 9px;
            padding: 1px 6px;
            border-radius: 3px;
            background: rgba(188, 140, 255, 0.12);
            color: var(--accent-purple);
            border: 1px solid rgba(188, 140, 255, 0.25);
            flex-shrink: 0;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        .sig-method-modifier {
            font-size: 9px;
            color: var(--accent-warm);
            flex-shrink: 0;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        .sig-method-proto {
            color: var(--text-primary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
            min-width: 0;
        }

        .sig-type-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .sig-type-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 7px 12px;
            border-radius: 4px;
            background: var(--bg-secondary);
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            transition: background 0.1s ease;
        }

        .sig-type-item:hover {
            background: var(--bg-elevated);
        }

        .sig-type-line {
            font-size: 10px;
            color: var(--text-muted);
            min-width: 32px;
            text-align: right;
            flex-shrink: 0;
        }

        .sig-type-kind {
            font-size: 9px;
            padding: 1px 6px;
            border-radius: 3px;
            background: rgba(210, 153, 34, 0.12);
            color: var(--accent-warm);
            border: 1px solid rgba(210, 153, 34, 0.25);
            flex-shrink: 0;
            letter-spacing: 0.04em;
            text-transform: uppercase;
        }

        .sig-type-name {
            color: var(--text-primary);
            font-weight: 500;
        }

        /* ============================================================
           SOURCE VIEW (CODE)
           ============================================================ */

        #source-view .code-container {
            flex: 1;
            overflow: auto;
            min-height: 0;
            display: flex;
        }

        .source-line-numbers {
            flex-shrink: 0;
            padding: 20px 0;
            text-align: right;
            user-select: none;
            font-family: 'JetBrains Mono', monospace;
            font-size: 12px;
            line-height: 1.6;
            color: var(--text-muted);
            opacity: 0.5;
            background: var(--bg-primary);
            padding-left: 16px;
            padding-right: 12px;
            border-right: 1px solid var(--border-subtle);
        }

        .source-line-numbers span {
            display: block;
        }

        #source-view pre {
            margin: 0;
            padding: 20px;
            padding-left: 16px;
            font-size: 12px;
            line-height: 1.6;
            tab-size: 4;
            flex: 1;
            min-width: 0;
        }

        #source-view code {
            font-family: 'JetBrains Mono', monospace;
        }

        .hljs {
            background: var(--bg-primary) !important;
        }

        /* ============================================================
           TASKS VIEW
           ============================================================ */

        .task-section-label {
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-muted);
            margin: 0 0 8px 0;
            padding-bottom: 6px;
            border-bottom: 1px solid var(--border-subtle);
        }

        .task-section-label:not(:first-child) {
            margin-top: 24px;
        }

        .task-list {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 8px;
        }

        .task-item {
            padding: 10px 14px 10px 12px;
            background: var(--bg-secondary);
            border-radius: 4px;
            border-left: 2px solid var(--text-muted);
            transition: background 0.1s ease;
        }

        .task-item:hover {
            background: var(--bg-elevated);
        }

        .task-item.priority-1 { border-left-color: var(--accent-red); }
        .task-item.priority-2 { border-left-color: var(--accent-warm); }
        .task-item.priority-3 { border-left-color: var(--text-muted); }

        .task-item.status-done      { opacity: 0.55; }
        .task-item.status-cancelled { opacity: 0.4; text-decoration: line-through; }

        .task-item-header {
            display: flex;
            align-items: flex-start;
            gap: 8px;
        }

        .task-title {
            font-size: 12px;
            font-weight: 500;
            color: var(--text-primary);
            flex: 1;
            min-width: 0;
        }

        .task-status-badge {
            font-size: 9px;
            padding: 2px 6px;
            border-radius: 3px;
            border: 1px solid var(--border);
            color: var(--text-muted);
            white-space: nowrap;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            font-family: 'JetBrains Mono', monospace;
            flex-shrink: 0;
        }

        .task-status-badge.status-active     { color: var(--accent-green);  border-color: var(--accent-green); }
        .task-status-badge.status-backlog    { color: var(--text-muted);    border-color: var(--border); }
        .task-status-badge.status-done       { color: var(--text-muted);    border-color: var(--border); }
        .task-status-badge.status-cancelled  { color: var(--accent-red);    border-color: var(--accent-red); }

        .task-description {
            font-size: 11px;
            color: var(--text-secondary);
            margin-top: 4px;
            line-height: 1.5;
        }

        .task-meta-row {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-top: 6px;
        }

        .task-tags {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
        }

        .task-tag {
            font-size: 9px;
            padding: 1px 6px;
            border-radius: 3px;
            background: rgba(88, 166, 255, 0.1);
            color: var(--accent);
            border: 1px solid rgba(88, 166, 255, 0.2);
            font-family: 'JetBrains Mono', monospace;
        }

        .task-actions {
            display: flex;
            gap: 4px;
            margin-top: 8px;
        }

        .task-btn {
            padding: 2px 10px;
            font-size: 10px;
            font-family: 'IBM Plex Sans', sans-serif;
            font-weight: 500;
            border: 1px solid var(--border);
            border-radius: 4px;
            background: var(--bg-tertiary);
            color: var(--text-secondary);
            cursor: pointer;
            letter-spacing: 0.03em;
            transition: background 0.1s ease, color 0.1s ease, border-color 0.1s ease;
        }

        .task-btn:hover {
            background: var(--bg-elevated);
            color: var(--text-primary);
        }

        .task-btn.btn-done:hover {
            background: var(--accent-green);
            border-color: var(--accent-green);
            color: #fff;
        }

        .task-btn.btn-cancel:hover {
            background: var(--accent-red);
            border-color: var(--accent-red);
            color: #fff;
        }

        .task-done-toggle {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 10px;
            color: var(--text-muted);
            cursor: pointer;
            user-select: none;
            padding: 6px 0;
            margin-top: 16px;
            transition: color 0.15s ease;
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }

        .task-done-toggle:hover {
            color: var(--text-secondary);
        }

        .task-done-toggle::before {
            content: '>';
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            transition: transform 0.15s ease;
            display: inline-block;
        }

        .task-done-toggle.open::before {
            transform: rotate(90deg);
        }

        .task-done-list {
            margin-top: 6px;
        }

        .task-done-list.collapsed {
            display: none;
        }

        #tasks-filter-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--border-subtle);
        }

        .tasks-filter-label {
            font-size: 10px;
            color: var(--text-muted);
            letter-spacing: 0.06em;
            text-transform: uppercase;
        }

        .tasks-group-toggle {
            display: flex;
            border: 1px solid var(--border);
            border-radius: 4px;
            overflow: hidden;
        }

        .tasks-group-btn {
            padding: 3px 10px;
            font-size: 10px;
            font-family: 'IBM Plex Sans', sans-serif;
            font-weight: 500;
            border: none;
            background: var(--bg-secondary);
            color: var(--text-muted);
            cursor: pointer;
            letter-spacing: 0.04em;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .tasks-group-btn + .tasks-group-btn {
            border-left: 1px solid var(--border);
        }

        .tasks-group-btn.active {
            background: var(--accent-purple);
            color: #fff;
        }

        .tasks-group-btn:not(.active):hover {
            background: var(--bg-elevated);
            color: var(--text-primary);
        }

        /* ============================================================
           COMMAND PALETTE OVERLAY
           ============================================================ */

        #cmd-palette-overlay {
            position: fixed;
            inset: 0;
            z-index: 9999;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding-top: 80px;
            background: rgba(0, 0, 0, 0.55);
            backdrop-filter: blur(4px);
            -webkit-backdrop-filter: blur(4px);
            transition: opacity 0.15s ease;
        }

        #cmd-palette-overlay.hidden {
            display: none;
        }

        #cmd-palette {
            width: 600px;
            max-width: calc(100vw - 40px);
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 10px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255,255,255,0.04);
            overflow: hidden;
            display: flex;
            flex-direction: column;
            max-height: calc(100vh - 160px);
        }

        #cmd-palette-input-wrap {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 14px 16px;
            border-bottom: 1px solid var(--border);
            flex-shrink: 0;
        }

        .cmd-palette-search-icon {
            width: 14px;
            height: 14px;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .cmd-palette-search-icon svg {
            width: 14px;
            height: 14px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
        }

        #cmd-palette-input {
            flex: 1;
            background: transparent;
            border: none;
            outline: none;
            font-size: 14px;
            font-family: 'IBM Plex Sans', sans-serif;
            color: var(--text-primary);
            caret-color: var(--accent);
        }

        #cmd-palette-input::placeholder {
            color: var(--text-muted);
        }

        #cmd-palette-results {
            overflow-y: auto;
            max-height: 360px;
            padding: 6px 0;
        }

        .cmd-result-section-label {
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-muted);
            padding: 8px 16px 4px;
        }

        .cmd-result-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 16px;
            cursor: pointer;
            transition: background 0.1s ease;
        }

        .cmd-result-item:hover,
        .cmd-result-item.focused {
            background: var(--bg-secondary);
        }

        .cmd-result-icon {
            width: 14px;
            height: 14px;
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .cmd-result-icon svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }

        .cmd-result-name {
            flex: 1;
            font-size: 13px;
            color: var(--text-primary);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-family: 'JetBrains Mono', monospace;
        }

        .cmd-result-path {
            font-size: 11px;
            color: var(--text-muted);
            font-family: 'JetBrains Mono', monospace;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 220px;
        }

        #cmd-palette-empty {
            padding: 24px 16px;
            text-align: center;
            font-size: 12px;
            color: var(--text-muted);
        }

        #cmd-palette-footer {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 8px 16px;
            border-top: 1px solid var(--border);
            background: var(--bg-secondary);
            flex-shrink: 0;
        }

        .cmd-palette-hint {
            display: flex;
            align-items: center;
            gap: 5px;
            font-size: 10px;
            color: var(--text-muted);
        }

        .cmd-palette-hint kbd {
            font-family: 'JetBrains Mono', monospace;
            font-size: 9px;
            padding: 1px 5px;
            border-radius: 3px;
            border: 1px solid var(--border);
            background: var(--bg-elevated);
            color: var(--text-secondary);
        }

        /* ============================================================
           THEME SWITCHER
           ============================================================ */

        #theme-switcher {
            position: relative;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            font-family: 'IBM Plex Sans', sans-serif;
            user-select: none;
            flex-shrink: 0;
        }

        #theme-panel {
            display: none;
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            z-index: 9999;
            background: var(--bg-elevated);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 8px;
            min-width: 148px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        }

        #theme-panel.open {
            display: block;
        }

        #theme-switcher-label {
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-muted);
            padding: 2px 6px 6px;
        }

        .theme-btn {
            display: flex;
            align-items: center;
            gap: 8px;
            width: 100%;
            padding: 5px 8px;
            border-radius: 5px;
            border: none;
            background: transparent;
            color: var(--text-secondary);
            font-size: 12px;
            font-family: 'IBM Plex Sans', sans-serif;
            cursor: pointer;
            text-align: left;
            transition: background 0.1s ease, color 0.1s ease;
        }

        .theme-btn:hover {
            background: var(--bg-secondary);
            color: var(--text-primary);
        }

        .theme-btn.active {
            background: var(--bg-secondary);
            color: var(--text-primary);
            font-weight: 600;
        }

        .theme-swatch {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            flex-shrink: 0;
            border: 1px solid rgba(255,255,255,0.15);
        }

        .theme-swatch.swatch-observatory { background: #58a6ff; }
        .theme-swatch.swatch-polar       { background: #0969da; }
        .theme-swatch.swatch-amber       { background: #d4a017; }

        #theme-gear-btn {
            width: 28px;
            height: 28px;
            border-radius: 6px;
            border: none;
            background: transparent;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-muted);
            transition: color 0.15s ease, background 0.15s ease;
        }

        #theme-gear-btn:hover {
            color: var(--text-secondary);
            background: var(--bg-tertiary);
        }

        #theme-gear-btn svg {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }

        /* ============================================================
           UTILITY CLASSES
           ============================================================ */

        .hidden {
            display: none !important;
        }

        .mono {
            font-family: 'JetBrains Mono', monospace;
        }

        .rule {
            height: 1px;
            background: var(--border-subtle);
            margin: 16px 0;
        }

    </style>
</head>
<body>

    <!-- HEADER -->
    <header id="app-header">
        <span class="header-wordmark">${escapeHtml(PRODUCT_NAME)}</span>
        <span class="header-sep">&middot;</span>
        <div class="header-project">
            <span class="header-project-icon">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                </svg>
            </span>
            <span class="header-project-name" id="header-project-name">${projectName}</span>
        </div>
        <span class="header-stats" id="header-stats">&mdash; files &middot; &mdash; lang</span>
        <div class="header-session hidden" id="header-session">
            <span class="header-session-dot"></span>
            <span id="header-session-count">0 changed</span>
        </div>
        <div class="header-spacer"></div>
        <button id="cmd-palette-trigger" aria-label="Open command palette (Cmd+K)">
            <span class="cmd-palette-trigger-label">Search files...</span>
            <span class="cmd-palette-trigger-kbd">&#8984;K</span>
        </button>
        <nav id="theme-switcher" role="navigation" aria-label="Theme selector">
            <div id="theme-panel" role="menu" aria-label="Available themes">
                <div id="theme-switcher-label">Theme</div>
                <button class="theme-btn active" data-theme-value="observatory" role="menuitem">
                    <span class="theme-swatch swatch-observatory"></span>Observatory
                </button>
                <button class="theme-btn" data-theme-value="polar" role="menuitem">
                    <span class="theme-swatch swatch-polar"></span>Polar
                </button>
                <button class="theme-btn" data-theme-value="amber" role="menuitem">
                    <span class="theme-swatch swatch-amber"></span>Amber
                </button>
            </div>
            <button id="theme-gear-btn" aria-label="Toggle theme selector" aria-expanded="false" aria-controls="theme-panel">
                <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 00-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1112 8.4a3.6 3.6 0 010 7.2z"/>
                </svg>
            </button>
        </nav>
    </header>

    <!-- MAIN LAYOUT -->
    <div id="app-container">

        <!-- TREE PANEL -->
        <div id="tree-panel" role="complementary" aria-label="File tree">
            <div id="tree-toolbar">
                <span class="tree-filter-label">View</span>
                <div class="tree-filter-pills" role="group" aria-label="File filter">
                    <button class="tree-filter-pill active" data-tree-mode="code" aria-pressed="true">Code</button>
                    <button class="tree-filter-pill" data-tree-mode="all" aria-pressed="false">All</button>
                </div>
                <span class="tree-info-icon" style="margin-left: auto;" aria-label="Tree legend">?<span class="tree-info-tooltip" style="left: auto; right: 0; transform: none;"><b>View</b><br><b>Code</b> — indexed source files only<br><b>All</b> — all project files<br><br><b>Index Status</b><br><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent-green);opacity:0.35;vertical-align:middle;margin-right:4px"></span> unchanged<br><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent-warm);vertical-align:middle;margin-right:4px"></span> modified<br><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--accent);vertical-align:middle;margin-right:4px"></span> new<br><br><b>Git Status</b><br><span style="display:inline-block;width:6px;height:6px;border-radius:1px;transform:rotate(45deg);background:var(--accent-green);vertical-align:middle;margin-right:4px"></span> pushed<br><span style="display:inline-block;width:6px;height:6px;border-radius:1px;transform:rotate(45deg);background:var(--accent);vertical-align:middle;margin-right:4px"></span> committed<br><span style="display:inline-block;width:6px;height:6px;border-radius:1px;transform:rotate(45deg);background:var(--accent-warm);vertical-align:middle;margin-right:4px"></span> modified<br><span style="display:inline-block;width:6px;height:6px;border-radius:1px;transform:rotate(45deg);background:var(--text-muted);opacity:0.5;vertical-align:middle;margin-right:4px"></span> untracked<br><br><b>Badges</b><br><span style="color:var(--accent)">m</span> — methods &nbsp; <span style="color:var(--accent-purple)">t</span> — types</span></span>
            </div>
            <div id="tree-scroll" role="tree" aria-label="Project files">
                <div class="loading-state" id="tree-loading">
                    <span class="loading-dot"></span>
                    <span class="loading-dot"></span>
                    <span class="loading-dot"></span>
                    <span>Indexing project...</span>
                </div>
                <div id="tree-root"></div>
            </div>
        </div>

        <!-- SPLITTER -->
        <div id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panels"></div>

        <!-- DETAIL PANEL -->
        <div id="detail-panel" role="main">
            <nav id="detail-tab-bar" role="tablist" aria-label="Detail view tabs">
                <button class="detail-tab active" data-detail-tab="signatures" role="tab" aria-selected="true" aria-controls="signature-view">Signatures</button>
                <button class="detail-tab" data-detail-tab="source" role="tab" aria-selected="false" aria-controls="source-view">Source</button>
                <button class="detail-tab" data-detail-tab="tasks" role="tab" aria-selected="false" aria-controls="tasks-view">Tasks <span class="tab-badge" id="tasks-badge">0</span></button>
                <div class="tab-bar-spacer"></div>
                <div class="tab-bar-context hidden" id="tab-bar-file-context">
                    <span class="breadcrumb-dir" id="ctx-file-dir"></span>
                    <span class="context-sep">/</span>
                    <span class="context-filename" id="ctx-file-name"></span>
                </div>
            </nav>

            <div id="file-header-bar" class="hidden">
                <div class="file-breadcrumb" id="file-breadcrumb"></div>
                <div class="file-stat-pills" id="file-stat-pills"></div>
            </div>

            <div id="detail-content">
                <!-- Signatures View -->
                <div class="detail-view active" id="signature-view" role="tabpanel">
                    <div class="empty-state" id="sig-empty-state">
                        <div class="empty-state-icon">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/>
                            </svg>
                        </div>
                        <span class="empty-state-label">Select a file to inspect its signature</span>
                        <span class="empty-state-hint">Methods, types, and header comments</span>
                    </div>
                    <div id="sig-content" class="hidden">
                        <div class="sig-section" id="sig-header-section">
                            <div class="sig-section-title">Header</div>
                            <div class="sig-header-comment" id="sig-header-comment"></div>
                        </div>
                        <div class="sig-section" id="sig-types-section">
                            <div class="sig-section-title">Types</div>
                            <ul class="sig-type-list" id="sig-type-list"></ul>
                        </div>
                        <div class="sig-section" id="sig-methods-section">
                            <div class="sig-section-title">Methods</div>
                            <ul class="sig-method-list" id="sig-method-list"></ul>
                        </div>
                    </div>
                </div>

                <!-- Source View -->
                <div class="detail-view" id="source-view" role="tabpanel">
                    <div class="empty-state" id="src-empty-state">
                        <div class="empty-state-icon">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                            </svg>
                        </div>
                        <span class="empty-state-label">No file selected</span>
                        <span class="empty-state-hint">Click a file in the tree to view source</span>
                    </div>
                    <div class="code-container hidden" id="src-code-container">
                        <div class="source-line-numbers" id="src-line-numbers"></div>
                        <pre><code id="src-code-block"></code></pre>
                    </div>
                </div>

                <!-- Tasks View -->
                <div class="detail-view" id="tasks-view" role="tabpanel">
                    <div id="tasks-filter-bar">
                        <span class="tasks-filter-label">Group by</span>
                        <div class="tasks-group-toggle" role="group" aria-label="Task grouping">
                            <button class="tasks-group-btn active" data-tasks-group="status" aria-pressed="true">Status</button>
                            <button class="tasks-group-btn" data-tasks-group="tag" aria-pressed="false">Tag</button>
                        </div>
                    </div>
                    <div class="empty-state hidden" id="tasks-empty-state">
                        <div class="empty-state-icon">
                            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                            </svg>
                        </div>
                        <span class="empty-state-label">No tasks yet</span>
                        <span class="empty-state-hint">Create tasks with chronicle_task</span>
                    </div>
                    <div id="tasks-active-section" class="hidden">
                        <div class="task-section-label">Active</div>
                        <ul class="task-list" id="tasks-active-list"></ul>
                    </div>
                    <div id="tasks-backlog-section" class="hidden">
                        <div class="task-section-label">Backlog</div>
                        <ul class="task-list" id="tasks-backlog-list"></ul>
                    </div>
                    <div id="tasks-done-section" class="hidden">
                        <div class="task-done-toggle" id="task-done-toggle" role="button" aria-expanded="false">Completed</div>
                        <div class="task-done-list collapsed" id="tasks-done-list-wrap">
                            <ul class="task-list" id="tasks-done-list"></ul>
                        </div>
                    </div>
                    <div id="tasks-cancelled-section" class="hidden">
                        <div class="task-done-toggle" id="task-cancelled-toggle" role="button" aria-expanded="false">Cancelled</div>
                        <div class="task-done-list collapsed" id="tasks-cancelled-list-wrap">
                            <ul class="task-list" id="tasks-cancelled-list"></ul>
                        </div>
                    </div>
                    <div id="tasks-tag-view" class="hidden"></div>
                </div>
            </div>
        </div>
    </div>

    <!-- COMMAND PALETTE OVERLAY -->
    <div id="cmd-palette-overlay" class="hidden" role="dialog" aria-modal="true" aria-label="Command palette">
        <div id="cmd-palette">
            <div id="cmd-palette-input-wrap">
                <span class="cmd-palette-search-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="11" cy="11" r="8"/>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                </span>
                <input type="text" id="cmd-palette-input" placeholder="Search files, methods, types..." autocomplete="off" spellcheck="false" aria-label="Search" aria-autocomplete="list" aria-controls="cmd-palette-results" />
            </div>
            <div id="cmd-palette-results" role="listbox" aria-label="Search results">
                <div id="cmd-palette-empty" class="hidden">No results found</div>
            </div>
            <div id="cmd-palette-footer" aria-hidden="true">
                <div class="cmd-palette-hint"><kbd>Return</kbd><span>open</span></div>
                <div class="cmd-palette-hint"><kbd>Esc</kbd><span>close</span></div>
                <div class="cmd-palette-hint"><kbd>Up</kbd><kbd>Down</kbd><span>navigate</span></div>
            </div>
        </div>
    </div>

    <!-- Old theme switcher removed — now in header -->

    <!-- JAVASCRIPT -->
    <script>
    (function() {
        // ── State ──
        var ws = null;
        var selectedFile = null;
        var treeData = null;
        var allTreeData = null;
        var codeTreeData = null;
        var currentTreeMode = 'code';
        var currentTab = 'signatures';
        var allFiles = [];
        var expandedDirs = {};

        // ── Utility ──
        function esc(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;').replace(/\\'/g, '&#39;');
        }

        // ── WebSocket ──
        function connect() {
            ws = new WebSocket('ws://' + location.host);
            ws.onopen = function() { console.log('[Chronicle] Connected'); };
            ws.onclose = function() { setTimeout(connect, 1000); };
            ws.onmessage = function(e) { handleMessage(JSON.parse(e.data)); };
        }

        function send(msg) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg));
            }
        }

        function handleMessage(msg) {
            if (msg.type === 'tree') {
                if (msg.mode === 'code') codeTreeData = msg.data;
                else allTreeData = msg.data;
                if (msg.mode === currentTreeMode) {
                    treeData = msg.data;
                    renderTree(msg.data);
                    updateHeaderStats(msg.data);
                }
            } else if (msg.type === 'refresh') {
                codeTreeData = msg.codeTree;
                allTreeData = msg.allTree;
                treeData = currentTreeMode === 'code' ? codeTreeData : allTreeData;
                renderTree(treeData);
                updateHeaderStats(treeData);
                if (selectedFile) {
                    send({ type: 'getSignature', file: selectedFile });
                    send({ type: 'getFileContent', file: selectedFile });
                }
            } else if (msg.type === 'signature') {
                renderSignature(msg.data, msg.file);
            } else if (msg.type === 'fileContent') {
                renderSource(msg.data, msg.file);
            } else if (msg.type === 'tasks') {
                renderTasks(msg.data);
            }
        }

        // ── Header Stats ──
        function updateHeaderStats(tree) {
            if (!tree) return;
            var fileCount = 0;
            var langs = {};
            function count(node) {
                if (node.type === 'file') {
                    fileCount++;
                    var ext = node.name.split('.').pop();
                    if (ext) langs[ext] = true;
                }
                if (node.children) node.children.forEach(count);
            }
            count(tree);
            var el = document.getElementById('header-stats');
            if (el) el.textContent = fileCount + ' files \\u00b7 ' + Object.keys(langs).length + ' lang';

            var changedCount = 0;
            function countChanged(node) {
                if (node.type === 'file' && (node.status === 'modified' || node.status === 'new')) changedCount++;
                if (node.children) node.children.forEach(countChanged);
            }
            countChanged(tree);

            var sessionEl = document.getElementById('header-session');
            var countEl = document.getElementById('header-session-count');
            if (sessionEl && countEl) {
                if (changedCount > 0) {
                    sessionEl.classList.remove('hidden');
                    countEl.textContent = changedCount + ' changed';
                } else {
                    sessionEl.classList.add('hidden');
                }
            }
        }

        // ── Tree ──
        function collectFiles(node, files) {
            if (node.type === 'file') files.push(node);
            if (node.children) node.children.forEach(function(c) { collectFiles(c, files); });
        }

        function renderTree(data) {
            if (!data) return;
            var root = document.getElementById('tree-root');
            var loading = document.getElementById('tree-loading');
            if (loading) loading.classList.add('hidden');
            if (!root) return;

            allFiles = [];
            collectFiles(data, allFiles);

            root.innerHTML = '';
            if (data.children) {
                data.children.forEach(function(child) { renderTreeNode(child, root, 0); });
            }
        }

        function renderTreeNode(node, parent, depth) {
            var el = document.createElement('div');
            el.className = 'tree-node ' + node.type + (selectedFile === node.path ? ' selected' : '');
            el.setAttribute('data-path', node.path);

            // Indent
            var indent = document.createElement('span');
            indent.className = 'tree-indent';
            indent.style.width = (depth * 16 + 8) + 'px';
            el.appendChild(indent);

            // Toggle
            var toggle = document.createElement('span');
            if (node.type === 'dir') {
                var isOpen = expandedDirs[node.path];
                toggle.className = 'tree-toggle ' + (isOpen ? 'is-open' : 'is-closed');
            } else {
                toggle.className = 'tree-toggle leaf';
            }
            el.appendChild(toggle);

            // Status dot
            var statusDot = document.createElement('span');
            if (node.type === 'file' && node.status) {
                statusDot.className = 'tree-status-dot status-' + node.status;
            } else {
                statusDot.className = 'tree-status-dot no-dot';
            }
            el.appendChild(statusDot);

            // Git dot
            if (node.type === 'file' && node.gitStatus) {
                var gitDot = document.createElement('span');
                gitDot.className = 'tree-git-dot git-' + node.gitStatus;
                gitDot.title = node.gitStatus;
                el.appendChild(gitDot);
            }

            // Label
            var label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = node.name;
            el.appendChild(label);

            // Stats badges
            if (node.type === 'file' && node.stats && (node.stats.methods > 0 || node.stats.types > 0)) {
                var badgeWrap = document.createElement('span');
                badgeWrap.className = 'tree-badges';
                if (node.stats.methods > 0) {
                    var mb = document.createElement('span');
                    mb.className = 'tree-badge tree-badge-m';
                    mb.textContent = node.stats.methods + 'm';
                    mb.title = node.stats.methods + (node.stats.methods === 1 ? ' method' : ' methods');
                    badgeWrap.appendChild(mb);
                }
                if (node.stats.types > 0) {
                    var tb = document.createElement('span');
                    tb.className = 'tree-badge tree-badge-t';
                    tb.textContent = node.stats.types + 't';
                    tb.title = node.stats.types + (node.stats.types === 1 ? ' type' : ' types');
                    badgeWrap.appendChild(tb);
                }
                el.appendChild(badgeWrap);
            }

            el.addEventListener('click', function(e) {
                e.stopPropagation();
                if (node.type === 'dir') {
                    if (expandedDirs[node.path]) {
                        delete expandedDirs[node.path];
                    } else {
                        expandedDirs[node.path] = true;
                    }
                    renderTree(treeData);
                } else {
                    selectFile(node.path);
                }
            });

            parent.appendChild(el);

            // Children
            if (node.type === 'dir' && node.children) {
                var childContainer = document.createElement('div');
                childContainer.className = 'tree-children' + (expandedDirs[node.path] ? '' : ' collapsed');
                node.children.forEach(function(child) { renderTreeNode(child, childContainer, depth + 1); });
                parent.appendChild(childContainer);
            }
        }

        function selectFile(filePath) {
            selectedFile = filePath;

            // Update tree selection
            document.querySelectorAll('.tree-node.selected').forEach(function(n) { n.classList.remove('selected'); });
            var sel = document.querySelector('.tree-node[data-path="' + filePath.replace(/"/g, '\\\\"') + '"]');
            if (sel) sel.classList.add('selected');

            // Update tab bar context
            var ctxWrap = document.getElementById('tab-bar-file-context');
            var ctxDir = document.getElementById('ctx-file-dir');
            var ctxName = document.getElementById('ctx-file-name');
            if (ctxWrap && ctxDir && ctxName) {
                var fp = filePath.split('/');
                var fn = fp.pop();
                ctxDir.textContent = fp.join('/');
                ctxName.textContent = fn;
                ctxWrap.classList.remove('hidden');
            }

            // Show file header bar
            var headerBar = document.getElementById('file-header-bar');
            var breadcrumb = document.getElementById('file-breadcrumb');
            if (headerBar && breadcrumb) {
                var parts = filePath.split('/');
                var fileName = parts.pop();
                var dir = parts.join('/');
                breadcrumb.innerHTML = '';
                if (dir) {
                    var dirSpan = document.createElement('span');
                    dirSpan.className = 'breadcrumb-dir';
                    dirSpan.textContent = dir;
                    breadcrumb.appendChild(dirSpan);
                    var sep = document.createElement('span');
                    sep.className = 'breadcrumb-sep';
                    sep.textContent = '/';
                    breadcrumb.appendChild(sep);
                }
                var fileSpan = document.createElement('span');
                fileSpan.className = 'breadcrumb-file';
                fileSpan.textContent = fileName;
                breadcrumb.appendChild(fileSpan);
                headerBar.classList.remove('hidden');
            }

            // Switch to signatures tab when file selected
            switchTab('signatures');

            // Request data
            send({ type: 'getSignature', file: filePath });
            send({ type: 'getFileContent', file: filePath });
        }

        // ── Signature ──
        function renderSignature(data, filePath) {
            var emptyState = document.getElementById('sig-empty-state');
            var content = document.getElementById('sig-content');
            if (!content || !emptyState) return;

            if (data.error) {
                emptyState.querySelector('.empty-state-label').textContent = data.error;
                emptyState.classList.remove('hidden');
                content.classList.add('hidden');
                return;
            }

            emptyState.classList.add('hidden');
            content.classList.remove('hidden');

            // Header
            var headerSection = document.getElementById('sig-header-section');
            var headerComment = document.getElementById('sig-header-comment');
            if (headerSection && headerComment) {
                if (data.header) {
                    headerComment.textContent = data.header;
                    headerSection.classList.remove('hidden');
                } else {
                    headerSection.classList.add('hidden');
                }
            }

            // Types
            var typesSection = document.getElementById('sig-types-section');
            var typeList = document.getElementById('sig-type-list');
            if (typesSection && typeList) {
                typeList.innerHTML = '';
                if (data.types && data.types.length > 0) {
                    data.types.forEach(function(t) {
                        var li = document.createElement('li');
                        li.className = 'sig-type-item';
                        li.innerHTML = '<span class="sig-type-line">' + t.line + '</span>' +
                            '<span class="sig-type-kind">' + esc(t.kind) + '</span>' +
                            '<span class="sig-type-name">' + esc(t.name) + '</span>';
                        li.style.cursor = 'pointer';
                        li.addEventListener('click', function() {
                            switchTab('source');
                            setTimeout(function() { scrollToLine(t.line); }, 100);
                        });
                        typeList.appendChild(li);
                    });
                    typesSection.classList.remove('hidden');
                } else {
                    typesSection.classList.add('hidden');
                }
            }

            // Methods
            var methodsSection = document.getElementById('sig-methods-section');
            var methodList = document.getElementById('sig-method-list');
            if (methodsSection && methodList) {
                methodList.innerHTML = '';
                if (data.methods && data.methods.length > 0) {
                    data.methods.forEach(function(m) {
                        var li = document.createElement('li');
                        li.className = 'sig-method-item';
                        var html = '<span class="sig-method-line">' + m.line + '</span>';
                        if (m.visibility && m.visibility !== 'public') {
                            html += '<span class="sig-method-visibility">' + esc(m.visibility) + '</span>';
                        }
                        if (m.static) html += '<span class="sig-method-modifier">static</span>';
                        if (m.async) html += '<span class="sig-method-modifier">async</span>';
                        html += '<span class="sig-method-proto">' + esc(m.prototype) + '</span>';
                        li.innerHTML = html;
                        li.style.cursor = 'pointer';
                        li.addEventListener('click', function() {
                            switchTab('source');
                            setTimeout(function() { scrollToLine(m.line); }, 100);
                        });
                        methodList.appendChild(li);
                    });
                    methodsSection.classList.remove('hidden');
                } else {
                    methodsSection.classList.add('hidden');
                }
            }

            // Stat pills
            var pills = document.getElementById('file-stat-pills');
            if (pills) {
                pills.innerHTML = '';
                if (data.methods && data.methods.length > 0) {
                    var mp = document.createElement('span');
                    mp.className = 'file-stat-pill methods';
                    mp.textContent = data.methods.length + 'm';
                    pills.appendChild(mp);
                }
                if (data.types && data.types.length > 0) {
                    var tp = document.createElement('span');
                    tp.className = 'file-stat-pill types';
                    tp.textContent = data.types.length + 't';
                    pills.appendChild(tp);
                }
            }
        }

        // ── Source ──
        function renderSource(data, filePath) {
            var emptyState = document.getElementById('src-empty-state');
            var container = document.getElementById('src-code-container');
            var codeBlock = document.getElementById('src-code-block');
            if (!container || !codeBlock || !emptyState) return;

            if (data.error) {
                emptyState.querySelector('.empty-state-label').textContent = data.error;
                emptyState.classList.remove('hidden');
                container.classList.add('hidden');
                return;
            }

            emptyState.classList.add('hidden');
            container.classList.remove('hidden');
            codeBlock.textContent = data.content;
            codeBlock.removeAttribute('data-highlighted');
            codeBlock.className = '';
            if (data.language && data.language !== 'plaintext') {
                codeBlock.className = 'language-' + data.language;
            }
            hljs.highlightElement(codeBlock);

            // Generate line numbers
            var lineNums = document.getElementById('src-line-numbers');
            if (lineNums) {
                var lineCount = (data.content || '').split('\\n').length;
                var html = '';
                for (var i = 1; i <= lineCount; i++) {
                    html += '<span>' + i + '</span>';
                }
                lineNums.innerHTML = html;
            }
        }

        function scrollToLine(lineNumber) {
            var codeBlock = document.getElementById('src-code-block');
            if (!codeBlock) return;
            var lineHeight = 19.5;
            var scrollTop = (lineNumber - 1) * lineHeight - 100;
            var container = document.getElementById('src-code-container');
            if (container) container.scrollTop = Math.max(0, scrollTop);
        }

        // ── Tasks ──
        function renderTasks(tasks) {
            if (!tasks) return;

            var badge = document.getElementById('tasks-badge');
            if (badge) {
                var activeCount = tasks.filter(function(t) { return t.status === 'active' || t.status === 'backlog'; }).length;
                badge.textContent = activeCount;
            }

            var emptyState = document.getElementById('tasks-empty-state');
            var activeTasks = tasks.filter(function(t) { return t.status === 'active'; });
            var backlogTasks = tasks.filter(function(t) { return t.status === 'backlog'; });
            var doneTasks = tasks.filter(function(t) { return t.status === 'done'; });
            var cancelledTasks = tasks.filter(function(t) { return t.status === 'cancelled'; });

            if (emptyState) {
                if (tasks.length > 0) emptyState.classList.add('hidden');
                else emptyState.classList.remove('hidden');
            }

            renderTaskSection('tasks-active-section', 'tasks-active-list', activeTasks);
            renderTaskSection('tasks-backlog-section', 'tasks-backlog-list', backlogTasks);
            renderTaskSection('tasks-done-section', 'tasks-done-list', doneTasks);
            renderTaskSection('tasks-cancelled-section', 'tasks-cancelled-list', cancelledTasks);
        }

        function renderTaskSection(sectionId, listId, tasks) {
            var section = document.getElementById(sectionId);
            var list = document.getElementById(listId);
            if (!section || !list) return;

            if (tasks.length === 0) {
                section.classList.add('hidden');
                return;
            }

            section.classList.remove('hidden');
            list.innerHTML = '';

            tasks.forEach(function(task) {
                var li = document.createElement('li');
                li.className = 'task-item priority-' + task.priority + ' status-' + task.status;

                var html = '<div class="task-item-header">';
                html += '<span class="task-title">' + esc(task.title) + '</span>';
                html += '<span class="task-status-badge status-' + task.status + '">' + task.status + '</span>';
                html += '</div>';

                if (task.description) {
                    html += '<div class="task-description">' + esc(task.description) + '</div>';
                }

                if (task.tags) {
                    html += '<div class="task-meta-row"><div class="task-tags">';
                    task.tags.split(',').forEach(function(tag) {
                        tag = tag.trim();
                        if (tag) html += '<span class="task-tag">' + esc(tag) + '</span>';
                    });
                    html += '</div></div>';
                }

                if (task.status === 'active' || task.status === 'backlog') {
                    html += '<div class="task-actions">';
                    if (task.status === 'backlog') {
                        html += '<button class="task-btn" data-task-id="' + task.id + '" data-action="active">Activate</button>';
                    }
                    html += '<button class="task-btn btn-done" data-task-id="' + task.id + '" data-action="done">Done</button>';
                    html += '<button class="task-btn btn-cancel" data-task-id="' + task.id + '" data-action="cancelled">Cancel</button>';
                    html += '</div>';
                }

                li.innerHTML = html;
                list.appendChild(li);
            });
        }

        // ── Task Create Form ──
        function initTaskCreateForm() {
            var tasksView = document.getElementById('tasks-view');
            if (!tasksView) return;

            var formWrap = document.createElement('div');
            formWrap.id = 'task-create-form';
            formWrap.style.cssText = 'margin-bottom: 16px;';

            var toggleBtn = document.createElement('button');
            toggleBtn.id = 'task-create-toggle';
            toggleBtn.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:4px;border:1px dashed var(--border);background:transparent;color:var(--text-muted);font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer;width:100%;transition:border-color 0.15s,color 0.15s;letter-spacing:0.03em';
            toggleBtn.innerHTML = '<span style="font-size:14px;line-height:1">+</span> New task';

            var fields = document.createElement('div');
            fields.id = 'task-create-fields';
            fields.className = 'hidden';
            fields.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:12px;display:flex;flex-direction:column;gap:8px';
            fields.innerHTML = '<input type="text" id="task-title-input" placeholder="Task title..." style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:6px 10px;color:var(--text-primary);font-size:12px;font-family:IBM Plex Sans,sans-serif;outline:none;width:100%" />'
                + '<div style="display:flex;gap:8px;align-items:center">'
                + '<label style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Priority</label>'
                + '<select id="task-priority-select" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:3px 8px;color:var(--text-primary);font-size:11px;font-family:IBM Plex Sans,sans-serif">'
                + '<option value="1">High</option><option value="2" selected>Medium</option><option value="3">Low</option></select>'
                + '<label style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-left:8px">Tags</label>'
                + '<input type="text" id="task-tags-input" placeholder="bug, fix" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:3px 8px;color:var(--text-primary);font-size:11px;font-family:IBM Plex Sans,sans-serif;flex:1;outline:none" /></div>'
                + '<div style="display:flex;gap:6px;justify-content:flex-end">'
                + '<button id="task-create-cancel" style="padding:4px 12px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer">Cancel</button>'
                + '<button id="task-create-submit" style="padding:4px 12px;border-radius:3px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer;font-weight:500">Create</button></div>'
                + '<div style="font-size:10px;color:var(--text-muted);opacity:0.7">Tip: You can also create tasks via chronicle_task MCP tool</div>';

            formWrap.appendChild(toggleBtn);
            formWrap.appendChild(fields);

            var filterBar = document.getElementById('tasks-filter-bar');
            if (filterBar) {
                tasksView.insertBefore(formWrap, filterBar);
            } else {
                tasksView.insertBefore(formWrap, tasksView.firstChild);
            }

            toggleBtn.addEventListener('click', function() {
                toggleBtn.classList.add('hidden');
                fields.classList.remove('hidden');
                document.getElementById('task-title-input').focus();
            });

            document.getElementById('task-create-cancel').addEventListener('click', function() {
                fields.classList.add('hidden');
                toggleBtn.classList.remove('hidden');
                document.getElementById('task-title-input').value = '';
                document.getElementById('task-tags-input').value = '';
            });

            document.getElementById('task-create-submit').addEventListener('click', submitTask);

            document.getElementById('task-title-input').addEventListener('keydown', function(e) {
                if (e.key === 'Enter') submitTask();
                if (e.key === 'Escape') {
                    fields.classList.add('hidden');
                    toggleBtn.classList.remove('hidden');
                }
            });
        }

        function submitTask() {
            var titleInput = document.getElementById('task-title-input');
            var title = titleInput.value.trim();
            if (!title) return;

            var priority = parseInt(document.getElementById('task-priority-select').value);
            var tags = document.getElementById('task-tags-input').value.trim();

            send({ type: 'createTask', title: title, priority: priority, tags: tags });

            titleInput.value = '';
            document.getElementById('task-tags-input').value = '';
            document.getElementById('task-create-fields').classList.add('hidden');
            document.getElementById('task-create-toggle').classList.remove('hidden');
        }

        // ── Tabs ──
        function switchTab(tabName) {
            currentTab = tabName;
            document.querySelectorAll('.detail-tab').forEach(function(tab) {
                var isActive = tab.getAttribute('data-detail-tab') === tabName;
                tab.classList.toggle('active', isActive);
                tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            document.querySelectorAll('.detail-view').forEach(function(view) {
                view.classList.remove('active');
            });
            var viewId = tabName === 'signatures' ? 'signature-view' :
                         tabName === 'source' ? 'source-view' : 'tasks-view';
            var targetView = document.getElementById(viewId);
            if (targetView) targetView.classList.add('active');
        }

        function initTabs() {
            document.querySelectorAll('.detail-tab').forEach(function(tab) {
                tab.addEventListener('click', function() {
                    switchTab(tab.getAttribute('data-detail-tab'));
                });
            });
        }

        // ── Command Palette ──
        function initCommandPalette() {
            var overlay = document.getElementById('cmd-palette-overlay');
            var input = document.getElementById('cmd-palette-input');
            var results = document.getElementById('cmd-palette-results');
            var trigger = document.getElementById('cmd-palette-trigger');
            var emptyState = document.getElementById('cmd-palette-empty');
            var focusedIndex = -1;
            var resultItems = [];

            function open() {
                overlay.classList.remove('hidden');
                input.value = '';
                input.focus();
                renderResults('');
                focusedIndex = -1;
            }

            function close() {
                overlay.classList.add('hidden');
                input.value = '';
            }

            function renderResults(query) {
                results.querySelectorAll('.cmd-result-section-label, .cmd-result-item').forEach(function(el) { el.remove(); });
                resultItems = [];

                if (!query) {
                    if (emptyState) emptyState.classList.add('hidden');
                    var label = document.createElement('div');
                    label.className = 'cmd-result-section-label';
                    label.textContent = 'Files';
                    results.insertBefore(label, emptyState);
                    allFiles.slice(0, 20).forEach(function(file, i) {
                        var item = createResultItem(file, i);
                        results.insertBefore(item, emptyState);
                        resultItems.push(item);
                    });
                    return;
                }

                var q = query.toLowerCase();
                var scored = allFiles.map(function(file) {
                    var name = file.name.toLowerCase();
                    var path = file.path.toLowerCase();
                    var score = 0;
                    if (name === q) score = 100;
                    else if (name.startsWith(q)) score = 80;
                    else if (name.includes(q)) score = 60;
                    else if (path.includes(q)) score = 40;
                    return { file: file, score: score };
                }).filter(function(s) { return s.score > 0; })
                  .sort(function(a, b) { return b.score - a.score; })
                  .slice(0, 20);

                if (scored.length === 0) {
                    if (emptyState) emptyState.classList.remove('hidden');
                    return;
                }
                if (emptyState) emptyState.classList.add('hidden');

                var lbl = document.createElement('div');
                lbl.className = 'cmd-result-section-label';
                lbl.textContent = 'Files';
                results.insertBefore(lbl, emptyState);

                scored.forEach(function(s, i) {
                    var item = createResultItem(s.file, i);
                    results.insertBefore(item, emptyState);
                    resultItems.push(item);
                });
                focusedIndex = 0;
                updateFocus();
            }

            function createResultItem(file, index) {
                var item = document.createElement('div');
                item.className = 'cmd-result-item';
                item.setAttribute('data-index', index);
                item.innerHTML = '<span class="cmd-result-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg></span>'
                    + '<span class="cmd-result-name">' + esc(file.name) + '</span>'
                    + '<span class="cmd-result-path">' + esc(file.path) + '</span>';
                item.addEventListener('click', function() {
                    selectFile(file.path);
                    close();
                });
                return item;
            }

            function updateFocus() {
                resultItems.forEach(function(item, i) {
                    item.classList.toggle('focused', i === focusedIndex);
                });
                if (focusedIndex >= 0 && resultItems[focusedIndex]) {
                    resultItems[focusedIndex].scrollIntoView({ block: 'nearest' });
                }
            }

            trigger.addEventListener('click', open);

            document.addEventListener('keydown', function(e) {
                if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                    e.preventDefault();
                    if (overlay.classList.contains('hidden')) open();
                    else close();
                }
                if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                    close();
                }
            });

            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) close();
            });

            input.addEventListener('input', function() {
                renderResults(input.value.trim());
            });

            input.addEventListener('keydown', function(e) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    if (focusedIndex < resultItems.length - 1) { focusedIndex++; updateFocus(); }
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (focusedIndex > 0) { focusedIndex--; updateFocus(); }
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (focusedIndex >= 0 && resultItems[focusedIndex]) { resultItems[focusedIndex].click(); }
                }
            });
        }

        // ── Splitter ──
        function initSplitter() {
            var splitter = document.getElementById('splitter');
            var treePanel = document.getElementById('tree-panel');
            if (!splitter || !treePanel) return;

            var isDragging = false;
            splitter.addEventListener('mousedown', function(e) {
                isDragging = true;
                splitter.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                e.preventDefault();
            });

            document.addEventListener('mousemove', function(e) {
                if (!isDragging) return;
                var newWidth = Math.min(Math.max(e.clientX, 160), window.innerWidth * 0.5);
                treePanel.style.width = newWidth + 'px';
            });

            document.addEventListener('mouseup', function() {
                if (!isDragging) return;
                isDragging = false;
                splitter.classList.remove('dragging');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            });
        }

        // ── Theme ──
        function initTheme() {
            var gearBtn = document.getElementById('theme-gear-btn');
            var panel = document.getElementById('theme-panel');
            if (!gearBtn || !panel) return;

            var current = localStorage.getItem('chronicle-theme') || 'observatory';
            document.documentElement.setAttribute('data-theme', current);

            function updateActive() {
                panel.querySelectorAll('.theme-btn').forEach(function(btn) {
                    btn.classList.toggle('active', btn.getAttribute('data-theme-value') === current);
                });
            }
            updateActive();

            panel.querySelectorAll('.theme-btn').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    current = btn.getAttribute('data-theme-value');
                    document.documentElement.setAttribute('data-theme', current);
                    localStorage.setItem('chronicle-theme', current);
                    updateActive();
                    panel.classList.remove('open');
                });
            });

            gearBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                panel.classList.toggle('open');
            });

            document.addEventListener('click', function(e) {
                if (!document.getElementById('theme-switcher').contains(e.target)) {
                    panel.classList.remove('open');
                }
            });
        }

        // ── Tree Filters ──
        function initTreeFilters() {
            document.querySelectorAll('.tree-filter-pill').forEach(function(pill) {
                pill.addEventListener('click', function() {
                    var mode = pill.getAttribute('data-tree-mode');
                    currentTreeMode = mode;

                    document.querySelectorAll('.tree-filter-pill').forEach(function(p) {
                        p.classList.toggle('active', p.getAttribute('data-tree-mode') === mode);
                        p.setAttribute('aria-pressed', p.getAttribute('data-tree-mode') === mode ? 'true' : 'false');
                    });

                    if (mode === 'code' && codeTreeData) {
                        treeData = codeTreeData;
                        renderTree(treeData);
                    } else if (mode === 'all' && allTreeData) {
                        treeData = allTreeData;
                        renderTree(treeData);
                    } else {
                        send({ type: 'getTree', mode: mode });
                    }
                });
            });
        }

        // ── Task Actions (delegated) ──
        function initTaskActions() {
            document.getElementById('tasks-view').addEventListener('click', function(e) {
                var btn = e.target.closest('.task-btn');
                if (!btn) return;
                var taskId = parseInt(btn.getAttribute('data-task-id'));
                var action = btn.getAttribute('data-action');
                if (taskId && action) {
                    send({ type: 'updateTaskStatus', taskId: taskId, status: action });
                }
            });

            var doneToggle = document.getElementById('task-done-toggle');
            var doneWrap = document.getElementById('tasks-done-list-wrap');
            if (doneToggle && doneWrap) {
                doneToggle.addEventListener('click', function() {
                    doneToggle.classList.toggle('open');
                    doneWrap.classList.toggle('collapsed');
                });
            }

            var cancelledToggle = document.getElementById('task-cancelled-toggle');
            var cancelledWrap = document.getElementById('tasks-cancelled-list-wrap');
            if (cancelledToggle && cancelledWrap) {
                cancelledToggle.addEventListener('click', function() {
                    cancelledToggle.classList.toggle('open');
                    cancelledWrap.classList.toggle('collapsed');
                });
            }
        }

        // ── Init ──
        connect();
        initTabs();
        initTreeFilters();
        initSplitter();
        initTheme();
        initCommandPalette();
        initTaskCreateForm();
        initTaskActions();

        // Request tasks on load
        setTimeout(function() { send({ type: 'getTasks' }); }, 200);
    })();
    </script>
</body>
</html>`;
}
