/**
 * Database module exports
 */

export { ChronicleDatabase, openDatabase, createDatabase } from './database.js';
export { Queries, createQueries } from './queries.js';

// Types and constants from the shared types module
export type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    DependencyRow,
    ProjectFileRow,
    TaskRow,
    TaskLogRow,
    StatsTable,
} from './types.js';
export { METADATA_KEYS, STATS_TABLES } from './types.js';
