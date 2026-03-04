/**
 * MCP Tool definitions for Chronicle
 *
 * Each tool has a name, description, and inputSchema.
 * Moved from tools.ts for structural clarity.
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { PRODUCT_NAME, INDEX_DIR, TOOL_PREFIX } from '../constants.js';

/**
 * Register all available tools
 */
export function registerTools(): Tool[] {
    return [
        {
            name: `${TOOL_PREFIX}init`,
            description: `Initialize ${PRODUCT_NAME} indexing for a project. Scans all source files and builds a searchable index of identifiers, methods, types, and signatures.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path to the project directory to index',
                    },
                    name: {
                        type: 'string',
                        description: 'Optional project name (defaults to directory name)',
                    },
                    exclude: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Additional glob patterns to exclude (e.g., ["**/test/**"])',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}query`,
            description: `Search for terms/identifiers in the ${PRODUCT_NAME} index. Returns file locations where the term appears. PREFERRED over Grep/Glob for code searches when ${INDEX_DIR}/ exists - faster and more precise. Use this instead of grep for finding functions, classes, variables by name.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    term: {
                        type: 'string',
                        description: 'The term to search for',
                    },
                    mode: {
                        type: 'string',
                        enum: ['exact', 'contains', 'starts_with'],
                        description: 'Search mode: exact match, contains, or starts_with (default: exact)',
                    },
                    file_filter: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "src/commands/**")',
                    },
                    type_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Filter by line type: code, comment, method, struct, property',
                    },
                    modified_since: {
                        type: 'string',
                        description: 'Only include lines modified after this time. Supports: "2h" (hours), "30m" (minutes), "1d" (days), "1w" (weeks), or ISO date string',
                    },
                    modified_before: {
                        type: 'string',
                        description: 'Only include lines modified before this time. Same format as modified_since',
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of results (default: 100)',
                    },
                },
                required: ['path', 'term'],
            },
        },
        {
            name: `${TOOL_PREFIX}status`,
            description: `Get ${PRODUCT_NAME} server status and statistics for an indexed project`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory (optional, shows server status if not provided)`,
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}signature`,
            description: 'Get the signature of a single file: header comments, types (classes/structs/interfaces), and method prototypes. Use this INSTEAD of reading entire files when you only need to know what methods/classes exist. Much faster than Read tool for understanding file structure.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file within the project (e.g., "src/Core/Engine.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}signatures`,
            description: 'Get signatures for multiple files at once using glob pattern or file list. Returns types and method prototypes. Use INSTEAD of reading multiple files when exploring codebase structure. Much more efficient than multiple Read calls.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern to match files (e.g., "src/Core/**/*.cs", "**/*.ts")',
                    },
                    files: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Explicit list of relative file paths (alternative to pattern)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}update`,
            description: `Re-index a single file. Use after editing a file to update the ${PRODUCT_NAME} index. If the file is new, it will be added to the index. If unchanged (same hash), no update is performed.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file to update (e.g., "src/Core/Engine.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}remove`,
            description: `Remove a file from the ${PRODUCT_NAME} index. Use when a file has been deleted from the project.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    file: {
                        type: 'string',
                        description: 'Relative path to the file to remove (e.g., "src/OldFile.cs")',
                    },
                },
                required: ['path', 'file'],
            },
        },
        {
            name: `${TOOL_PREFIX}summary`,
            description: 'Get project summary including auto-detected entry points, main types, and languages. Also returns content from summary.md if it exists.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}tree`,
            description: 'Get the indexed file tree. Optionally filter by subdirectory, limit depth, or include statistics per file.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    subpath: {
                        type: 'string',
                        description: 'Subdirectory to list (default: project root)',
                    },
                    depth: {
                        type: 'number',
                        description: 'Maximum depth to traverse (default: unlimited)',
                    },
                    include_stats: {
                        type: 'boolean',
                        description: 'Include item/method/type counts per file',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}describe`,
            description: 'Add or update a section in the project summary (summary.md). Use to document project purpose, architecture, key concepts, or patterns.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    section: {
                        type: 'string',
                        enum: ['purpose', 'architecture', 'concepts', 'patterns', 'notes'],
                        description: 'Section to update',
                    },
                    content: {
                        type: 'string',
                        description: 'Content to add to the section',
                    },
                    replace: {
                        type: 'boolean',
                        description: 'Replace existing section content (default: append)',
                    },
                },
                required: ['path', 'section', 'content'],
            },
        },
        {
            name: `${TOOL_PREFIX}link`,
            description: `Link a dependency project to enable cross-project queries. The dependency must have its own ${INDEX_DIR} index.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to current project with ${INDEX_DIR} directory`,
                    },
                    dependency: {
                        type: 'string',
                        description: 'Path to dependency project to link',
                    },
                    name: {
                        type: 'string',
                        description: 'Optional display name for the dependency',
                    },
                },
                required: ['path', 'dependency'],
            },
        },
        {
            name: `${TOOL_PREFIX}unlink`,
            description: 'Remove a linked dependency project.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to current project with ${INDEX_DIR} directory`,
                    },
                    dependency: {
                        type: 'string',
                        description: 'Path to dependency project to unlink',
                    },
                },
                required: ['path', 'dependency'],
            },
        },
        {
            name: `${TOOL_PREFIX}links`,
            description: 'List all linked dependency projects.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}scan`,
            description: `Scan a directory tree to find all projects with ${PRODUCT_NAME} indexes (${INDEX_DIR} directories). Use this to discover which projects are already indexed before using Grep/Glob - indexed projects should use ${TOOL_PREFIX}query instead.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Root path to scan for ${INDEX_DIR} directories`,
                    },
                    max_depth: {
                        type: 'number',
                        description: 'Maximum directory depth to scan (default: 10)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}files`,
            description: 'List all files and directories in the indexed project. Returns the complete project structure with file types (code, config, doc, asset, test, other) and whether each file is indexed for code search. Use modified_since to find files changed in this session.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    type: {
                        type: 'string',
                        enum: ['dir', 'code', 'config', 'doc', 'asset', 'test', 'other'],
                        description: 'Filter by file type',
                    },
                    pattern: {
                        type: 'string',
                        description: 'Glob pattern to filter files (e.g., "src/**/*.ts")',
                    },
                    modified_since: {
                        type: 'string',
                        description: 'Only files indexed after this time. Supports: "2h", "30m", "1d", "1w", or ISO date. Use to find files changed this session.',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}note`,
            description: `Read or write a session note for the project. Notes persist in the ${PRODUCT_NAME} database. When a note is overwritten or cleared, the old note is automatically archived. Use history/search to browse past notes.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    note: {
                        type: 'string',
                        description: 'Note to save. If omitted, reads the current note.',
                    },
                    append: {
                        type: 'boolean',
                        description: 'If true, appends to existing note instead of replacing (default: false)',
                    },
                    clear: {
                        type: 'boolean',
                        description: 'If true, clears the note (default: false)',
                    },
                    history: {
                        type: 'boolean',
                        description: 'If true, shows archived note history (newest first)',
                    },
                    search: {
                        type: 'string',
                        description: 'Search term to find in note history (case-insensitive)',
                    },
                    limit: {
                        type: 'number',
                        description: 'Max history/search entries to return (default: 20)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}session`,
            description: `Start or check an ${PRODUCT_NAME} session. Call this at the beginning of a new chat session to: (1) detect files changed externally since last session, (2) auto-reindex modified files, (3) get session note and last session times. Returns info for "What did we do last session?" queries.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}viewer`,
            description: 'Open an interactive project tree viewer in the browser. Shows the indexed file structure with clickable nodes - click on a file to see its signature (header comments, types, methods). Uses a local HTTP server with WebSocket for live updates.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    action: {
                        type: 'string',
                        enum: ['open', 'close'],
                        description: 'Action to perform: open (default) or close the viewer',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}task`,
            description: `Manage a single task in the project backlog. Actions: create (new task), read (get task + log), update (change fields), delete, log (add history note). Tasks persist in the ${PRODUCT_NAME} database. Completed tasks are preserved as documentation.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    action: {
                        type: 'string',
                        enum: ['create', 'read', 'update', 'delete', 'log'],
                        description: 'Action to perform on the task',
                    },
                    id: {
                        type: 'number',
                        description: 'Task ID (required for read/update/delete/log)',
                    },
                    title: {
                        type: 'string',
                        description: 'Task title (required for create)',
                    },
                    description: {
                        type: 'string',
                        description: 'Task description (optional details)',
                    },
                    priority: {
                        type: 'number',
                        enum: [1, 2, 3],
                        description: 'Priority: 1=high, 2=medium (default), 3=low',
                    },
                    status: {
                        type: 'string',
                        enum: ['backlog', 'active', 'done', 'cancelled'],
                        description: 'Task status (default: backlog)',
                    },
                    tags: {
                        type: 'string',
                        description: 'Comma-separated tags (e.g., "bug, viewer, parser")',
                    },
                    source: {
                        type: 'string',
                        description: 'Where the task came from (freetext, e.g., "code review of parser.ts:142")',
                    },
                    sort_order: {
                        type: 'number',
                        description: 'Sort order within same priority (lower = first, default: 0)',
                    },
                    note: {
                        type: 'string',
                        description: 'Log note text (required for log action)',
                    },
                },
                required: ['path', 'action'],
            },
        },
        {
            name: `${TOOL_PREFIX}tasks`,
            description: `List and filter tasks in the project backlog. Returns tasks grouped by status (active, backlog, done, cancelled) and sorted by priority. Use to get an overview of all open and completed work.`,
            inputSchema: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: `Path to project with ${INDEX_DIR} directory`,
                    },
                    status: {
                        type: 'string',
                        enum: ['backlog', 'active', 'done', 'cancelled'],
                        description: 'Filter by status (default: show all)',
                    },
                    priority: {
                        type: 'number',
                        enum: [1, 2, 3],
                        description: 'Filter by priority',
                    },
                    tag: {
                        type: 'string',
                        description: 'Filter by tag (matches any task containing this tag)',
                    },
                },
                required: ['path'],
            },
        },
        {
            name: `${TOOL_PREFIX}screenshot`,
            description: 'Take a screenshot of the screen, active window, a specific window, an interactive region selection, or a specific rectangle by coordinates. Returns the file path so you can immediately Read the image. No project index required.',
            inputSchema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['fullscreen', 'active_window', 'window', 'region', 'rect'],
                        description: 'Capture mode: fullscreen (default), active_window, window (by title), region (interactive selection), or rect (specific coordinates)',
                    },
                    window_title: {
                        type: 'string',
                        description: 'Window title substring to match (required when mode="window"). Use chronicle_windows to find titles.',
                    },
                    monitor: {
                        type: 'number',
                        description: 'Monitor index (0-based, default: primary). Only applies to fullscreen mode.',
                    },
                    delay: {
                        type: 'number',
                        description: 'Seconds to wait before capturing (e.g., 3 to give time to switch windows)',
                    },
                    filename: {
                        type: 'string',
                        description: 'Custom filename (default: chronicle-screenshot.png). Overwrites if exists.',
                    },
                    save_path: {
                        type: 'string',
                        description: 'Custom directory to save in (default: system temp directory)',
                    },
                    x: {
                        type: 'number',
                        description: 'X coordinate of the capture rectangle (required when mode="rect")',
                    },
                    y: {
                        type: 'number',
                        description: 'Y coordinate of the capture rectangle (required when mode="rect")',
                    },
                    width: {
                        type: 'number',
                        description: 'Width of the capture rectangle in pixels (required when mode="rect")',
                    },
                    height: {
                        type: 'number',
                        description: 'Height of the capture rectangle in pixels (required when mode="rect")',
                    },
                },
                required: [],
            },
        },
        {
            name: `${TOOL_PREFIX}windows`,
            description: 'List all open windows with their titles, PIDs, and process names. Use this to find the exact window title for chronicle_screenshot with mode="window". No project index required.',
            inputSchema: {
                type: 'object',
                properties: {
                    filter: {
                        type: 'string',
                        description: 'Optional substring to filter window titles (case-insensitive)',
                    },
                },
                required: [],
            },
        },
    ];
}
