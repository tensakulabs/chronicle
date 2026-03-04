/**
 * update command - Update index for a single file
 *
 * Supports:
 * - Full re-index of a file (no line range specified)
 * - Incremental update of a line range (from_line/to_line specified) - future
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { minimatch } from 'minimatch';

import { openDatabase, createQueries } from '../db/index.js';
import { shortHash } from './init.js';
import { validateProjectIndex, normalizePath, DEFAULT_EXCLUDE, readGitignore } from '../utils/index.js';
import { indexFileContent, type IndexFileContentResult } from './index-file.js';

// ============================================================
// Types
// ============================================================

export interface UpdateParams {
    path: string;           // Project path
    file: string;           // Relative file path
    fromLine?: number;      // Optional: Start of change (for future incremental update)
    toLine?: number;        // Optional: End of change (for future incremental update)
}

export interface UpdateResult {
    success: boolean;
    file: string;
    itemsAdded: number;
    itemsRemoved: number;
    methodsUpdated: number;
    typesUpdated: number;
    durationMs: number;
    error?: string;
}

// ============================================================
// Main update function
// ============================================================

export function update(params: UpdateParams): UpdateResult {
    const startTime = Date.now();
    const { path: projectPath } = params;
    // Normalize path to forward slashes (consistent with how paths are stored)
    const relativePath = normalizePath(params.file);

    // Validate project path
    const validation = validateProjectIndex(projectPath);
    if (!validation.valid) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: validation.error,
        };
    }

    // Check if file exists
    const absolutePath = join(projectPath, relativePath);
    if (!existsSync(absolutePath)) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: `File does not exist: ${relativePath}`,
        };
    }

    // Check if file is excluded (build/, node_modules/, .gitignore patterns, etc.)
    const gitignorePatterns = readGitignore(projectPath);
    const excludePatterns = [...DEFAULT_EXCLUDE, ...gitignorePatterns];
    const isExcluded = excludePatterns.some(pattern =>
        minimatch(relativePath, pattern, { dot: true })
    );
    if (isExcluded) {
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: `File is excluded by pattern: ${relativePath}`,
        };
    }

    // Open database
    const db = openDatabase(validation.dbPath);
    const queries = createQueries(db);

    try {
        // Check if file is already indexed
        const existingFile = queries.getFileByPath(relativePath);

        // Read file content
        let content: string;
        try {
            content = readFileSync(absolutePath, 'utf-8');
        } catch (err) {
            return {
                success: false,
                file: relativePath,
                itemsAdded: 0,
                itemsRemoved: 0,
                methodsUpdated: 0,
                typesUpdated: 0,
                durationMs: Date.now() - startTime,
                error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        // Calculate new hash
        const newHash = shortHash(content);

        // Check if file has actually changed
        if (existingFile && existingFile.hash === newHash) {
            return {
                success: true,
                file: relativePath,
                itemsAdded: 0,
                itemsRemoved: 0,
                methodsUpdated: 0,
                typesUpdated: 0,
                durationMs: Date.now() - startTime,
                error: 'File unchanged (hash match)',
            };
        }

        // Count old items for comparison
        let oldItemCount = 0;

        if (existingFile) {
            const oldOccurrences = queries.getOccurrencesByFile(existingFile.id);
            oldItemCount = new Set(oldOccurrences.map(o => o.item_id)).size;
        }

        // Build map of old line hashes to modified timestamps (for diff tracking)
        // Key is the hash, not line_number - so moved lines keep their timestamp
        const oldHashToModified = new Map<string, number>();
        if (existingFile) {
            const oldLines = queries.getLinesByFile(existingFile.id);
            for (const line of oldLines) {
                if (line.line_hash && line.modified) {
                    // If same hash appears multiple times, keep the oldest timestamp
                    const existing = oldHashToModified.get(line.line_hash);
                    if (!existing || line.modified < existing) {
                        oldHashToModified.set(line.line_hash, line.modified);
                    }
                }
            }
        }

        // Perform update in transaction
        let fileId: number;
        let result: IndexFileContentResult;

        db.transaction(() => {
            if (existingFile) {
                // Clear existing data for this file
                queries.clearFileData(existingFile.id);

                // Update hash
                queries.updateFileHash(existingFile.id, newHash);
                fileId = existingFile.id;
            } else {
                // Insert new file record
                fileId = queries.insertFile(relativePath, newHash);
            }

            // Delegate extraction and insertion to shared function
            result = indexFileContent({
                fileId,
                content,
                relativePath,
                queries,
                oldHashToModified,
            });
        });

        if (!result!.success) {
            db.close();
            return {
                success: false,
                file: relativePath,
                itemsAdded: 0,
                itemsRemoved: 0,
                methodsUpdated: 0,
                typesUpdated: 0,
                durationMs: Date.now() - startTime,
                error: result!.error,
            };
        }

        // Cleanup unused items
        queries.deleteUnusedItems();

        db.close();

        return {
            success: true,
            file: relativePath,
            itemsAdded: Math.max(0, result!.items - oldItemCount),
            itemsRemoved: Math.max(0, oldItemCount - result!.items),
            methodsUpdated: result!.methods,
            typesUpdated: result!.types,
            durationMs: Date.now() - startTime,
        };
    } catch (err) {
        db.close();
        return {
            success: false,
            file: relativePath,
            itemsAdded: 0,
            itemsRemoved: 0,
            methodsUpdated: 0,
            typesUpdated: 0,
            durationMs: Date.now() - startTime,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

// ============================================================
// Remove file from index
// ============================================================

export interface RemoveParams {
    path: string;           // Project path
    file: string;           // Relative file path
}

export interface RemoveResult {
    success: boolean;
    file: string;
    removed: boolean;
    error?: string;
}

export function remove(params: RemoveParams): RemoveResult {
    const { path: projectPath } = params;
    // Normalize path to forward slashes
    const relativePath = normalizePath(params.file);

    // Validate project path
    const validation = validateProjectIndex(projectPath);
    if (!validation.valid) {
        return {
            success: false,
            file: relativePath,
            removed: false,
            error: validation.error,
        };
    }

    // Open database
    const db = openDatabase(validation.dbPath);
    const queries = createQueries(db);

    try {
        const existingFile = queries.getFileByPath(relativePath);

        if (!existingFile) {
            db.close();
            return {
                success: true,
                file: relativePath,
                removed: false,
                error: 'File not found in index',
            };
        }

        // Delete file (CASCADE will handle related data)
        db.transaction(() => {
            queries.deleteFile(existingFile.id);
            queries.deleteUnusedItems();
        });

        db.close();

        return {
            success: true,
            file: relativePath,
            removed: true,
        };
    } catch (err) {
        db.close();
        return {
            success: false,
            file: relativePath,
            removed: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
