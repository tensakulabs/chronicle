/**
 * init command - Initialize Chronicle for a project
 */

import { existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'fs';
import { join, relative, basename, extname } from 'path';
import { createHash } from 'crypto';
import { minimatch } from 'minimatch';
import { INDEX_DIR } from '../constants.js';

/**
 * Compute a short (16-char) SHA256 hash of content.
 * Used consistently across init, update, and session for file/line hashing.
 */
export function shortHash(content: Buffer | string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

import { createDatabase, createQueries, type ChronicleDatabase, type Queries } from '../db/index.js';
import { extract, getSupportedExtensions } from '../parser/index.js';

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
// Default patterns
// ============================================================

// Directory patterns that should prevent glob from descending into them.
// Each entry generates both '**/name' (matches the dir) and '**/name/**' (matches contents).
const EXCLUDED_DIRS = [
    'node_modules', 'packages', 'vendor', 'vendor/bundle',
    'bin', 'obj', 'bld', 'build', 'dist', 'out', 'target',
    'Debug', 'Release', 'x64', 'x86',
    '[Aa][Rr][Mm]', '[Aa][Rr][Mm]64',
    '__pycache__', 'venv', '.venv', 'env', '*.egg-info',
    '.git', '.vs', '.idea', '.vscode',
    '.next', 'coverage', 'tmp',
];

export const DEFAULT_EXCLUDE = [
    // Directory excludes: both the dir itself and its contents
    // Matching the dir prevents glob from descending into it (walk pruning)
    ...EXCLUDED_DIRS.flatMap(d => [`**/${d}`, `**/${d}/**`]),
    // File pattern excludes
    '**/.pyc',               // Python bytecode
    '**/*.min.js',
    '**/*.generated.*',
    '**/*.g.cs',             // C# source generators
    '**/*.Designer.cs',      // WinForms designer
];

// ============================================================
// .gitignore support
// ============================================================

export function readGitignore(projectPath: string): string[] {
    const gitignorePath = join(projectPath, '.gitignore');
    if (!existsSync(gitignorePath)) return [];

    const content = readFileSync(gitignorePath, 'utf-8');
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))  // Skip comments, empty lines, and negation patterns
        .map(pattern => {
            // Glob-kompatibel machen
            if (pattern.endsWith('/')) {
                return `**/${pattern}**`;  // Verzeichnis: foo/ → **/foo/**
            }
            if (!pattern.includes('/') && !pattern.startsWith('*')) {
                return `**/${pattern}`;    // Datei/Ordner: foo → **/foo
            }
            return pattern;
        });
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

    // Merge exclude patterns (including .gitignore)
    const gitignorePatterns = readGitignore(params.path);
    const exclude = [...DEFAULT_EXCLUDE, ...gitignorePatterns, ...(params.exclude ?? [])];

    // Progress logging (CLI only, not MCP)
    const isCLI = !process.env.MCP_TRANSPORT;
    const log = (msg: string) => { if (isCLI) process.stderr.write(`\r\x1b[K${msg}`); };

    // --------------------------------------------------------
    // Single-pass directory walk: collect source files AND project files together.
    // This replaces both the glob('**/*.ext') call for source files and the
    // glob('**/*') call for project_files — one walk instead of two.
    // --------------------------------------------------------
    log(`[1/3] Scanning project tree...`);
    const supportedExtensions = new Set(getSupportedExtensions());
    let files: string[] = [];
    const allProjectFiles: string[] = [];
    const projectDirs = new Set<string>();

    // Fast exclusion: O(1) Set lookup for plain directory names
    const excludedDirNames = new Set(
        EXCLUDED_DIRS.filter(d => !d.includes('*') && !d.includes('[') && !d.includes('/'))
    );
    // Pre-compile complex patterns for slow-path matching
    const { Minimatch } = await import('minimatch');
    const compiledExcludePatterns = exclude.map(p => new Minimatch(p, { dot: true }));

    function walkTree(baseDir: string, relPath: string): void {
        let entries;
        try {
            entries = readdirSync(join(baseDir, relPath), { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            // Fast path: skip excluded directory names via Set lookup
            if (entry.isDirectory() && excludedDirNames.has(entry.name)) continue;

            const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;

            // Slow path: check complex patterns only if needed
            if (compiledExcludePatterns.some(m => m.match(entryRelPath))) continue;

            if (entry.isDirectory()) {
                projectDirs.add(entryRelPath);
                walkTree(baseDir, entryRelPath);
            } else if (entry.isFile()) {
                allProjectFiles.push(entryRelPath);
                // Check if this is a supported source file
                const ext = extname(entry.name).toLowerCase();
                if (supportedExtensions.has(ext)) {
                    files.push(entryRelPath);
                }
                if (allProjectFiles.length % 500 === 0) {
                    log(`[1/3] Scanning... ${files.length} source, ${allProjectFiles.length} total files`);
                }
            }
        }
    }

    walkTree(params.path, '');
    files.sort();
    log(`[1/3] Found ${files.length} source files, ${allProjectFiles.length} total files\n`);

    // Index each file
    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalItems = 0;
    let totalMethods = 0;
    let totalTypes = 0;

    // Use transaction for bulk insert
    log(`[2/3] Indexing source files...`);
    db.transaction(() => {
        for (const filePath of files) {
            try {
                const result = indexFile(params.path, filePath, db, queries, incremental);
                if (result.skipped) {
                    filesSkipped++;
                } else if (result.success) {
                    filesIndexed++;
                    totalItems += result.items;
                    totalMethods += result.methods;
                    totalTypes += result.types;
                    if (filesIndexed % 100 === 0) {
                        log(`[2/3] Indexing... ${filesIndexed}/${files.length} files`);
                    }
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
    // Write project structure to DB (already collected during walk)
    // --------------------------------------------------------
    log(`[3/3] Writing project structure to DB...`);
    const indexedFilesSet = new Set(files);

    db.transaction(() => {
        for (const dir of projectDirs) {
            queries.insertProjectFile(dir, 'dir', null, false);
        }
        for (const filePath of allProjectFiles) {
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

    log(`[3/3] Done. ${allProjectFiles.length} files, ${projectDirs.size} dirs\n`);

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
    db: ChronicleDatabase,
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

    // Insert file record
    const fileId = queries.insertFile(relativePath, hash);

    // Split content into lines for hashing
    const contentLines = content.split('\n');
    const now = Date.now();

    // Insert lines and capture DB-assigned IDs (AUTOINCREMENT)
    const lineNumberToId = new Map<number, number>();
    for (const line of extraction.lines) {
        const lineContent = contentLines[line.lineNumber - 1] ?? '';
        const lineHash = shortHash(lineContent);
        const dbLineId = queries.insertLine(fileId, line.lineNumber, line.lineType, lineHash, now);
        lineNumberToId.set(line.lineNumber, dbLineId);
    }

    // Insert items and occurrences
    const itemsInserted = new Set<string>();
    for (const item of extraction.items) {
        const lineIdForItem = lineNumberToId.get(item.lineNumber);
        if (lineIdForItem === undefined) {
            // Line wasn't recorded, add it now
            const lineContent = contentLines[item.lineNumber - 1] ?? '';
            const lineHash = shortHash(lineContent);
            const newLineId = queries.insertLine(fileId, item.lineNumber, item.lineType, lineHash, now);
            lineNumberToId.set(item.lineNumber, newLineId);
        }

        const itemId = queries.getOrCreateItem(item.term);
        const finalLineId = lineNumberToId.get(item.lineNumber)!;
        queries.insertOccurrence(itemId, fileId, finalLineId);
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
