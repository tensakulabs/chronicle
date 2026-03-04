/**
 * Shared file indexing logic used by both init and update commands.
 *
 * Encapsulates: extraction, line insertion (with hash-based timestamp preservation),
 * item/occurrence insertion, method/type/signature insertion.
 */

import { extract } from '../parser/index.js';
import { shortHash } from './init.js';
import type { Queries } from '../db/index.js';

// ============================================================
// Types
// ============================================================

export interface IndexFileContentParams {
    /** Database file ID (already inserted/updated by caller) */
    fileId: number;
    /** Raw file content (UTF-8 string) */
    content: string;
    /** Relative file path (for language detection by extract()) */
    relativePath: string;
    /** Database queries instance */
    queries: Queries;
    /**
     * Map of old line hashes to their modified timestamps.
     * When provided, lines with unchanged hashes preserve their old timestamp
     * instead of getting `now`. Used by update.ts for the time-filter feature.
     * When omitted or empty, all lines get `now` as their modified timestamp.
     */
    oldHashToModified?: Map<string, number>;
}

export interface IndexFileContentResult {
    success: boolean;
    /** Number of unique items (terms) inserted */
    items: number;
    /** Number of methods inserted */
    methods: number;
    /** Number of types inserted */
    types: number;
    error?: string;
}

// ============================================================
// Shared indexing function
// ============================================================

/**
 * Index the content of a single file into the database.
 *
 * Assumes the caller has already:
 * - Inserted/updated the file record (providing fileId)
 * - Cleared old data if re-indexing
 * - Wrapped the call in a transaction if needed
 *
 * This function:
 * 1. Runs extract() to parse the file
 * 2. Inserts lines with hash tracking (preserving old timestamps when oldHashToModified is provided)
 * 3. Inserts items and occurrences
 * 4. Inserts methods
 * 5. Inserts types
 * 6. Inserts signatures (header comments)
 */
export function indexFileContent(params: IndexFileContentParams): IndexFileContentResult {
    const { fileId, content, relativePath, queries, oldHashToModified } = params;

    // Extract data from file
    const extraction = extract(content, relativePath);
    if (!extraction) {
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: 'Unsupported file type or parse error',
        };
    }

    // Split content into lines for hashing
    const contentLines = content.split('\n');
    const now = Date.now();

    // Insert lines and capture DB-assigned IDs (AUTOINCREMENT)
    const lineNumberToId = new Map<number, number>();
    for (const line of extraction.lines) {
        const lineContent = contentLines[line.lineNumber - 1] ?? '';
        const lineHash = shortHash(lineContent);

        // Preserve old timestamp if hash existed before, otherwise use now
        const oldModified = oldHashToModified?.get(lineHash);
        const modified = oldModified ?? now;

        const dbLineId = queries.insertLine(fileId, line.lineNumber, line.lineType, lineHash, modified);
        lineNumberToId.set(line.lineNumber, dbLineId);
    }

    // Insert items and occurrences
    const itemsInserted = new Set<string>();
    for (const item of extraction.items) {
        let itemLineId = lineNumberToId.get(item.lineNumber);
        if (itemLineId === undefined) {
            // Line wasn't recorded, add it now
            const lineContent = contentLines[item.lineNumber - 1] ?? '';
            const lineHash = shortHash(lineContent);

            const oldModified = oldHashToModified?.get(lineHash);
            const modified = oldModified ?? now;

            const newLineId = queries.insertLine(fileId, item.lineNumber, item.lineType, lineHash, modified);
            lineNumberToId.set(item.lineNumber, newLineId);
            itemLineId = newLineId;
        }

        const itemId = queries.getOrCreateItem(item.term);
        queries.insertOccurrence(itemId, fileId, itemLineId);
        itemsInserted.add(item.term);
    }

    // Insert methods
    for (const method of extraction.methods) {
        queries.insertMethod(
            fileId,
            method.name,
            method.prototype,
            method.lineNumber,
            method.visibility,
            method.isStatic,
            method.isAsync
        );
    }

    // Insert types
    for (const type of extraction.types) {
        queries.insertType(fileId, type.name, type.kind, type.lineNumber);
    }

    // Insert signature (header comments)
    if (extraction.headerComments.length > 0) {
        queries.insertSignature(fileId, extraction.headerComments.join('\n'));
    }

    return {
        success: true,
        items: itemsInserted.size,
        methods: extraction.methods.length,
        types: extraction.types.length,
    };
}
