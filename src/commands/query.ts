/**
 * query command - Search for terms in the index
 */

import { validateProjectIndex, withDatabase, parseTimeOffset, normalizePath, globToRegex } from '../utils/index.js';

// ============================================================
// Types
// ============================================================

export type QueryMode = 'exact' | 'contains' | 'starts_with';

export interface QueryParams {
    path: string;
    term: string;
    mode?: QueryMode;
    fileFilter?: string;
    typeFilter?: string[];
    modifiedSince?: string;
    modifiedBefore?: string;
    limit?: number;
}

export interface QueryMatch {
    file: string;
    lineNumber: number;
    lineType: string;
    modified?: number;
}

export interface QueryResult {
    success: boolean;
    term: string;
    mode: QueryMode;
    matches: QueryMatch[];
    totalMatches: number;
    truncated: boolean;
    error?: string;
}

// Re-export parseTimeOffset for backward compatibility (used by commands/index.ts)
export { parseTimeOffset } from '../utils/index.js';

// ============================================================
// Main query function
// ============================================================

export function query(params: QueryParams): QueryResult {
    const mode = params.mode ?? 'exact';
    const limit = params.limit ?? 100;

    // Validate project path
    const validation = validateProjectIndex(params.path);
    if (!validation.valid) {
        return {
            success: false,
            term: params.term,
            mode,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: validation.error,
        };
    }

    try {
        return withDatabase(validation.dbPath, true, (_db, queries) => {
            // Search for items
            const items = queries.searchItems(params.term, mode, 1000);

            if (items.length === 0) {
                return {
                    success: true,
                    term: params.term,
                    mode,
                    matches: [],
                    totalMatches: 0,
                    truncated: false,
                };
            }

            // Parse time filters
            const modifiedSinceTs = params.modifiedSince ? parseTimeOffset(params.modifiedSince) : null;
            const modifiedBeforeTs = params.modifiedBefore ? parseTimeOffset(params.modifiedBefore) : null;

            // Pre-compile file filter regex
            const fileFilterRegex = params.fileFilter ? globToRegex(params.fileFilter) : null;

            // Collect all occurrences
            let allMatches: QueryMatch[] = [];

            for (const item of items) {
                const occurrences = queries.getOccurrencesByItem(item.id);

                for (const occ of occurrences) {
                    // Apply file filter
                    if (fileFilterRegex && !fileFilterRegex.test(normalizePath(occ.path))) {
                        continue;
                    }

                    // Apply type filter
                    if (params.typeFilter && params.typeFilter.length > 0) {
                        if (!params.typeFilter.includes(occ.line_type)) {
                            continue;
                        }
                    }

                    // Apply time filters
                    if (modifiedSinceTs !== null && occ.modified !== null) {
                        if (occ.modified < modifiedSinceTs) {
                            continue;
                        }
                    }
                    if (modifiedBeforeTs !== null && occ.modified !== null) {
                        if (occ.modified > modifiedBeforeTs) {
                            continue;
                        }
                    }

                    allMatches.push({
                        file: occ.path,
                        lineNumber: occ.line_number,
                        lineType: occ.line_type,
                        modified: occ.modified ?? undefined,
                    });
                }
            }

            // Remove duplicates (same file + line)
            const seen = new Set<string>();
            allMatches = allMatches.filter(m => {
                const key = `${m.file}:${m.lineNumber}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            // Sort by file, then line number
            allMatches.sort((a, b) => {
                const fileCompare = a.file.localeCompare(b.file);
                if (fileCompare !== 0) return fileCompare;
                return a.lineNumber - b.lineNumber;
            });

            const totalMatches = allMatches.length;
            const truncated = allMatches.length > limit;

            if (truncated) {
                allMatches = allMatches.slice(0, limit);
            }

            return {
                success: true,
                term: params.term,
                mode,
                matches: allMatches,
                totalMatches,
                truncated,
            };
        });

    } catch (error) {
        return {
            success: false,
            term: params.term,
            mode,
            matches: [],
            totalMatches: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
