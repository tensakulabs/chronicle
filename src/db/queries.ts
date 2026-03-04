/**
 * Prepared statements and query helpers for Chronicle
 */

import type Database from 'better-sqlite3';
import type { ChronicleDatabase } from './database.js';
import type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    ProjectFileRow,
    TaskRow,
    TaskLogRow,
} from './types.js';

// Re-export types for backwards compatibility
export type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    DependencyRow,
    ProjectFileRow,
    TaskRow,
    TaskLogRow,
} from './types.js';

// ============================================================
// Query class with prepared statements
// ============================================================

export class Queries {
    private db: Database.Database;

    // Prepared statements (lazily initialized)
    private _insertFile?: Database.Statement;
    private _updateFileHash?: Database.Statement;
    private _getFileByPath?: Database.Statement;
    private _getFileById?: Database.Statement;
    private _getAllFiles?: Database.Statement;
    private _deleteFile?: Database.Statement;

    private _insertLine?: Database.Statement;
    private _getLinesByFile?: Database.Statement;
    private _deleteLinesByFile?: Database.Statement;

    private _insertItem?: Database.Statement;
    private _getItemByTerm?: Database.Statement;
    private _deleteUnusedItems?: Database.Statement;

    private _insertOccurrence?: Database.Statement;
    private _getOccurrencesByItem?: Database.Statement;
    private _getOccurrencesByFile?: Database.Statement;
    private _deleteOccurrencesByFile?: Database.Statement;

    private _insertSignature?: Database.Statement;
    private _getSignatureByFile?: Database.Statement;
    private _deleteSignatureByFile?: Database.Statement;

    private _insertMethod?: Database.Statement;
    private _getMethodsByFile?: Database.Statement;
    private _deleteMethodsByFile?: Database.Statement;

    private _insertType?: Database.Statement;
    private _getTypesByFile?: Database.Statement;
    private _deleteTypesByFile?: Database.Statement;

    constructor(database: ChronicleDatabase) {
        this.db = database.getDb();
    }

    // --------------------------------------------------------
    // Files
    // --------------------------------------------------------

    insertFile(path: string, hash: string): number {
        this._insertFile ??= this.db.prepare(
            'INSERT INTO files (path, hash, last_indexed) VALUES (?, ?, ?)'
        );
        const result = this._insertFile.run(path, hash, Date.now());
        return result.lastInsertRowid as number;
    }

    updateFileHash(id: number, hash: string): void {
        this._updateFileHash ??= this.db.prepare(
            'UPDATE files SET hash = ?, last_indexed = ? WHERE id = ?'
        );
        this._updateFileHash.run(hash, Date.now(), id);
    }

    getFileByPath(path: string): FileRow | undefined {
        this._getFileByPath ??= this.db.prepare(
            'SELECT * FROM files WHERE path = ?'
        );
        return this._getFileByPath.get(path) as FileRow | undefined;
    }

    getFileById(id: number): FileRow | undefined {
        this._getFileById ??= this.db.prepare(
            'SELECT * FROM files WHERE id = ?'
        );
        return this._getFileById.get(id) as FileRow | undefined;
    }

    getAllFiles(): FileRow[] {
        this._getAllFiles ??= this.db.prepare('SELECT * FROM files ORDER BY path');
        return this._getAllFiles.all() as FileRow[];
    }

    deleteFile(id: number): void {
        this._deleteFile ??= this.db.prepare('DELETE FROM files WHERE id = ?');
        this._deleteFile.run(id);
    }

    // --------------------------------------------------------
    // Lines
    // --------------------------------------------------------

    insertLine(fileId: number, lineNumber: number, lineType: LineRow['line_type'], lineHash?: string, modified?: number): number {
        this._insertLine ??= this.db.prepare(
            'INSERT INTO lines (file_id, line_number, line_type, line_hash, modified) VALUES (?, ?, ?, ?, ?)'
        );
        const result = this._insertLine.run(fileId, lineNumber, lineType, lineHash ?? null, modified ?? Date.now());
        return result.lastInsertRowid as number;
    }

    getLinesByFile(fileId: number): LineRow[] {
        this._getLinesByFile ??= this.db.prepare(
            'SELECT * FROM lines WHERE file_id = ? ORDER BY line_number'
        );
        return this._getLinesByFile.all(fileId) as LineRow[];
    }

    deleteLinesByFile(fileId: number): void {
        this._deleteLinesByFile ??= this.db.prepare(
            'DELETE FROM lines WHERE file_id = ?'
        );
        this._deleteLinesByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Items
    // --------------------------------------------------------

    insertItem(term: string): number {
        this._insertItem ??= this.db.prepare(
            'INSERT INTO items (term) VALUES (?)'
        );
        const result = this._insertItem.run(term);
        return result.lastInsertRowid as number;
    }

    getOrCreateItem(term: string): number {
        const existing = this.getItemByTerm(term);
        if (existing) {
            return existing.id;
        }
        return this.insertItem(term);
    }

    getItemByTerm(term: string): ItemRow | undefined {
        this._getItemByTerm ??= this.db.prepare(
            'SELECT * FROM items WHERE term = ? COLLATE NOCASE'
        );
        return this._getItemByTerm.get(term) as ItemRow | undefined;
    }

    deleteUnusedItems(): number {
        this._deleteUnusedItems ??= this.db.prepare(
            'DELETE FROM items WHERE NOT EXISTS (SELECT 1 FROM occurrences WHERE occurrences.item_id = items.id)'
        );
        const result = this._deleteUnusedItems.run();
        return result.changes;
    }

    // --------------------------------------------------------
    // Occurrences
    // --------------------------------------------------------

    insertOccurrence(itemId: number, fileId: number, lineId: number): void {
        this._insertOccurrence ??= this.db.prepare(
            'INSERT OR IGNORE INTO occurrences (item_id, file_id, line_id) VALUES (?, ?, ?)'
        );
        this._insertOccurrence.run(itemId, fileId, lineId);
    }

    getOccurrencesByItem(itemId: number): Array<{ file_id: number; line_id: number; line_number: number; path: string; line_type: string; modified: number | null }> {
        this._getOccurrencesByItem ??= this.db.prepare(`
            SELECT o.file_id, o.line_id, l.line_number, f.path, l.line_type, l.modified
            FROM occurrences o
            JOIN lines l ON o.file_id = l.file_id AND o.line_id = l.id
            JOIN files f ON o.file_id = f.id
            WHERE o.item_id = ?
            ORDER BY f.path, l.line_number
        `);
        return this._getOccurrencesByItem.all(itemId) as Array<{ file_id: number; line_id: number; line_number: number; path: string; line_type: string; modified: number | null }>;
    }

    getOccurrencesByFile(fileId: number): OccurrenceRow[] {
        this._getOccurrencesByFile ??= this.db.prepare(
            'SELECT * FROM occurrences WHERE file_id = ?'
        );
        return this._getOccurrencesByFile.all(fileId) as OccurrenceRow[];
    }

    deleteOccurrencesByFile(fileId: number): void {
        this._deleteOccurrencesByFile ??= this.db.prepare(
            'DELETE FROM occurrences WHERE file_id = ?'
        );
        this._deleteOccurrencesByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Signatures
    // --------------------------------------------------------

    insertSignature(fileId: number, headerComments: string | null): void {
        this._insertSignature ??= this.db.prepare(
            'INSERT OR REPLACE INTO signatures (file_id, header_comments) VALUES (?, ?)'
        );
        this._insertSignature.run(fileId, headerComments);
    }

    getSignatureByFile(fileId: number): SignatureRow | undefined {
        this._getSignatureByFile ??= this.db.prepare(
            'SELECT * FROM signatures WHERE file_id = ?'
        );
        return this._getSignatureByFile.get(fileId) as SignatureRow | undefined;
    }

    deleteSignatureByFile(fileId: number): void {
        this._deleteSignatureByFile ??= this.db.prepare(
            'DELETE FROM signatures WHERE file_id = ?'
        );
        this._deleteSignatureByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Methods
    // --------------------------------------------------------

    insertMethod(
        fileId: number,
        name: string,
        prototype: string,
        lineNumber: number,
        visibility: string | null = null,
        isStatic = false,
        isAsync = false
    ): number {
        this._insertMethod ??= this.db.prepare(
            'INSERT INTO methods (file_id, name, prototype, line_number, visibility, is_static, is_async) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        const result = this._insertMethod.run(fileId, name, prototype, lineNumber, visibility, isStatic ? 1 : 0, isAsync ? 1 : 0);
        return result.lastInsertRowid as number;
    }

    getMethodsByFile(fileId: number): MethodRow[] {
        this._getMethodsByFile ??= this.db.prepare(
            'SELECT * FROM methods WHERE file_id = ? ORDER BY line_number'
        );
        return this._getMethodsByFile.all(fileId) as MethodRow[];
    }

    deleteMethodsByFile(fileId: number): void {
        this._deleteMethodsByFile ??= this.db.prepare(
            'DELETE FROM methods WHERE file_id = ?'
        );
        this._deleteMethodsByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Types
    // --------------------------------------------------------

    insertType(
        fileId: number,
        name: string,
        kind: TypeRow['kind'],
        lineNumber: number
    ): number {
        this._insertType ??= this.db.prepare(
            'INSERT INTO types (file_id, name, kind, line_number) VALUES (?, ?, ?, ?)'
        );
        const result = this._insertType.run(fileId, name, kind, lineNumber);
        return result.lastInsertRowid as number;
    }

    getTypesByFile(fileId: number): TypeRow[] {
        this._getTypesByFile ??= this.db.prepare(
            'SELECT * FROM types WHERE file_id = ? ORDER BY line_number'
        );
        return this._getTypesByFile.all(fileId) as TypeRow[];
    }

    deleteTypesByFile(fileId: number): void {
        this._deleteTypesByFile ??= this.db.prepare(
            'DELETE FROM types WHERE file_id = ?'
        );
        this._deleteTypesByFile.run(fileId);
    }

    // --------------------------------------------------------
    // Query: Search items
    // --------------------------------------------------------

    searchItems(
        term: string,
        mode: 'exact' | 'contains' | 'starts_with' = 'exact',
        limit = 100
    ): ItemRow[] {
        let sql: string;
        let param: string;

        switch (mode) {
            case 'exact':
                sql = 'SELECT * FROM items WHERE term = ? COLLATE NOCASE LIMIT ?';
                param = term;
                break;
            case 'contains': {
                const escaped = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
                sql = "SELECT * FROM items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT ?";
                param = `%${escaped}%`;
                break;
            }
            case 'starts_with': {
                const escaped = term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
                sql = "SELECT * FROM items WHERE term LIKE ? ESCAPE '\\' COLLATE NOCASE LIMIT ?";
                param = `${escaped}%`;
                break;
            }
        }

        return this.db.prepare(sql).all(param, limit) as ItemRow[];
    }

    // --------------------------------------------------------
    // Bulk operations
    // --------------------------------------------------------

    /**
     * Clear all data for a file (before re-indexing)
     */
    clearFileData(fileId: number): void {
        // Order matters due to foreign keys
        this.deleteOccurrencesByFile(fileId);
        this.deleteMethodsByFile(fileId);
        this.deleteTypesByFile(fileId);
        this.deleteSignatureByFile(fileId);
        this.deleteLinesByFile(fileId);
    }

    /**
     * Bulk insert lines
     */
    bulkInsertLines(fileId: number, lines: Array<{ lineId?: number; lineNumber: number; lineType: LineRow['line_type']; lineHash?: string; modified?: number }>): void {
        const stmt = this.db.prepare(
            'INSERT INTO lines (file_id, line_number, line_type, line_hash, modified) VALUES (?, ?, ?, ?, ?)'
        );
        const now = Date.now();
        for (const line of lines) {
            stmt.run(fileId, line.lineNumber, line.lineType, line.lineHash ?? null, line.modified ?? now);
        }
    }

    /**
     * Bulk insert occurrences
     */
    bulkInsertOccurrences(occurrences: Array<{ itemId: number; fileId: number; lineId: number }>): void {
        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO occurrences (item_id, file_id, line_id) VALUES (?, ?, ?)'
        );
        for (const occ of occurrences) {
            stmt.run(occ.itemId, occ.fileId, occ.lineId);
        }
    }

    // --------------------------------------------------------
    // Project Files (project structure)
    // --------------------------------------------------------

    private _insertProjectFile?: Database.Statement;
    private _getProjectFiles?: Database.Statement;
    private _getProjectFilesByType?: Database.Statement;
    private _clearProjectFiles?: Database.Statement;

    private _insertTask?: Database.Statement;
    private _deleteTask?: Database.Statement;
    private _getTaskById?: Database.Statement;
    private _getTasksByStatus?: Database.Statement;
    private _getAllTasks?: Database.Statement;
    private _insertTaskLog?: Database.Statement;
    private _getTaskLog?: Database.Statement;

    insertProjectFile(path: string, type: ProjectFileRow['type'], extension: string | null, indexed: boolean): void {
        this._insertProjectFile ??= this.db.prepare(
            'INSERT OR REPLACE INTO project_files (path, type, extension, indexed) VALUES (?, ?, ?, ?)'
        );
        this._insertProjectFile.run(path, type, extension, indexed ? 1 : 0);
    }

    getProjectFiles(): ProjectFileRow[] {
        this._getProjectFiles ??= this.db.prepare(
            'SELECT * FROM project_files ORDER BY path'
        );
        return this._getProjectFiles.all() as ProjectFileRow[];
    }

    getProjectFilesByType(type: ProjectFileRow['type']): ProjectFileRow[] {
        this._getProjectFilesByType ??= this.db.prepare(
            'SELECT * FROM project_files WHERE type = ? ORDER BY path'
        );
        return this._getProjectFilesByType.all(type) as ProjectFileRow[];
    }

    clearProjectFiles(): void {
        this._clearProjectFiles ??= this.db.prepare('DELETE FROM project_files');
        this._clearProjectFiles.run();
    }

    // --------------------------------------------------------
    // Tasks
    // --------------------------------------------------------

    insertTask(
        title: string,
        description: string | null,
        priority: 1 | 2 | 3,
        status: 'backlog' | 'active' | 'done' | 'cancelled',
        tags: string | null,
        source: string | null,
        sortOrder: number
    ): number {
        this._insertTask ??= this.db.prepare(
            'INSERT INTO tasks (title, description, priority, status, tags, source, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        const now = Date.now();
        const result = this._insertTask.run(title, description, priority, status, tags, source, sortOrder, now, now);
        return result.lastInsertRowid as number;
    }

    updateTask(id: number, fields: Partial<Pick<TaskRow, 'title' | 'description' | 'priority' | 'status' | 'tags' | 'source' | 'sort_order'>>): boolean {
        const allowed = ['title', 'description', 'status', 'priority', 'tags', 'source', 'sort_order'] as const;
        const sets: string[] = [];
        const values: unknown[] = [];

        for (const key of allowed) {
            if (key in fields) {
                sets.push(`${key} = ?`);
                values.push(fields[key as keyof typeof fields]);
            }
        }
        if (sets.length === 0) return false;

        const now = Date.now();
        sets.push('updated_at = ?');
        values.push(now);

        // Auto-manage completed_at based on status transitions
        if (fields.status === 'done') {
            sets.push('completed_at = ?');
            values.push(now);
        } else if (fields.status === 'active' || fields.status === 'backlog') {
            sets.push('completed_at = ?');
            values.push(null);
        }

        values.push(id);
        const result = this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
        return result.changes > 0;
    }

    deleteTask(id: number): boolean {
        this._deleteTask ??= this.db.prepare('DELETE FROM tasks WHERE id = ?');
        const result = this._deleteTask.run(id);
        return result.changes > 0;
    }

    getTaskById(id: number): TaskRow | undefined {
        this._getTaskById ??= this.db.prepare('SELECT * FROM tasks WHERE id = ?');
        return this._getTaskById.get(id) as TaskRow | undefined;
    }

    getAllTasks(): TaskRow[] {
        this._getAllTasks ??= this.db.prepare(
            'SELECT * FROM tasks ORDER BY CASE status WHEN \'active\' THEN 0 WHEN \'backlog\' THEN 1 WHEN \'done\' THEN 2 END, priority ASC, sort_order ASC, created_at DESC'
        );
        return this._getAllTasks.all() as TaskRow[];
    }

    getTasksByStatus(status: string): TaskRow[] {
        this._getTasksByStatus ??= this.db.prepare(
            'SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, sort_order ASC, created_at DESC'
        );
        return this._getTasksByStatus.all(status) as TaskRow[];
    }

    // --------------------------------------------------------
    // Task Log
    // --------------------------------------------------------

    insertTaskLog(taskId: number, note: string): number {
        this._insertTaskLog ??= this.db.prepare(
            'INSERT INTO task_log (task_id, note, created_at) VALUES (?, ?, ?)'
        );
        const result = this._insertTaskLog.run(taskId, note, Date.now());
        return result.lastInsertRowid as number;
    }

    getTaskLog(taskId: number): TaskLogRow[] {
        this._getTaskLog ??= this.db.prepare(
            'SELECT * FROM task_log WHERE task_id = ? ORDER BY created_at DESC'
        );
        return this._getTaskLog.all(taskId) as TaskLogRow[];
    }
}

/**
 * Create a Queries instance for the given database
 */
export function createQueries(database: ChronicleDatabase): Queries {
    return new Queries(database);
}
