/**
 * MCP Tool handlers for Chronicle
 *
 * Contains the dispatch logic and individual handler functions for all 22 tools.
 * Moved from tools.ts for structural clarity.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { init, query, signature, signatures, update, remove, summary, tree, describe, link, unlink, listLinks, scan, files, note, session, formatSessionTime, formatDuration, task, tasks, screenshot, listWindows, type QueryMode, type TaskAction, type ScreenshotMode } from '../commands/index.js';
import type { TaskRow } from '../db/index.js';
import { openDatabase } from '../db/index.js';
import { startViewer, stopViewer } from '../viewer/index.js';
import { PRODUCT_NAME, PRODUCT_VERSION, INDEX_DIR, TOOL_PREFIX } from '../constants.js';

/** Standard MCP tool call result shape */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Wrap a text message into the standard MCP CallToolResult shape.
 */
function wrapResult(text: string, isError = false): ToolResult {
    return {
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
    };
}

/**
 * Handle tool calls — dispatches to the appropriate handler by name.
 */
export async function handleToolCall(
    name: string,
    args: Record<string, unknown>
): Promise<ToolResult> {
    try {
        switch (name) {
            case `${TOOL_PREFIX}init`:
                return await handleInit(args);
            case `${TOOL_PREFIX}query`:
                return handleQuery(args);
            case `${TOOL_PREFIX}status`:
                return handleStatus(args);
            case `${TOOL_PREFIX}signature`:
                return handleSignature(args);
            case `${TOOL_PREFIX}signatures`:
                return handleSignatures(args);
            case `${TOOL_PREFIX}update`:
                return handleUpdate(args);
            case `${TOOL_PREFIX}remove`:
                return handleRemove(args);
            case `${TOOL_PREFIX}summary`:
                return handleSummary(args);
            case `${TOOL_PREFIX}tree`:
                return handleTree(args);
            case `${TOOL_PREFIX}describe`:
                return handleDescribe(args);
            case `${TOOL_PREFIX}link`:
                return handleLink(args);
            case `${TOOL_PREFIX}unlink`:
                return handleUnlink(args);
            case `${TOOL_PREFIX}links`:
                return handleLinks(args);
            case `${TOOL_PREFIX}scan`:
                return handleScan(args);
            case `${TOOL_PREFIX}files`:
                return handleFiles(args);
            case `${TOOL_PREFIX}note`:
                return handleNote(args);
            case `${TOOL_PREFIX}session`:
                return handleSession(args);
            case `${TOOL_PREFIX}viewer`:
                return await handleViewer(args);
            case `${TOOL_PREFIX}task`:
                return handleTask(args);
            case `${TOOL_PREFIX}tasks`:
                return handleTasks(args);
            case `${TOOL_PREFIX}screenshot`:
                return handleScreenshot(args);
            case `${TOOL_PREFIX}windows`:
                return handleWindows(args);
            default:
                return wrapResult(`Unknown tool: ${name}`);
        }
    } catch (error) {
        return wrapResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

async function handleInit(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = await init({
        path,
        name: args.name as string | undefined,
        exclude: args.exclude as string[] | undefined,
    });

    if (result.success) {
        let message = `✓ ${PRODUCT_NAME} initialized for project\n\n`;
        message += `Database: ${result.indexPath}/index.db\n`;
        message += `Files indexed: ${result.filesIndexed}`;
        if (result.filesSkipped > 0) {
            message += ` (${result.filesSkipped} unchanged, skipped)`;
        }
        message += `\n`;
        if (result.filesRemoved > 0) {
            message += `Files removed: ${result.filesRemoved} (now excluded)\n`;
        }
        message += `Items found: ${result.itemsFound}\n`;
        message += `Methods found: ${result.methodsFound}\n`;
        message += `Types found: ${result.typesFound}\n`;
        message += `Duration: ${result.durationMs}ms`;

        if (result.errors.length > 0) {
            message += `\n\nWarnings (${result.errors.length}):\n`;
            message += result.errors.slice(0, 10).map(e => `  - ${e}`).join('\n');
            if (result.errors.length > 10) {
                message += `\n  ... and ${result.errors.length - 10} more`;
            }
        }

        return wrapResult(message);
    } else {
        return wrapResult(`Error: ${result.errors.join(', ')}`);
    }
}

function handleQuery(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const term = args.term as string;

    if (!path || !term) {
        return wrapResult('Error: path and term parameters are required');
    }

    const result = query({
        path,
        term,
        mode: (args.mode as QueryMode) ?? 'exact',
        fileFilter: args.file_filter as string | undefined,
        typeFilter: args.type_filter as string[] | undefined,
        modifiedSince: args.modified_since as string | undefined,
        modifiedBefore: args.modified_before as string | undefined,
        limit: args.limit as number | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.matches.length === 0) {
        return wrapResult(`No matches found for "${term}" (mode: ${result.mode})`);
    }

    // Format results
    let message = `Found ${result.totalMatches} match(es) for "${term}" (mode: ${result.mode})`;
    if (result.truncated) {
        message += ` [showing first ${result.matches.length}]`;
    }
    message += '\n\n';

    // Group by file
    const byFile = new Map<string, Array<{ lineNumber: number; lineType: string }>>();
    for (const match of result.matches) {
        if (!byFile.has(match.file)) {
            byFile.set(match.file, []);
        }
        byFile.get(match.file)!.push({ lineNumber: match.lineNumber, lineType: match.lineType });
    }

    for (const [file, lines] of byFile) {
        message += `${file}\n`;
        for (const line of lines) {
            message += `  :${line.lineNumber} (${line.lineType})\n`;
        }
    }

    return wrapResult(message.trimEnd());
}

function handleStatus(args: Record<string, unknown>): ToolResult {
    const path = args.path as string | undefined;

    if (!path) {
        return wrapResult(JSON.stringify({
            status: 'running',
            version: PRODUCT_VERSION,
            message: `${PRODUCT_NAME} MCP server is running. Use ${TOOL_PREFIX}init to index a project.`,
        }, null, 2));
    }

    // Check if project has index
    const indexDir = join(path, INDEX_DIR);
    const dbPath = join(indexDir, 'index.db');

    if (!existsSync(dbPath)) {
        return wrapResult(`No ${PRODUCT_NAME} index found at ${path}. Run ${TOOL_PREFIX}init first.`);
    }

    // Open database and get stats
    const db = openDatabase(dbPath, true);
    const stats = db.getStats();
    const projectName = db.getMetadata('project_name') ?? 'Unknown';
    const schemaVersion = db.getMetadata('schema_version') ?? 'Unknown';
    db.close();

    return wrapResult(JSON.stringify({
        project: projectName,
        schemaVersion,
        statistics: stats,
        databasePath: dbPath,
    }, null, 2));
}

function handleSignature(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return wrapResult('Error: path and file parameters are required');
    }

    const result = signature({ path, file });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    // Format output
    let message = `# Signature: ${result.file}\n\n`;

    // Header comments
    if (result.headerComments) {
        message += `## Header Comments\n\`\`\`\n${result.headerComments}\n\`\`\`\n\n`;
    }

    // Types
    if (result.types.length > 0) {
        message += `## Types (${result.types.length})\n`;
        for (const t of result.types) {
            message += `- **${t.kind}** \`${t.name}\` (line ${t.lineNumber})\n`;
        }
        message += '\n';
    }

    // Methods
    if (result.methods.length > 0) {
        message += `## Methods (${result.methods.length})\n`;
        for (const m of result.methods) {
            const modifiers: string[] = [];
            if (m.visibility) modifiers.push(m.visibility);
            if (m.isStatic) modifiers.push('static');
            if (m.isAsync) modifiers.push('async');
            const prefix = modifiers.length > 0 ? `[${modifiers.join(' ')}] ` : '';
            message += `- ${prefix}\`${m.prototype}\` (line ${m.lineNumber})\n`;
        }
    }

    if (result.types.length === 0 && result.methods.length === 0 && !result.headerComments) {
        message += '_No signature data found for this file._\n';
    }

    return wrapResult(message.trimEnd());
}

function handleSignatures(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const pattern = args.pattern as string | undefined;
    const filesList = args.files as string[] | undefined;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    if (!pattern && (!filesList || filesList.length === 0)) {
        return wrapResult('Error: either pattern or files parameter is required');
    }

    const result = signatures({ path, pattern, files: filesList });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.signatures.length === 0) {
        const searchDesc = pattern ? `pattern "${pattern}"` : `files list`;
        return wrapResult(`No files found matching ${searchDesc}`);
    }

    // Format output - summary view
    let message = `# Signatures (${result.totalFiles} files)\n\n`;

    for (const sig of result.signatures) {
        if (!sig.success) {
            message += `## ${sig.file}\n_Error: ${sig.error}_\n\n`;
            continue;
        }

        message += `## ${sig.file}\n`;

        // Compact summary
        const parts: string[] = [];
        if (sig.types.length > 0) {
            const typesSummary = sig.types.map(t => `${t.kind} ${t.name}`).join(', ');
            parts.push(`Types: ${typesSummary}`);
        }
        if (sig.methods.length > 0) {
            parts.push(`Methods: ${sig.methods.length}`);
        }

        if (parts.length > 0) {
            message += parts.join(' | ') + '\n';
        }

        // List methods compactly
        if (sig.methods.length > 0) {
            for (const m of sig.methods) {
                const modifiers: string[] = [];
                if (m.visibility) modifiers.push(m.visibility);
                if (m.isStatic) modifiers.push('static');
                if (m.isAsync) modifiers.push('async');
                const prefix = modifiers.length > 0 ? `[${modifiers.join(' ')}] ` : '';
                message += `  - ${prefix}${m.prototype} :${m.lineNumber}\n`;
            }
        }

        message += '\n';
    }

    return wrapResult(message.trimEnd());
}

function handleUpdate(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return wrapResult('Error: path and file parameters are required');
    }

    const result = update({ path, file });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    // Check if file was unchanged
    if (result.error === 'File unchanged (hash match)') {
        return wrapResult(`File unchanged: ${result.file} (hash match, no update needed)`);
    }

    let message = `✓ Updated: ${result.file}\n`;
    message += `  Items: +${result.itemsAdded} / -${result.itemsRemoved}\n`;
    message += `  Methods: ${result.methodsUpdated}\n`;
    message += `  Types: ${result.typesUpdated}\n`;
    message += `  Duration: ${result.durationMs}ms`;

    return wrapResult(message);
}

function handleRemove(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const file = args.file as string;

    if (!path || !file) {
        return wrapResult('Error: path and file parameters are required');
    }

    const result = remove({ path, file });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (!result.removed) {
        return wrapResult(`File not in index: ${result.file}`);
    }

    return wrapResult(`✓ Removed from index: ${result.file}`);
}

function handleSummary(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = summary({ path });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    let message = `# Project: ${result.name}\n\n`;

    // Auto-generated info
    message += `## Overview\n`;
    message += `- **Files indexed:** ${result.autoGenerated.fileCount}\n`;
    message += `- **Languages:** ${result.autoGenerated.languages.join(', ') || 'None detected'}\n`;

    if (result.autoGenerated.entryPoints.length > 0) {
        message += `- **Entry points:** ${result.autoGenerated.entryPoints.join(', ')}\n`;
    }

    if (result.autoGenerated.mainTypes.length > 0) {
        message += `\n## Main Types\n`;
        for (const t of result.autoGenerated.mainTypes) {
            message += `- ${t}\n`;
        }
    }

    // User-provided summary content
    if (result.content) {
        message += `\n---\n\n${result.content}`;
    }

    return wrapResult(message.trimEnd());
}

function handleTree(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = tree({
        path,
        subpath: args.subpath as string | undefined,
        depth: args.depth as number | undefined,
        includeStats: args.include_stats as boolean | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.entries.length === 0) {
        return wrapResult(`No files found in ${result.root}`);
    }

    let message = `# File Tree: ${result.root} (${result.totalFiles} files)\n\n`;

    for (const entry of result.entries) {
        if (entry.type === 'directory') {
            message += `📁 ${entry.path}/\n`;
        } else {
            let stats = '';
            if (entry.itemCount !== undefined) {
                stats = ` [${entry.itemCount} items, ${entry.methodCount} methods, ${entry.typeCount} types]`;
            }
            message += `  📄 ${entry.path}${stats}\n`;
        }
    }

    return wrapResult(message.trimEnd());
}

function handleDescribe(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const section = args.section as string;
    const content = args.content as string;

    if (!path || !section || !content) {
        return wrapResult('Error: path, section, and content parameters are required');
    }

    const validSections = ['purpose', 'architecture', 'concepts', 'patterns', 'notes'];
    if (!validSections.includes(section)) {
        return wrapResult(`Error: section must be one of: ${validSections.join(', ')}`);
    }

    const result = describe({
        path,
        section: section as 'purpose' | 'architecture' | 'concepts' | 'patterns' | 'notes',
        content,
        replace: args.replace as boolean | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    return wrapResult(`✓ Updated section: ${result.section}`);
}

function handleLink(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const dependency = args.dependency as string;

    if (!path || !dependency) {
        return wrapResult('Error: path and dependency parameters are required');
    }

    const result = link({
        path,
        dependency,
        name: args.name as string | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    return wrapResult(`✓ Linked: ${result.name} (${result.filesAvailable} files)`);
}

function handleUnlink(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const dependency = args.dependency as string;

    if (!path || !dependency) {
        return wrapResult('Error: path and dependency parameters are required');
    }

    const result = unlink({ path, dependency });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (!result.removed) {
        return wrapResult(`Dependency not found: ${dependency}`);
    }

    return wrapResult(`✓ Unlinked: ${dependency}`);
}

function handleLinks(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = listLinks({ path });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.dependencies.length === 0) {
        return wrapResult('No linked dependencies.');
    }

    let message = `# Linked Dependencies (${result.dependencies.length})\n\n`;

    for (const dep of result.dependencies) {
        const status = dep.available ? '✓' : '✗';
        const name = dep.name ?? 'unnamed';
        message += `${status} **${name}**\n`;
        message += `  Path: ${dep.path}\n`;
        message += `  Files: ${dep.filesAvailable}\n`;
        if (!dep.available) {
            message += `  ⚠️ Not available (index missing)\n`;
        }
        message += '\n';
    }

    return wrapResult(message.trimEnd());
}

function handleScan(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = scan({
        path,
        maxDepth: args.max_depth as number | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.projects.length === 0) {
        return wrapResult(`No ${PRODUCT_NAME} indexes found in ${result.searchPath}\n(scanned ${result.scannedDirs} directories)`);
    }

    let message = `# ${PRODUCT_NAME} Indexes Found (${result.projects.length})\n\n`;
    message += `Scanned: ${result.searchPath} (${result.scannedDirs} directories)\n\n`;

    for (const proj of result.projects) {
        message += `## ${proj.name}\n`;
        message += `- **Path:** ${proj.path}\n`;
        message += `- **Files:** ${proj.files} | **Items:** ${proj.items} | **Methods:** ${proj.methods} | **Types:** ${proj.types}\n`;
        message += `- **Last indexed:** ${proj.lastIndexed}\n`;
        message += '\n';
    }

    return wrapResult(message.trimEnd());
}

function handleFiles(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = files({
        path,
        type: args.type as string | undefined,
        pattern: args.pattern as string | undefined,
        modifiedSince: args.modified_since as string | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.files.length === 0) {
        return wrapResult('No files found in project.');
    }

    // Build summary
    let message = `# Project Files (${result.totalFiles})\n\n`;

    // Type statistics
    message += `## By Type\n`;
    for (const [type, count] of Object.entries(result.byType).sort()) {
        message += `- **${type}:** ${count}\n`;
    }
    message += '\n';

    // Group files by directory
    const byDir = new Map<string, typeof result.files>();
    for (const file of result.files) {
        const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '.';
        if (!byDir.has(dir)) {
            byDir.set(dir, []);
        }
        byDir.get(dir)!.push(file);
    }

    // List files (limit output for large projects)
    const MAX_ENTRIES = 200;
    let entriesShown = 0;

    message += `## Files\n`;
    for (const [dir, dirFiles] of [...byDir.entries()].sort()) {
        if (entriesShown >= MAX_ENTRIES) {
            message += `\n... and ${result.totalFiles - entriesShown} more files\n`;
            break;
        }

        // Show directory
        if (dir !== '.') {
            message += `\n📁 ${dir}/\n`;
            entriesShown++;
        }

        // Show files in directory
        for (const file of dirFiles) {
            if (entriesShown >= MAX_ENTRIES) break;

            const fileName = file.path.includes('/') ? file.path.substring(file.path.lastIndexOf('/') + 1) : file.path;
            const icon = file.type === 'dir' ? '📁' : '📄';
            const indexed = file.indexed ? ' ✓' : '';
            message += `  ${icon} ${fileName} (${file.type})${indexed}\n`;
            entriesShown++;
        }
    }

    return wrapResult(message.trimEnd());
}

function handleNote(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = note({
        path,
        note: args.note as string | undefined,
        append: args.append as boolean | undefined,
        clear: args.clear as boolean | undefined,
        history: args.history as boolean | undefined,
        search: args.search as string | undefined,
        limit: args.limit as number | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    switch (result.action) {
        case 'clear':
            return wrapResult('✓ Session note cleared (old note archived).');

        case 'write':
            return wrapResult(`✓ Session note saved (old note archived):\n\n${result.note}`);

        case 'append':
            return wrapResult(`✓ Appended to session note:\n\n${result.note}`);

        case 'history':
        case 'search': {
            const entries = result.history ?? [];
            if (entries.length === 0) {
                const msg = result.action === 'search'
                    ? `No notes found matching "${args.search}".`
                    : 'No note history yet.';
                return wrapResult(msg);
            }

            const header = result.action === 'search'
                ? `🔍 Found ${entries.length} note(s) matching "${args.search}" (${result.historyCount} total in history):`
                : `📋 Note history (${entries.length} of ${result.historyCount} total, newest first):`;

            const lines = entries.map(e => {
                const date = new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19);
                // Show first 200 chars of each note, with separator
                const preview = e.note.length > 200 ? e.note.slice(0, 200) + '...' : e.note;
                return `--- ${date} ---\n${preview}`;
            });

            return wrapResult(`${header}\n\n${lines.join('\n\n')}`);
        }

        case 'read':
        default:
            if (!result.note) {
                return wrapResult('No session note set for this project.');
            }
            return wrapResult(`📝 Session Note:\n\n${result.note}`);
    }
}

function handleSession(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = session({ path });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    let message = '';

    // Session status
    if (result.isNewSession) {
        message += '🆕 **New Session Started**\n\n';
    } else {
        message += '▶️ **Session Continued**\n\n';
    }

    // Last session info
    if (result.sessionInfo.lastSessionStart && result.sessionInfo.lastSessionEnd) {
        message += '## Last Session\n';
        message += `- **Start:** ${formatSessionTime(result.sessionInfo.lastSessionStart)}\n`;
        message += `- **End:** ${formatSessionTime(result.sessionInfo.lastSessionEnd)}\n`;
        message += `- **Duration:** ${formatDuration(result.sessionInfo.lastSessionStart, result.sessionInfo.lastSessionEnd)}\n`;
        message += `\n💡 Query last session changes with:\n\`${TOOL_PREFIX}query({ term: "...", modified_since: "${result.sessionInfo.lastSessionStart}", modified_before: "${result.sessionInfo.lastSessionEnd}" })\`\n\n`;
    }

    // External changes
    if (result.externalChanges.length > 0) {
        message += '## External Changes Detected\n';
        message += `Found ${result.externalChanges.length} file(s) changed outside of session:\n\n`;

        for (const change of result.externalChanges) {
            const icon = change.reason === 'deleted' ? '🗑️' : '✏️';
            message += `- ${icon} ${change.path} (${change.reason})\n`;
        }

        if (result.reindexed.length > 0) {
            message += `\n✅ Auto-reindexed ${result.reindexed.length} file(s)\n`;
        }
        message += '\n';
    }

    // Session note
    if (result.note) {
        message += '## 📝 Session Note\n';
        message += result.note + '\n';
    }

    return wrapResult(message.trimEnd());
}

async function handleViewer(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    const action = (args.action as string) || 'open';

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    // Check if index directory exists
    const indexPath = join(path, INDEX_DIR);
    if (!existsSync(indexPath)) {
        return wrapResult(`Error: No ${INDEX_DIR} directory found at ${path}. Run ${TOOL_PREFIX}init first.`);
    }

    if (action === 'close') {
        const message = stopViewer();
        return wrapResult(message);
    }

    try {
        const message = await startViewer(path);
        return wrapResult(`🖥️ ${message}`);
    } catch (error) {
        return wrapResult(`Error starting viewer: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function handleTask(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;
    const action = args.action as TaskAction;

    if (!path || !action) {
        return wrapResult('Error: path and action parameters are required');
    }

    const result = task({
        path,
        action,
        id: args.id as number | undefined,
        title: args.title as string | undefined,
        description: args.description as string | undefined,
        priority: args.priority as 1 | 2 | 3 | undefined,
        status: args.status as 'backlog' | 'active' | 'done' | 'cancelled' | undefined,
        tags: args.tags as string | undefined,
        source: args.source as string | undefined,
        sort_order: args.sort_order as number | undefined,
        note: args.note as string | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    const priorityLabel: Record<number, string> = { 1: '🔴 high', 2: '🟡 medium', 3: '⚪ low' };

    switch (result.action) {
        case 'create':
        case 'update': {
            const t = result.task!;
            let msg = `✓ Task #${t.id} ${result.action === 'create' ? 'created' : 'updated'}\n\n`;
            msg += `**${t.title}**\n`;
            msg += `Priority: ${priorityLabel[t.priority]} | Status: ${t.status}\n`;
            if (t.description) msg += `Description: ${t.description}\n`;
            if (t.tags) msg += `Tags: ${t.tags}\n`;
            if (t.source) msg += `Source: ${t.source}\n`;
            return wrapResult(msg.trimEnd());
        }
        case 'read': {
            const t = result.task!;
            let msg = `# Task #${t.id}: ${t.title}\n\n`;
            msg += `Priority: ${priorityLabel[t.priority]} | Status: ${t.status}\n`;
            if (t.description) msg += `Description: ${t.description}\n`;
            if (t.tags) msg += `Tags: ${t.tags}\n`;
            if (t.source) msg += `Source: ${t.source}\n`;
            msg += `Created: ${new Date(t.created_at).toISOString()}\n`;
            if (t.completed_at) msg += `Completed: ${new Date(t.completed_at).toISOString()}\n`;
            if (result.log && result.log.length > 0) {
                msg += `\n## Log (${result.log.length})\n`;
                for (const entry of result.log) {
                    msg += `- [${new Date(entry.created_at).toISOString()}] ${entry.note}\n`;
                }
            }
            return wrapResult(msg.trimEnd());
        }
        case 'delete':
            return wrapResult(`✓ Task #${args.id} deleted`);
        case 'log': {
            const t = result.task!;
            let msg = `✓ Log added to Task #${t.id}: ${t.title}\n\n`;
            msg += `## Log (${result.log!.length})\n`;
            for (const entry of result.log!) {
                msg += `- [${new Date(entry.created_at).toISOString()}] ${entry.note}\n`;
            }
            return wrapResult(msg.trimEnd());
        }
        default:
            return wrapResult('Unknown action');
    }
}

function handleTasks(args: Record<string, unknown>): ToolResult {
    const path = args.path as string;

    if (!path) {
        return wrapResult('Error: path parameter is required');
    }

    const result = tasks({
        path,
        status: args.status as 'backlog' | 'active' | 'done' | 'cancelled' | undefined,
        priority: args.priority as 1 | 2 | 3 | undefined,
        tag: args.tag as string | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.tasks.length === 0) {
        return wrapResult('No tasks found.');
    }

    const priorityIcon: Record<number, string> = { 1: '🔴', 2: '🟡', 3: '⚪' };
    let msg = `# Task Backlog (${result.total})\n\n`;

    // Group by status
    const byStatus: Record<string, TaskRow[]> = { active: [], backlog: [], done: [], cancelled: [] };
    for (const t of result.tasks) {
        byStatus[t.status].push(t);
    }

    for (const [status, items] of Object.entries(byStatus)) {
        if (items.length === 0) continue;
        msg += `## ${status.charAt(0).toUpperCase() + status.slice(1)} (${items.length})\n`;
        for (const t of items) {
            msg += `- ${priorityIcon[t.priority]} **#${t.id}** ${t.title}`;
            if (t.tags) msg += ` [${t.tags}]`;
            msg += '\n';
        }
        msg += '\n';
    }

    return wrapResult(msg.trimEnd());
}

function handleScreenshot(args: Record<string, unknown>): ToolResult {
    const result = screenshot({
        mode: args.mode as ScreenshotMode | undefined,
        window_title: args.window_title as string | undefined,
        monitor: args.monitor as number | undefined,
        delay: args.delay as number | undefined,
        filename: args.filename as string | undefined,
        save_path: args.save_path as string | undefined,
        x: args.x as number | undefined,
        y: args.y as number | undefined,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    let message = `Screenshot captured!\n\n`;
    message += `**File:** ${result.file_path}\n`;
    message += `**Mode:** ${result.mode}\n`;
    if (result.monitor !== undefined) {
        message += `**Monitor:** ${result.monitor}\n`;
    }

    return wrapResult(message.trimEnd());
}

function handleWindows(args: Record<string, unknown>): ToolResult {
    const result = listWindows({
        filter: args.filter as string | undefined,
    });

    if (!result.success) {
        return wrapResult(`Error: ${result.error}`);
    }

    if (result.windows.length === 0) {
        let msg = 'No windows found.';
        if (args.filter) msg += ` (filter: "${args.filter}")`;
        return wrapResult(msg);
    }

    let message = `# Open Windows (${result.windows.length})\n\n`;

    for (const w of result.windows) {
        message += `- **${w.title}**`;
        if (w.process_name) message += ` (${w.process_name})`;
        message += ` [PID: ${w.pid}]\n`;
    }

    return wrapResult(message.trimEnd());
}
