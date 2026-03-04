/**
 * File watcher setup for the Chronicle Viewer.
 *
 * Uses chokidar to watch the project directory, debounce changes,
 * re-index modified code files, and broadcast tree updates via WebSocket.
 */

import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { WebSocket, WebSocketServer } from 'ws';
import { openDatabase } from '../db/index.js';
import { update as updateIndex } from '../commands/update.js';
import { INDEX_DIR } from '../constants.js';
import type { GitStatusInfo } from './git-status.js';
import type { SessionChangeInfo, BuildTreeFn, TreeNode } from './ws-handlers.js';

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|cs|rs|py|c|cpp|h|hpp|java|go|php|rb)$/i;
const DEBOUNCE_MS = 500;

export interface WatcherDeps {
    dbPath: string;
    projectPath: string;
    projectRoot: string;
    wss: WebSocketServer;
    sessionChanges: SessionChangeInfo;
    getCachedGitInfo: () => GitStatusInfo | undefined;
    refreshGitStatus: () => Promise<void>;
    buildTree: BuildTreeFn;
}

export interface FileWatcherResult {
    watcher: FSWatcher;
    /** Manually trigger a tree broadcast (used by the /refresh debug endpoint). */
    broadcastTreeUpdate: () => Promise<void>;
}

/**
 * Start the chokidar file watcher and return the FSWatcher handle
 * plus a broadcastTreeUpdate function for manual triggers.
 */
export function createFileWatcher(deps: WatcherDeps): FileWatcherResult {
    const {
        dbPath, projectPath, projectRoot, wss,
        sessionChanges, getCachedGitInfo, refreshGitStatus, buildTree,
    } = deps;

    const absoluteProjectPath = path.resolve(projectPath);
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const pendingChanges = new Set<string>();

    // ----------------------------------------------------------
    // Broadcast a fresh tree to every connected client
    // ----------------------------------------------------------
    const broadcastTreeUpdate = async () => {
        if (!wss) return;

        // Re-index changed files before refreshing the tree
        if (pendingChanges.size > 0) {
            console.error('[Viewer] Re-indexing', pendingChanges.size, 'changed file(s)');
            for (const changedFile of pendingChanges) {
                const relativePath = path.relative(projectRoot, changedFile).replace(/\\/g, '/');
                try {
                    const result = updateIndex({ path: absoluteProjectPath, file: relativePath });
                    console.error('[Viewer] Re-indexed:', relativePath, result.success ? '\u2713' : '\u2717');
                    sessionChanges.modified.add(relativePath);
                } catch (err) {
                    console.error('[Viewer] Failed to re-index:', relativePath, err);
                }
            }
            pendingChanges.clear();
        }

        await refreshGitStatus();

        const freshDb = openDatabase(dbPath, true);
        let codeTree: TreeNode, allTree: TreeNode;
        try {
            const gitInfo = getCachedGitInfo();
            codeTree = await buildTree(freshDb.getDb(), projectPath, 'code', sessionChanges, gitInfo);
            allTree = await buildTree(freshDb.getDb(), projectPath, 'all', sessionChanges, gitInfo);
        } finally {
            freshDb.close();
        }

        const payload = JSON.stringify({ type: 'refresh', codeTree, allTree });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });

        console.error('[Viewer] Broadcast tree update to', wss.clients.size, 'clients');
    };

    // ----------------------------------------------------------
    // Create watcher
    // ----------------------------------------------------------
    const watcher = chokidar.watch(projectRoot, {
        ignored: [
            '**/node_modules/**',
            '**/.git/**',
            `**/${INDEX_DIR}/**`,
            '**/build/**',
            '**/dist/**',
        ],
        ignoreInitial: true,
        persistent: true,
    });

    watcher.on('ready', () => {
        console.error('[Viewer] Chokidar ready, watching for changes');
    });

    watcher.on('error', (error: unknown) => {
        console.error('[Viewer] Chokidar error:', error);
    });

    watcher.on('all', (event: string, filePath: string) => {
        console.error('[Viewer] Chokidar event:', event, filePath);

        if ((event === 'change' || event === 'add') && CODE_FILE_RE.test(filePath)) {
            pendingChanges.add(filePath);
        }

        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            console.error('[Viewer] Broadcasting after debounce');
            broadcastTreeUpdate();
        }, DEBOUNCE_MS);
    });

    console.error('[Viewer] Initializing chokidar for', projectRoot);

    return { watcher, broadcastTreeUpdate };
}
