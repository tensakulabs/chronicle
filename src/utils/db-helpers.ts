/**
 * Database helper utilities
 *
 * Eliminates duplicated patterns across command files:
 * - validateProjectIndex: checks if .chronicle/index.db exists
 * - withDatabase: open/try/finally-close pattern
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { PRODUCT_NAME, INDEX_DIR, TOOL_PREFIX } from '../constants.js';
import { openDatabase, createQueries, type ChronicleDatabase, type Queries } from '../db/index.js';

// ============================================================
// validateProjectIndex
// ============================================================

export type ValidateResult =
    | { valid: true; dbPath: string }
    | { valid: false; error: string };

/**
 * Validate that a Chronicle index exists at the given project path.
 * Returns the dbPath on success, or an error message on failure.
 */
export function validateProjectIndex(projectPath: string): ValidateResult {
    const dbPath = join(projectPath, INDEX_DIR, 'index.db');
    if (!existsSync(dbPath)) {
        return {
            valid: false,
            error: `No ${PRODUCT_NAME} index found at ${projectPath}. Run ${TOOL_PREFIX}init first.`,
        };
    }
    return { valid: true, dbPath };
}

// ============================================================
// withDatabase
// ============================================================

/**
 * Open a database, run a function, and close the database in a finally block.
 * Eliminates the repeated open/try/catch/finally-close pattern.
 */
export function withDatabase<T>(
    dbPath: string,
    readonly: boolean,
    fn: (db: ChronicleDatabase, queries: Queries) => T
): T {
    const db = openDatabase(dbPath, readonly);
    const queries = createQueries(db);
    try {
        return fn(db, queries);
    } finally {
        db.close();
    }
}
