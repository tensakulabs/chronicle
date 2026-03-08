import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChronicleDatabase, createDatabase, openDatabase } from '../../src/db/database.js';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chronicle-test-'));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('ChronicleDatabase', () => {
    test('createDatabase initializes schema and metadata', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath, 'test-project', '/tmp/test');

        expect(db.getMetadata('schema_version')).toBe('1.0');
        expect(db.getMetadata('project_name')).toBe('test-project');
        expect(db.getMetadata('project_root')).toBe('/tmp/test');
        expect(db.getMetadata('last_indexed')).not.toBeNull();

        db.close();
    });

    test('openDatabase opens existing database in readonly mode', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath, 'test-project');
        db.close();

        const readonlyDb = openDatabase(dbPath, true);
        expect(readonlyDb.getMetadata('project_name')).toBe('test-project');
        readonlyDb.close();
    });

    test('setMetadata and getMetadata round-trip', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        db.setMetadata('custom_key', 'custom_value');
        expect(db.getMetadata('custom_key')).toBe('custom_value');

        db.setMetadata('custom_key', 'updated');
        expect(db.getMetadata('custom_key')).toBe('updated');

        db.close();
    });

    test('deleteMetadata removes entry', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        db.setMetadata('to_delete', 'value');
        expect(db.getMetadata('to_delete')).toBe('value');

        db.deleteMetadata('to_delete');
        expect(db.getMetadata('to_delete')).toBeNull();

        db.close();
    });

    test('getMetadata returns null for non-existent key', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        expect(db.getMetadata('nonexistent')).toBeNull();

        db.close();
    });

    test('getStats returns zero counts for empty database', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        const stats = db.getStats();
        expect(stats.files).toBe(0);
        expect(stats.lines).toBe(0);
        expect(stats.items).toBe(0);
        expect(stats.occurrences).toBe(0);
        expect(stats.methods).toBe(0);
        expect(stats.types).toBe(0);
        expect(stats.dependencies).toBe(0);
        expect(stats.sizeBytes).toBeGreaterThan(0);

        db.close();
    });

    test('transaction commits on success', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        db.transaction(() => {
            db.setMetadata('tx_key', 'tx_value');
        });

        expect(db.getMetadata('tx_key')).toBe('tx_value');
        db.close();
    });

    test('transaction rolls back on error', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        db.setMetadata('rollback_key', 'original');

        try {
            db.transaction(() => {
                db.setMetadata('rollback_key', 'changed');
                throw new Error('deliberate');
            });
        } catch {
            // expected
        }

        expect(db.getMetadata('rollback_key')).toBe('original');
        db.close();
    });

    test('note history operations', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        db.archiveNote('first note');
        db.archiveNote('second note');

        const history = db.getNoteHistory();
        expect(history).toHaveLength(2);
        expect(history[0].note).toBe('second note');
        expect(history[1].note).toBe('first note');

        const searched = db.searchNoteHistory('first');
        expect(searched).toHaveLength(1);
        expect(searched[0].note).toBe('first note');

        expect(db.countNoteHistory()).toBe(2);

        db.close();
    });

    test('getPath returns database file path', () => {
        const dbPath = join(tempDir, 'index.db');
        const db = createDatabase(dbPath);

        expect(db.getPath()).toBe(dbPath);

        db.close();
    });
});
