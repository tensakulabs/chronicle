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
import { fileURLToPath } from 'url';
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
    type: 'getTree' | 'getSignature' | 'getFileContent' | 'getTasks' | 'updateTaskStatus' | 'updateTask' | 'createTask' | 'reorderTasks';
    mode?: 'code' | 'all';  // Tree mode
    path?: string;
    file?: string;
    taskId?: number;
    taskIds?: number[];
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

    function broadcastTasks(taskData: unknown[]): void {
        wss!.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'tasks', data: taskData }));
            }
        });
    }

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
                    const result = updateIndex({ path: projectRoot, file: relativePath });
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
                    if (taskData) broadcastTasks(taskData);
                }
                else if (msg.type === 'createTask' && msg.title) {
                    const taskData = createTaskInDb(msg.title, msg.priority || 2, msg.tags || '', msg.description || '');
                    if (taskData) broadcastTasks(taskData);
                }
                else if (msg.type === 'updateTask' && msg.taskId) {
                    const fields: { title?: string; tags?: string } = {};
                    if (msg.title !== undefined) fields.title = msg.title;
                    if (msg.tags !== undefined) fields.tags = msg.tags;
                    const taskData = updateTaskFields(msg.taskId as number, fields);
                    if (taskData) broadcastTasks(taskData);
                }
                else if (msg.type === 'reorderTasks' && msg.taskIds) {
                    const taskData = reorderTasks(msg.taskIds as number[]);
                    if (taskData) broadcastTasks(taskData);
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
const LANG_MAP: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
    '.cs': 'csharp', '.rs': 'rust',
    '.py': 'python', '.pyw': 'python',
    '.c': 'c', '.h': 'c',
    '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
    '.java': 'java', '.go': 'go', '.php': 'php',
    '.rb': 'ruby', '.rake': 'ruby',
    '.json': 'json', '.xml': 'xml',
    '.html': 'html', '.htm': 'html',
    '.css': 'css', '.scss': 'scss', '.less': 'less',
    '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sql': 'sql',
    '.sh': 'bash', '.bash': 'bash',
    '.bat': 'batch', '.ps1': 'powershell',
    '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini'
};

function getLanguageFromExtension(filePath: string): string {
    return LANG_MAP[path.extname(filePath).toLowerCase()] || 'plaintext';
}

const TASKS_DDL = `
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
`;

const VALID_STATUSES = ['backlog', 'active', 'done', 'cancelled'] as const;

function ensureTasksTable(db: Database.Database): void {
    db.exec(TASKS_DDL);
}

/**
 * Get tasks from the database for the viewer
 */
function getTasksFromDb(db: Database.Database): unknown[] {
    try {
        ensureTasksTable(db);
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
    if (!(VALID_STATUSES as readonly string[]).includes(status) || !viewerDbPath) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false); // writable connection
        const db = writeDb.getDb();
        const now = Date.now();
        const completedAt = (status === 'done' || status === 'cancelled') ? now : null;
        db.prepare(
            `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`
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
 * Update task fields (title, tags) from the viewer
 */
function updateTaskFields(taskId: number, fields: { title?: string; tags?: string }): unknown[] | null {
    if (!viewerDbPath) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false);
        const db = writeDb.getDb();
        const now = Date.now();
        const updates: string[] = [];
        const values: unknown[] = [];

        if (fields.title !== undefined) {
            updates.push('title = ?');
            values.push(fields.title);
        }
        if (fields.tags !== undefined) {
            updates.push('tags = ?');
            values.push(fields.tags || null);
        }

        if (updates.length === 0) { writeDb.close(); return null; }

        updates.push('updated_at = ?');
        values.push(now);
        values.push(taskId);

        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);

        const changes: string[] = [];
        if (fields.title !== undefined) changes.push(`title: "${fields.title}"`);
        if (fields.tags !== undefined) changes.push(`tags: "${fields.tags || ''}"`);
        db.prepare(
            `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
        ).run(taskId, `Updated ${changes.join(', ')} (via Viewer)`, now);

        const taskData = getTasksFromDb(db);
        writeDb.close();
        return taskData;
    } catch (err) {
        console.error('[Viewer] Failed to update task fields:', err);
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

        ensureTasksTable(db);

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
 * Reorder tasks by updating sort_order for a list of task IDs
 */
function reorderTasks(taskIds: number[]): unknown[] | null {
    if (!viewerDbPath || !taskIds.length) return null;

    try {
        const writeDb = openDatabase(viewerDbPath, false);
        const db = writeDb.getDb();
        const now = Date.now();
        const stmt = db.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`);

        const transaction = db.transaction(() => {
            taskIds.forEach((id, index) => {
                stmt.run(index, now, id);
            });
        });
        transaction();

        const taskData = getTasksFromDb(db);
        writeDb.close();
        return taskData;
    } catch (err) {
        console.error('[Viewer] Failed to reorder tasks:', err);
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

// Load viewer assets once at module level
const __viewerDir = path.dirname(fileURLToPath(import.meta.url));
const viewerCSS = readFileSync(path.join(__viewerDir, 'viewer.css'), 'utf-8');
const viewerClientJS = readFileSync(path.join(__viewerDir, 'viewer-client.js'), 'utf-8');

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

    <style>${viewerCSS}</style>
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
                        <div class="tasks-filter-wrap">
                            <button id="tasks-filter-trigger"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg> Filter</button>
                            <div id="tasks-filter-dropdown"></div>
                        </div>
                        <span class="tasks-filter-label">Group by</span>
                        <div class="tasks-group-toggle" role="group" aria-label="Task grouping">
                            <button class="tasks-group-btn active" data-tasks-group="status" aria-pressed="true">Status</button>
                            <button class="tasks-group-btn" data-tasks-group="tag" aria-pressed="false">Tag</button>
                        </div>
                    </div>
                    <div id="tasks-active-filters"></div>
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
                        <div class="task-section-label">In Progress</div>
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
    <script>${viewerClientJS}</script>
</body>
</html>`;
}
