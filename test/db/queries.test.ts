import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase } from '../../src/db/database.js';
import { Queries, createQueries } from '../../src/db/queries.js';

let tempDir: string;
let queries: Queries;
let closeDb: () => void;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chronicle-test-'));
    const db = createDatabase(join(tempDir, 'index.db'));
    queries = createQueries(db);
    closeDb = () => db.close();
});

afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
});

describe('Queries - Files', () => {
    test('insertFile and getFileByPath', () => {
        const id = queries.insertFile('src/main.ts', 'abc123');
        expect(id).toBeGreaterThan(0);

        const file = queries.getFileByPath('src/main.ts');
        expect(file).toBeDefined();
        expect(file!.path).toBe('src/main.ts');
        expect(file!.hash).toBe('abc123');
    });

    test('getFileById returns inserted file', () => {
        const id = queries.insertFile('src/app.ts', 'def456');
        const file = queries.getFileById(id);
        expect(file).toBeDefined();
        expect(file!.id).toBe(id);
    });

    test('getAllFiles returns all inserted files sorted by path', () => {
        queries.insertFile('src/b.ts', 'h1');
        queries.insertFile('src/a.ts', 'h2');

        const files = queries.getAllFiles();
        expect(files).toHaveLength(2);
        expect(files[0].path).toBe('src/a.ts');
        expect(files[1].path).toBe('src/b.ts');
    });

    test('updateFileHash updates hash and timestamp', () => {
        const id = queries.insertFile('src/main.ts', 'old');
        queries.updateFileHash(id, 'new');

        const file = queries.getFileById(id);
        expect(file!.hash).toBe('new');
    });

    test('deleteFile removes file', () => {
        const id = queries.insertFile('src/main.ts', 'abc');
        queries.deleteFile(id);

        expect(queries.getFileById(id)).toBeUndefined();
    });
});

describe('Queries - Items', () => {
    test('insertItem and getItemByTerm', () => {
        const id = queries.insertItem('MyClass');
        expect(id).toBeGreaterThan(0);

        const item = queries.getItemByTerm('MyClass');
        expect(item).toBeDefined();
        expect(item!.term).toBe('MyClass');
    });

    test('getItemByTerm is case-insensitive', () => {
        queries.insertItem('MyClass');

        const item = queries.getItemByTerm('myclass');
        expect(item).toBeDefined();
        expect(item!.term).toBe('MyClass');
    });

    test('getOrCreateItem returns existing item', () => {
        const id1 = queries.insertItem('Existing');
        const id2 = queries.getOrCreateItem('Existing');
        expect(id2).toBe(id1);
    });

    test('getOrCreateItem creates new item when missing', () => {
        const id = queries.getOrCreateItem('NewTerm');
        expect(id).toBeGreaterThan(0);

        const item = queries.getItemByTerm('NewTerm');
        expect(item).toBeDefined();
    });

    test('searchItems exact mode', () => {
        queries.insertItem('handleClick');
        queries.insertItem('handleSubmit');
        queries.insertItem('onClick');

        const results = queries.searchItems('handleClick', 'exact');
        expect(results).toHaveLength(1);
        expect(results[0].term).toBe('handleClick');
    });

    test('searchItems contains mode', () => {
        queries.insertItem('handleClick');
        queries.insertItem('handleSubmit');
        queries.insertItem('onClick');

        const results = queries.searchItems('handle', 'contains');
        expect(results).toHaveLength(2);
    });

    test('searchItems starts_with mode', () => {
        queries.insertItem('handleClick');
        queries.insertItem('handleSubmit');
        queries.insertItem('onClick');

        const results = queries.searchItems('handle', 'starts_with');
        expect(results).toHaveLength(2);
    });

    test('searchItems respects limit', () => {
        for (let i = 0; i < 10; i++) {
            queries.insertItem(`item${i}`);
        }

        const results = queries.searchItems('item', 'starts_with', 3);
        expect(results).toHaveLength(3);
    });

    test('deleteUnusedItems removes orphaned items', () => {
        queries.insertItem('orphan');
        const deleted = queries.deleteUnusedItems();
        expect(deleted).toBe(1);
        expect(queries.getItemByTerm('orphan')).toBeUndefined();
    });
});

describe('Queries - Lines and Occurrences', () => {
    test('insertLine and getLinesByFile', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        queries.insertLine(fileId, 1, 'code', 'linehash1');
        queries.insertLine(fileId, 5, 'method', 'linehash2');

        const lines = queries.getLinesByFile(fileId);
        expect(lines).toHaveLength(2);
        expect(lines[0].line_number).toBe(1);
        expect(lines[0].line_type).toBe('code');
        expect(lines[1].line_number).toBe(5);
        expect(lines[1].line_type).toBe('method');
    });

    test('insertOccurrence and getOccurrencesByItem', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        const lineId = queries.insertLine(fileId, 10, 'code');
        const itemId = queries.insertItem('myFunc');

        queries.insertOccurrence(itemId, fileId, lineId);

        const occs = queries.getOccurrencesByItem(itemId);
        expect(occs).toHaveLength(1);
        expect(occs[0].path).toBe('src/test.ts');
        expect(occs[0].line_number).toBe(10);
    });

    test('duplicate occurrences are ignored', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        const lineId = queries.insertLine(fileId, 10, 'code');
        const itemId = queries.insertItem('myFunc');

        queries.insertOccurrence(itemId, fileId, lineId);
        queries.insertOccurrence(itemId, fileId, lineId); // duplicate

        const occs = queries.getOccurrencesByItem(itemId);
        expect(occs).toHaveLength(1);
    });
});

describe('Queries - Methods and Types', () => {
    test('insertMethod and getMethodsByFile', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        queries.insertMethod(fileId, 'doThing', 'doThing(): void', 10, 'public', true, true);

        const methods = queries.getMethodsByFile(fileId);
        expect(methods).toHaveLength(1);
        expect(methods[0].name).toBe('doThing');
        expect(methods[0].prototype).toBe('doThing(): void');
        expect(methods[0].visibility).toBe('public');
        expect(methods[0].is_static).toBe(1);
        expect(methods[0].is_async).toBe(1);
    });

    test('insertType and getTypesByFile', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        queries.insertType(fileId, 'MyClass', 'class', 5);
        queries.insertType(fileId, 'MyInterface', 'interface', 20);

        const types = queries.getTypesByFile(fileId);
        expect(types).toHaveLength(2);
        expect(types[0].name).toBe('MyClass');
        expect(types[0].kind).toBe('class');
        expect(types[1].name).toBe('MyInterface');
        expect(types[1].kind).toBe('interface');
    });
});

describe('Queries - Signatures', () => {
    test('insertSignature and getSignatureByFile', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        queries.insertSignature(fileId, 'This is a test file');

        const sig = queries.getSignatureByFile(fileId);
        expect(sig).toBeDefined();
        expect(sig!.header_comments).toBe('This is a test file');
    });
});

describe('Queries - Tasks', () => {
    test('task CRUD operations', () => {
        const id = queries.insertTask('Fix bug', 'A nasty bug', 1, 'backlog', 'bug', null, 0);
        expect(id).toBeGreaterThan(0);

        const task = queries.getTaskById(id);
        expect(task).toBeDefined();
        expect(task!.title).toBe('Fix bug');
        expect(task!.priority).toBe(1);
        expect(task!.status).toBe('backlog');

        queries.updateTask(id, { status: 'active' });
        const updated = queries.getTaskById(id);
        expect(updated!.status).toBe('active');

        queries.updateTask(id, { status: 'done' });
        const done = queries.getTaskById(id);
        expect(done!.status).toBe('done');
        expect(done!.completed_at).not.toBeNull();

        queries.deleteTask(id);
        expect(queries.getTaskById(id)).toBeUndefined();
    });

    test('task log operations', () => {
        const taskId = queries.insertTask('Task', null, 2, 'backlog', null, null, 0);
        queries.insertTaskLog(taskId, 'Started investigation');
        queries.insertTaskLog(taskId, 'Found root cause');

        const log = queries.getTaskLog(taskId);
        expect(log).toHaveLength(2);
        // Both inserted in same millisecond, so order depends on id DESC via created_at
        const notes = log.map(l => l.note);
        expect(notes).toContain('Started investigation');
        expect(notes).toContain('Found root cause');
    });

    test('getAllTasks and getTasksByStatus', () => {
        queries.insertTask('Task A', null, 2, 'backlog', null, null, 0);
        queries.insertTask('Task B', null, 1, 'active', null, null, 0);

        const all = queries.getAllTasks();
        expect(all).toHaveLength(2);
        expect(all[0].status).toBe('active'); // active sorts first

        const backlog = queries.getTasksByStatus('backlog');
        expect(backlog).toHaveLength(1);
        expect(backlog[0].title).toBe('Task A');
    });
});

describe('Queries - Bulk Operations', () => {
    test('clearFileData removes all related data', () => {
        const fileId = queries.insertFile('src/test.ts', 'h1');
        const lineId = queries.insertLine(fileId, 1, 'code');
        const itemId = queries.insertItem('term');
        queries.insertOccurrence(itemId, fileId, lineId);
        queries.insertMethod(fileId, 'fn', 'fn()', 1);
        queries.insertType(fileId, 'T', 'class', 1);
        queries.insertSignature(fileId, 'header');

        queries.clearFileData(fileId);

        expect(queries.getLinesByFile(fileId)).toHaveLength(0);
        expect(queries.getOccurrencesByFile(fileId)).toHaveLength(0);
        expect(queries.getMethodsByFile(fileId)).toHaveLength(0);
        expect(queries.getTypesByFile(fileId)).toHaveLength(0);
        expect(queries.getSignatureByFile(fileId)).toBeUndefined();
    });
});
