/**
 * Database module exports
 */

export { ChronicleDatabase, openDatabase, createDatabase } from './database.js';
export { Queries, createQueries } from './queries.js';
export { GlobalDatabase, openGlobalDatabase, globalDbExists, readProjectStats, type GlobalProject, type ProjectStats } from './global-database.js';
export type {
    FileRow,
    LineRow,
    ItemRow,
    OccurrenceRow,
    SignatureRow,
    MethodRow,
    TypeRow,
    DependencyRow,
    TaskRow,
    TaskLogRow,
} from './queries.js';
