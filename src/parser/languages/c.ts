/**
 * C language configuration for Chronicle
 */
import { FLOW, buildKeywords } from './common.js';

export const C_KEYWORDS = buildKeywords(
    FLOW,
    [
        // Storage class specifiers
        'auto', 'extern', 'inline', 'register', 'static', 'thread_local',
        '__inline', '__inline__', '__forceinline', '__thread',
        // Type qualifiers
        'const', 'constexpr', 'restrict', 'volatile',
        '__restrict__', '__extension__', '_Atomic', '_Noreturn',
        'noreturn', '_Nonnull', 'alignas', '_Alignas',
        // Primitive types
        'bool', 'char', 'double', 'float', 'int', 'void',
        'signed', 'unsigned', 'short', 'long',
        'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
        'int8_t', 'int16_t', 'int32_t', 'int64_t',
        'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
        // Type declaration
        'enum', 'struct', 'typedef', 'union',
        // Special operations
        'alignof', 'offsetof', 'sizeof', '_alignof', '_Generic',
        '__alignof', '__alignof__', '__asm', '__asm__', 'asm',
        // Exception handling (Windows)
        '__except', '__finally', '__leave', '__try',
        // Literal values
        'NULL', 'nullptr', 'true', 'false', 'TRUE', 'FALSE',
        // goto
        'goto',
    ],
);

export const C_IDENTIFIER_NODES = new Set([
    'identifier', 'type_identifier', 'field_identifier',
]);

export const C_COMMENT_NODES = new Set(['comment']);
export const C_METHOD_NODES = new Set(['function_definition']);

export const C_TYPE_NODES = new Set([
    'struct_specifier', 'union_specifier', 'enum_specifier', 'type_definition',
]);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return C_KEYWORDS.has(term);
}
