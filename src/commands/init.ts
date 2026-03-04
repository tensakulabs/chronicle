/**
 * init command - Initialize Chronicle for a project
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, basename, extname } from 'path';
import { glob } from 'glob';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { INDEX_DIR } from '../constants.js';
import { DEFAULT_EXCLUDE, readGitignore, normalizePath } from '../utils/index.js';

// Re-export for backward compatibility (used by update.ts, session.ts)
export { DEFAULT_EXCLUDE, readGitignore };

/**
 * Compute a short (16-char) SHA256 hash of content.
 * Used consistently across init, update, and session for file/line hashing.
 */
export function shortHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

import { createDatabase, createQueries, type Queries } from '../db/index.js';
import { getSupportedExtensions } from '../parser/index.js';
import { indexFileContent } from './index-file.js';

// ============================================================
// Types
// ============================================================

export interface InitParams {
    path: string;
    name?: string;
    languages?: string[];
    exclude?: string[];
    fresh?: boolean;  // Force fresh re-index (delete all existing data)
}

export interface InitResult {
    success: boolean;
    indexPath: string;
    filesIndexed: number;
    filesSkipped: number;  // Unchanged files
    filesRemoved: number;  // Files removed due to exclude patterns
    itemsFound: number;
    methodsFound: number;
    typesFound: number;
    durationMs: number;
    errors: string[];
}

// ============================================================
// File type detection
// ============================================================

const CODE_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.cs', '.rs', '.py', '.pyw',
    '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx',
    '.java', '.go', '.php', '.rb', '.rake'
]);

const CONFIG_EXTENSIONS = new Set([
    '.json', '.yaml', '.yml', '.toml', '.xml', '.ini', '.env', '.config',
    '.eslintrc', '.prettierrc', '.babelrc', '.editorconfig'
]);

const DOC_EXTENSIONS = new Set([
    '.md', '.txt', '.rst', '.adoc', '.doc', '.docx', '.pdf'
]);

const ASSET_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm',
    '.zip', '.tar', '.gz', '.rar'
]);

type FileType = 'dir' | 'code' | 'config' | 'doc' | 'asset' | 'test' | 'other';

function detectFileType(filePath: string): FileType {
    const ext = extname(filePath).toLowerCase();
    const lowerPath = filePath.toLowerCase();

    // Check for test files first (before code check)
    if (lowerPath.includes('.test.') || lowerPath.includes('.spec.') ||
        lowerPath.includes('_test.') || lowerPath.includes('_spec.') ||
        lowerPath.includes('/test/') || lowerPath.includes('/tests/') ||
        lowerPath.includes('/__tests__/')) {
        return 'test';
    }

    if (CODE_EXTENSIONS.has(ext)) return 'code';
    if (CONFIG_EXTENSIONS.has(ext)) return 'config';
    if (DOC_EXTENSIONS.has(ext)) return 'doc';
    if (ASSET_EXTENSIONS.has(ext)) return 'asset';

    return 'other';
}

// ============================================================
// Main init function
// ============================================================

export async function init(params: InitParams): Promise<InitResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    // Validate project path
    if (!existsSync(params.path)) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Project path does not exist: ${params.path}`],
        };
    }

    const stat = statSync(params.path);
    if (!stat.isDirectory()) {
        return {
            success: false,
            indexPath: '',
            filesIndexed: 0,
            filesSkipped: 0,
            filesRemoved: 0,
            itemsFound: 0,
            methodsFound: 0,
            typesFound: 0,
            durationMs: Date.now() - startTime,
            errors: [`Path is not a directory: ${params.path}`],
        };
    }

    // Create index directory
    const indexDir = join(params.path, INDEX_DIR);
    if (!existsSync(indexDir)) {
        mkdirSync(indexDir, { recursive: true });
    }

    const dbPath = join(indexDir, 'index.db');
    const projectName = params.name ?? basename(params.path);

    // Determine if incremental (default) or fresh re-index
    const dbExists = existsSync(dbPath);
    const incremental = dbExists && !params.fresh;

    // Create database (incremental keeps existing data)
    const db = createDatabase(dbPath, projectName, params.path, incremental);
    const queries = createQueries(db);

    // Build glob pattern for supported files
    const extensions = getSupportedExtensions();
    const patterns = extensions.map(ext => `**/*${ext}`);

    // Merge exclude patterns (including .gitignore)
    const gitignorePatterns = readGitignore(params.path);
    const exclude = [...DEFAULT_EXCLUDE, ...gitignorePatterns, ...(params.exclude ?? [])];

    // Find all source files
    let files: string[] = [];
    for (const pattern of patterns) {
        const found = await glob(pattern, {
            cwd: params.path,
            ignore: exclude,
            nodir: true,
            absolute: false,
        });
        files.push(...found);
    }

    // Remove duplicates, normalize to forward slashes, and sort
    files = [...new Set(files)].map(f => normalizePath(f)).sort();

    // Index each file
    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalItems = 0;
    let totalMethods = 0;
    let totalTypes = 0;

    // Use transaction for bulk insert
    db.transaction(() => {
        for (const filePath of files) {
            try {
                const result = indexFile(params.path, filePath, queries, incremental);
                if (result.skipped) {
                    filesSkipped++;
                } else if (result.success) {
                    filesIndexed++;
                    totalItems += result.items;
                    totalMethods += result.methods;
                    totalTypes += result.types;
                } else if (result.error) {
                    errors.push(`${filePath}: ${result.error}`);
                }
            } catch (err) {
                errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    });

    // Cleanup unused items
    queries.deleteUnusedItems();

    // --------------------------------------------------------
    // Cleanup: Remove files that are now excluded
    // (e.g., build/ was indexed before exclude pattern was added)
    // --------------------------------------------------------
    let filesRemoved = 0;
    const existingFiles = queries.getAllFiles();

    db.transaction(() => {
        for (const file of existingFiles) {
            // Check if this file path matches any exclude pattern
            const shouldExclude = exclude.some(pattern =>
                minimatch(file.path, pattern, { dot: true })
            );

            if (shouldExclude) {
                // Remove from index
                queries.clearFileData(file.id);
                queries.deleteFile(file.id);
                filesRemoved++;
            }
        }
    });

    if (filesRemoved > 0) {
        // Cleanup items that are now orphaned
        queries.deleteUnusedItems();
    }

    // --------------------------------------------------------
    // Scan project structure (all files, not just code)
    // --------------------------------------------------------
    const indexedFilesSet = new Set(files);  // Code files we indexed

    // Find ALL files in project
    const allFiles = await glob('**/*', {
        cwd: params.path,
        ignore: exclude,
        nodir: true,
        absolute: false,
    });

    // Normalize paths and collect directories
    const directories = new Set<string>();
    const normalizedAllFiles = allFiles.map(f => normalizePath(f));

    for (const filePath of normalizedAllFiles) {
        // Extract all parent directories
        const parts = filePath.split('/');
        for (let i = 1; i < parts.length; i++) {
            directories.add(parts.slice(0, i).join('/'));
        }
    }

    // Insert directories
    db.transaction(() => {
        for (const dir of directories) {
            queries.insertProjectFile(dir, 'dir', null, false);
        }

        // Insert all files with type detection
        for (const filePath of normalizedAllFiles) {
            const ext = extname(filePath).toLowerCase() || null;
            const fileType = detectFileType(filePath);
            const isIndexed = indexedFilesSet.has(filePath);
            queries.insertProjectFile(filePath, fileType, ext, isIndexed);
        }
    });

    // Reset session tracking after full re-index
    const now = Date.now().toString();
    db.setMetadata('last_session_start', now);
    db.setMetadata('last_session_end', now);
    db.setMetadata('current_session_start', now);

    db.close();

    return {
        success: true,
        indexPath: indexDir,
        filesIndexed,
        filesSkipped,
        filesRemoved,
        itemsFound: totalItems,
        methodsFound: totalMethods,
        typesFound: totalTypes,
        durationMs: Date.now() - startTime,
        errors,
    };
}

// ============================================================
// File indexing
// ============================================================

interface IndexFileResult {
    success: boolean;
    skipped?: boolean;
    items: number;
    methods: number;
    types: number;
    error?: string;
}

function indexFile(
    projectPath: string,
    relativePath: string,
    queries: Queries,
    incremental: boolean = false
): IndexFileResult {
    const absolutePath = join(projectPath, relativePath);

    // Read file content
    let content: string;
    try {
        content = readFileSync(absolutePath, 'utf-8');
    } catch (err) {
        return {
            success: false,
            items: 0,
            methods: 0,
            types: 0,
            error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}`,
        };
    }

    // Calculate hash
    const hash = shortHash(content);

    // In incremental mode, skip unchanged files
    if (incremental) {
        const existingFile = queries.getFileByPath(relativePath);
        if (existingFile && existingFile.hash === hash) {
            return {
                success: true,
                skipped: true,
                items: 0,
                methods: 0,
                types: 0,
            };
        }
        // File changed - clear old data before re-indexing
        if (existingFile) {
            queries.clearFileData(existingFile.id);
            queries.deleteFile(existingFile.id);
        }
    }

    // Insert file record
    const fileId = queries.insertFile(relativePath, hash);

    // Delegate extraction and insertion to shared function
    return indexFileContent({ fileId, content, relativePath, queries });
}
