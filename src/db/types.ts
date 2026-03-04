/**
 * Type definitions and constants for the Chronicle database layer
 */

// ============================================================
// Row type interfaces
// ============================================================

export interface FileRow {
    id: number;
    path: string;
    hash: string;
    last_indexed: number;
}

export interface LineRow {
    id: number;
    file_id: number;
    line_number: number;
    line_type: 'code' | 'comment' | 'struct' | 'method' | 'property' | 'string';
    line_hash: string | null;
    modified: number | null;
}

export interface ItemRow {
    id: number;
    term: string;
}

export interface OccurrenceRow {
    item_id: number;
    file_id: number;
    line_id: number;
}

export interface SignatureRow {
    file_id: number;
    header_comments: string | null;
}

export interface MethodRow {
    id: number;
    file_id: number;
    name: string;
    prototype: string;
    line_number: number;
    visibility: string | null;
    is_static: number;
    is_async: number;
}

export interface TypeRow {
    id: number;
    file_id: number;
    name: string;
    kind: 'class' | 'struct' | 'interface' | 'enum' | 'type';
    line_number: number;
}

export interface DependencyRow {
    id: number;
    path: string;
    name: string | null;
    last_checked: number | null;
}

export interface ProjectFileRow {
    id: number;
    path: string;
    type: 'dir' | 'code' | 'config' | 'doc' | 'asset' | 'test' | 'other';
    extension: string | null;
    indexed: number;
}

export interface TaskRow {
    id: number;
    title: string;
    description: string | null;
    priority: 1 | 2 | 3;
    status: 'backlog' | 'active' | 'done' | 'cancelled';
    tags: string | null;
    source: string | null;
    sort_order: number;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

export interface TaskLogRow {
    id: number;
    task_id: number;
    note: string;
    created_at: number;
}

// ============================================================
// Metadata key constants
// ============================================================

export const METADATA_KEYS = {
    SESSION_START: 'current_session_start',
    SESSION_END: 'last_session_end',
    SESSION_LAST_START: 'last_session_start',
    SESSION_NOTE: 'session_note',
    PROJECT_NAME: 'project_name',
    PROJECT_ROOT: 'project_root',
    SCHEMA_VERSION: 'schema_version',
    CREATED_AT: 'created_at',
    LAST_INDEXED: 'last_indexed',
} as const;

// ============================================================
// Tables tracked in getStats()
// ============================================================

export const STATS_TABLES = [
    'files',
    'lines',
    'items',
    'occurrences',
    'methods',
    'types',
    'dependencies',
] as const;

export type StatsTable = typeof STATS_TABLES[number];
