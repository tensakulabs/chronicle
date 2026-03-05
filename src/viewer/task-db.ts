/**
 * Task database operations for the Chronicle Viewer.
 *
 * Centralizes all task-related DB access with a `withViewerDb` helper
 * that eliminates repeated open/query/close boilerplate.
 */

import { openDatabase } from '../db/index.js';
import type Database from 'better-sqlite3';

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

const TASKS_ORDER_SQL = `
    SELECT * FROM tasks
    ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 WHEN 'done' THEN 2 WHEN 'cancelled' THEN 3 END,
        priority ASC, sort_order ASC, created_at DESC
`;

// ============================================================
// Helper: run a callback against an open DB, then close it
// ============================================================

function withViewerDb<T>(dbPath: string, readonly: boolean, fn: (db: Database.Database) => T): T {
    const wrapped = openDatabase(dbPath, readonly);
    try {
        return fn(wrapped.getDb());
    } finally {
        wrapped.close();
    }
}

// ============================================================
// Read
// ============================================================

export function getTasksFromDb(db: Database.Database): unknown[] {
    try {
        db.exec(TASKS_DDL);
        return db.prepare(TASKS_ORDER_SQL).all();
    } catch {
        return [];
    }
}

// ============================================================
// Write operations (each opens its own writable connection)
// ============================================================

export function updateTaskStatus(dbPath: string, taskId: number, status: string): unknown[] | null {
    const validStatuses = ['backlog', 'active', 'done', 'cancelled'];
    if (!validStatuses.includes(status)) return null;

    try {
        return withViewerDb(dbPath, false, (db) => {
            const now = Date.now();
            const completedAt = (status === 'done' || status === 'cancelled') ? now : null;
            db.prepare(
                `UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`
            ).run(status, now, completedAt, taskId);

            db.prepare(
                `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
            ).run(taskId, `Status changed to: ${status} (via Viewer)`, now);

            return getTasksFromDb(db);
        });
    } catch (err) {
        console.error('[Viewer] Failed to update task status:', err);
        return null;
    }
}

export function updateTaskFields(
    dbPath: string,
    taskId: number,
    fields: { title?: string; tags?: string }
): unknown[] | null {
    try {
        return withViewerDb(dbPath, false, (db) => {
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

            if (updates.length === 0) return null;

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

            return getTasksFromDb(db);
        });
    } catch (err) {
        console.error('[Viewer] Failed to update task fields:', err);
        return null;
    }
}

export function reorderTasks(dbPath: string, taskIds: number[]): unknown[] | null {
    if (!taskIds.length) return null;

    try {
        return withViewerDb(dbPath, false, (db) => {
            const now = Date.now();
            const stmt = db.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`);

            const transaction = db.transaction(() => {
                taskIds.forEach((id, index) => {
                    stmt.run(index, now, id);
                });
            });
            transaction();

            return getTasksFromDb(db);
        });
    } catch (err) {
        console.error('[Viewer] Failed to reorder tasks:', err);
        return null;
    }
}

export function createTaskInDb(
    dbPath: string,
    title: string,
    priority: number,
    tags: string,
    description: string
): unknown[] | null {
    try {
        return withViewerDb(dbPath, false, (db) => {
            const now = Date.now();
            db.exec(TASKS_DDL);

            const result = db.prepare(
                `INSERT INTO tasks (title, description, priority, status, tags, source, sort_order, created_at, updated_at)
                 VALUES (?, ?, ?, 'backlog', ?, 'viewer', 0, ?, ?)`
            ).run(title, description || null, priority, tags || null, now, now);

            db.prepare(
                `INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)`
            ).run(result.lastInsertRowid, 'Task created (via Viewer)', now);

            return getTasksFromDb(db);
        });
    } catch (err) {
        console.error('[Viewer] Failed to create task:', err);
        return null;
    }
}
