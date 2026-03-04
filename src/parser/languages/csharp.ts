/**
 * C# language configuration for Chronicle
 */
import { FLOW, ACCESS, EXCEPTIONS, LITERALS, buildKeywords } from './common.js';

export const CSHARP_KEYWORDS = buildKeywords(
    FLOW, ACCESS, EXCEPTIONS, LITERALS,
    [
        // Access modifiers
        'internal',
        // Type keywords
        'class', 'struct', 'interface', 'enum', 'record',
        'namespace', 'using',
        // Modifiers
        'static', 'readonly', 'const', 'volatile',
        'virtual', 'override', 'abstract', 'sealed',
        'async', 'await', 'partial', 'extern', 'unsafe', 'fixed',
        // Primitive types
        'void', 'int', 'uint', 'long', 'ulong', 'short', 'ushort',
        'byte', 'sbyte', 'float', 'double', 'decimal',
        'bool', 'char', 'string', 'object', 'dynamic', 'var',
        'nint', 'nuint',
        // Control flow extras
        'foreach', 'yield', 'goto', 'when',
        // Operators and literals
        'new', 'typeof', 'sizeof', 'nameof',
        'is', 'as', 'in', 'out', 'ref', 'params',
        'this', 'base', 'value',
        // Property accessors
        'get', 'set', 'init', 'add', 'remove',
        // LINQ
        'where', 'select', 'from', 'orderby', 'group', 'by',
        'into', 'join', 'on', 'equals', 'let', 'ascending', 'descending',
        // Other
        'delegate', 'event', 'operator', 'implicit', 'explicit',
        'checked', 'unchecked', 'lock', 'stackalloc',
        'with', 'and', 'or', 'not',
        'required', 'file', 'scoped',
        // Common framework types (often noise)
        'Task', 'Action', 'Func', 'List', 'Dictionary',
        'IEnumerable', 'IList', 'ICollection',
    ],
);

export const CSHARP_IDENTIFIER_NODES = new Set(['identifier', 'type_identifier']);

export const CSHARP_COMMENT_NODES = new Set(['comment', 'multiline_comment']);

export const CSHARP_METHOD_NODES = new Set([
    'method_declaration', 'constructor_declaration',
    'operator_declaration', 'conversion_operator_declaration',
    'local_function_statement',
]);

export const CSHARP_TYPE_NODES = new Set([
    'class_declaration', 'struct_declaration', 'interface_declaration',
    'enum_declaration', 'record_declaration',
]);

export const CSHARP_PROPERTY_NODES = new Set([
    'property_declaration', 'indexer_declaration',
]);

/** Case-insensitive keyword check */
export function isKeyword(term: string): boolean {
    return CSHARP_KEYWORDS.has(term.toLowerCase());
}
