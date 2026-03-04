/**
 * Rust language configuration for Chronicle
 */
import { buildKeywords } from './common.js';

export const RUST_KEYWORDS = buildKeywords(
    [
        // Strict keywords
        'as', 'async', 'await', 'break', 'const', 'continue', 'crate',
        'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if',
        'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut',
        'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct',
        'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
        // Reserved keywords
        'abstract', 'become', 'box', 'do', 'final', 'macro', 'override',
        'priv', 'try', 'typeof', 'unsized', 'virtual', 'yield',
        // Weak keywords
        'union', 'dyn',
        // Primitive types
        'bool', 'char', 'str',
        'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
        'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
        'f32', 'f64',
        // Common types (often noise)
        'Option', 'Some', 'None', 'Result', 'Ok', 'Err',
        'Vec', 'String', 'Box', 'Rc', 'Arc', 'Cell', 'RefCell',
        'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet',
        'Fn', 'FnMut', 'FnOnce',
        'Send', 'Sync', 'Copy', 'Clone', 'Debug', 'Default',
        'Iterator', 'IntoIterator',
        // Common macros
        'println', 'print', 'format', 'panic', 'assert', 'assert_eq',
        'vec', 'todo', 'unimplemented', 'unreachable',
    ],
);

export const RUST_IDENTIFIER_NODES = new Set([
    'identifier', 'type_identifier', 'field_identifier',
]);

export const RUST_COMMENT_NODES = new Set(['line_comment', 'block_comment']);

export const RUST_METHOD_NODES = new Set([
    'function_item', 'function_signature_item',
]);

export const RUST_TYPE_NODES = new Set([
    'struct_item', 'enum_item', 'trait_item', 'type_item',
]);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return RUST_KEYWORDS.has(term);
}
