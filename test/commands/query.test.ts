import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { query, parseTimeOffset } from '../../src/commands/query.js';
import { createDatabase } from '../../src/db/database.js';
import { createQueries } from '../../src/db/queries.js';
import { INDEX_DIR } from '../../src/constants.js';

describe('parseTimeOffset', () => {
    test('parses minutes', () => {
        const result = parseTimeOffset('30m');
        expect(result).not.toBeNull();
        const expected = Date.now() - 30 * 60 * 1000;
        expect(Math.abs(result! - expected)).toBeLessThan(1000);
    });

    test('parses hours', () => {
        const result = parseTimeOffset('2h');
        expect(result).not.toBeNull();
        const expected = Date.now() - 2 * 60 * 60 * 1000;
        expect(Math.abs(result! - expected)).toBeLessThan(1000);
    });

    test('parses days', () => {
        const result = parseTimeOffset('1d');
        expect(result).not.toBeNull();
        const expected = Date.now() - 24 * 60 * 60 * 1000;
        expect(Math.abs(result! - expected)).toBeLessThan(1000);
    });

    test('parses weeks', () => {
        const result = parseTimeOffset('1w');
        expect(result).not.toBeNull();
        const expected = Date.now() - 7 * 24 * 60 * 60 * 1000;
        expect(Math.abs(result! - expected)).toBeLessThan(1000);
    });

    test('parses ISO date string', () => {
        const result = parseTimeOffset('2025-01-15T00:00:00Z');
        expect(result).not.toBeNull();
        expect(result).toBe(new Date('2025-01-15T00:00:00Z').getTime());
    });

    test('returns null for invalid input', () => {
        expect(parseTimeOffset('')).toBeNull();
        expect(parseTimeOffset('abc')).toBeNull();
        expect(parseTimeOffset('5x')).toBeNull();
    });
});

describe('query', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'chronicle-query-test-'));
        // Create .chronicle directory structure
        mkdirSync(join(tempDir, INDEX_DIR), { recursive: true });

        // Create and populate a test database
        const dbPath = join(tempDir, INDEX_DIR, 'index.db');
        const db = createDatabase(dbPath, 'test-project', tempDir);
        const queries = createQueries(db);

        // Add test data
        const fileId = queries.insertFile('src/main.ts', 'hash1');
        const lineId1 = queries.insertLine(fileId, 10, 'code');
        const lineId2 = queries.insertLine(fileId, 20, 'method');

        const item1 = queries.insertItem('handleClick');
        const item2 = queries.insertItem('handleSubmit');
        const item3 = queries.insertItem('renderComponent');

        queries.insertOccurrence(item1, fileId, lineId1);
        queries.insertOccurrence(item2, fileId, lineId1);
        queries.insertOccurrence(item3, fileId, lineId2);

        const fileId2 = queries.insertFile('src/utils.ts', 'hash2');
        const lineId3 = queries.insertLine(fileId2, 5, 'code');
        queries.insertOccurrence(item1, fileId2, lineId3);

        db.close();
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    test('returns error when no index exists', () => {
        const result = query({ path: '/nonexistent', term: 'test' });
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });

    test('exact search finds specific term', () => {
        const result = query({ path: tempDir, term: 'handleClick' });
        expect(result.success).toBe(true);
        expect(result.matches.length).toBeGreaterThan(0);
        expect(result.matches.some(m => m.file === 'src/main.ts')).toBe(true);
    });

    test('exact search is case-insensitive', () => {
        const result = query({ path: tempDir, term: 'HANDLECLICK' });
        expect(result.success).toBe(true);
        expect(result.matches.length).toBeGreaterThan(0);
    });

    test('contains search finds partial matches', () => {
        const result = query({ path: tempDir, term: 'handle', mode: 'contains' });
        expect(result.success).toBe(true);
        // Should match handleClick and handleSubmit
        expect(result.totalMatches).toBeGreaterThanOrEqual(2);
    });

    test('starts_with search finds prefix matches', () => {
        const result = query({ path: tempDir, term: 'render', mode: 'starts_with' });
        expect(result.success).toBe(true);
        expect(result.totalMatches).toBeGreaterThanOrEqual(1);
    });

    test('returns empty for non-existent term', () => {
        const result = query({ path: tempDir, term: 'nonExistentIdentifier' });
        expect(result.success).toBe(true);
        expect(result.matches).toHaveLength(0);
        expect(result.totalMatches).toBe(0);
    });

    test('respects limit parameter', () => {
        const result = query({ path: tempDir, term: 'handle', mode: 'contains', limit: 1 });
        expect(result.success).toBe(true);
        expect(result.matches.length).toBeLessThanOrEqual(1);
    });

    test('file filter restricts results', () => {
        const result = query({
            path: tempDir,
            term: 'handleClick',
            fileFilter: 'src/utils*',
        });
        expect(result.success).toBe(true);
        for (const match of result.matches) {
            expect(match.file).toMatch(/^src\/utils/);
        }
    });

    test('type filter restricts by line type', () => {
        const result = query({
            path: tempDir,
            term: 'renderComponent',
            typeFilter: ['method'],
        });
        expect(result.success).toBe(true);
        for (const match of result.matches) {
            expect(match.lineType).toBe('method');
        }
    });
});
