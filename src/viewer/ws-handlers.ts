/**
 * WebSocket message handlers for the Chronicle Viewer.
 *
 * Each incoming message type maps to a handler function.
 * The dispatcher is called from server.ts on every WS message.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { openDatabase } from '../db/index.js';
import { getTasksFromDb, updateTaskStatus, createTaskInDb, updateTaskFields, reorderTasks } from './task-db.js';
import type { GitStatusInfo, GitFileStatus } from './git-status.js';
import type Database from 'better-sqlite3';

// ============================================================
// Shared types (mirrored from server.ts so the interface stays
// internal — the client-facing message format is unchanged)
// ============================================================

export interface ViewerMessage {
    type: 'getTree' | 'getSignature' | 'getFileContent' | 'getTasks' | 'updateTaskStatus' | 'createTask' | 'updateTask' | 'reorderTasks';
    mode?: 'code' | 'all';
    path?: string;
    file?: string;
    taskId?: number;
    status?: string;
    title?: string;
    priority?: number;
    tags?: string;
    description?: string;
    taskIds?: number[];
}

export interface SessionChangeInfo {
    modified: Set<string>;
    new: Set<string>;
}

// ============================================================
// Context passed from the server to every handler invocation
// ============================================================

/** Shared function signature for buildTree — used by both HandlerContext and WatcherDeps. */
export type BuildTreeFn = (
    db: Database.Database,
    projectPath: string,
    mode: 'code' | 'all',
    sessionChanges: SessionChangeInfo,
    gitInfo?: GitStatusInfo,
) => Promise<TreeNode>;

export interface HandlerContext {
    dbPath: string;
    projectPath: string;
    projectRoot: string;
    sessionChanges: SessionChangeInfo;
    cachedGitInfo: GitStatusInfo | undefined;
    wss: WebSocketServer;
    buildTree: BuildTreeFn;
    getFileContent: (projectRoot: string, filePath: string) => { content: string; language: string } | { error: string };
    getFileSignature: (db: Database.Database, filePath: string) => Promise<object>;
}

export interface TreeNode {
    name: string;
    path: string;
    type: 'dir' | 'file';
    fileType?: string;
    children?: TreeNode[];
    stats?: { items: number; methods: number; types: number };
    status?: 'modified' | 'new' | 'unchanged';
    gitStatus?: GitFileStatus;
}

// ============================================================
// Individual handlers
// ============================================================

function sendJson(ws: WebSocket, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function broadcastJson(wss: WebSocketServer, payload: unknown): void {
    const data = JSON.stringify(payload);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

async function handleGetTree(ws: WebSocket, msg: ViewerMessage, ctx: HandlerContext): Promise<void> {
    const mode = msg.mode || 'code';
    const freshDb = openDatabase(ctx.dbPath, true);
    try {
        const tree = await ctx.buildTree(freshDb.getDb(), ctx.projectPath, mode, ctx.sessionChanges, ctx.cachedGitInfo);
        sendJson(ws, { type: 'tree', mode, data: tree });
    } finally {
        freshDb.close();
    }
}

async function handleGetSignature(ws: WebSocket, msg: ViewerMessage, ctx: HandlerContext): Promise<void> {
    const freshDb = openDatabase(ctx.dbPath, true);
    try {
        const signature = await ctx.getFileSignature(freshDb.getDb(), msg.file!);
        sendJson(ws, { type: 'signature', file: msg.file, data: signature });
    } finally {
        freshDb.close();
    }
}

function handleGetFileContent(ws: WebSocket, msg: ViewerMessage, ctx: HandlerContext): void {
    const content = ctx.getFileContent(ctx.projectRoot, msg.file!);
    sendJson(ws, { type: 'fileContent', file: msg.file, data: content });
}

function handleGetTasks(ws: WebSocket, ctx: HandlerContext): void {
    const freshDb = openDatabase(ctx.dbPath, true);
    try {
        const taskData = getTasksFromDb(freshDb.getDb());
        sendJson(ws, { type: 'tasks', data: taskData });
    } finally {
        freshDb.close();
    }
}

function handleUpdateTaskStatus(msg: ViewerMessage, ctx: HandlerContext): void {
    const taskData = updateTaskStatus(ctx.dbPath, msg.taskId as number, msg.status as string);
    if (taskData) {
        broadcastJson(ctx.wss, { type: 'tasks', data: taskData });
    }
}

function handleUpdateTask(msg: ViewerMessage, ctx: HandlerContext): void {
    const fields: { title?: string; tags?: string } = {};
    if (msg.title !== undefined) fields.title = msg.title;
    if (msg.tags !== undefined) fields.tags = msg.tags;
    const taskData = updateTaskFields(ctx.dbPath, msg.taskId as number, fields);
    if (taskData) {
        broadcastJson(ctx.wss, { type: 'tasks', data: taskData });
    }
}

function handleReorderTasks(msg: ViewerMessage, ctx: HandlerContext): void {
    const taskData = reorderTasks(ctx.dbPath, msg.taskIds as number[]);
    if (taskData) {
        broadcastJson(ctx.wss, { type: 'tasks', data: taskData });
    }
}

function handleCreateTask(msg: ViewerMessage, ctx: HandlerContext): void {
    const taskData = createTaskInDb(
        ctx.dbPath,
        msg.title!,
        msg.priority || 2,
        msg.tags || '',
        msg.description || ''
    );
    if (taskData) {
        broadcastJson(ctx.wss, { type: 'tasks', data: taskData });
    }
}

// ============================================================
// Dispatcher — the single entry point called by server.ts
// ============================================================

export async function dispatchMessage(ws: WebSocket, msg: ViewerMessage, ctx: HandlerContext): Promise<void> {
    if (msg.type === 'getTree') {
        await handleGetTree(ws, msg, ctx);
    } else if (msg.type === 'getSignature' && msg.file) {
        await handleGetSignature(ws, msg, ctx);
    } else if (msg.type === 'getFileContent' && msg.file) {
        handleGetFileContent(ws, msg, ctx);
    } else if (msg.type === 'getTasks') {
        handleGetTasks(ws, ctx);
    } else if (msg.type === 'updateTaskStatus' && msg.taskId && msg.status) {
        handleUpdateTaskStatus(msg, ctx);
    } else if (msg.type === 'createTask' && msg.title) {
        handleCreateTask(msg, ctx);
    } else if (msg.type === 'updateTask' && msg.taskId) {
        handleUpdateTask(msg, ctx);
    } else if (msg.type === 'reorderTasks' && msg.taskIds) {
        handleReorderTasks(msg, ctx);
    }
}
