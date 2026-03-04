/**
 * C++ language configuration for Chronicle
 */
import { FLOW, ACCESS, buildKeywords } from './common.js';

export const CPP_KEYWORDS = buildKeywords(
    FLOW, ACCESS,
    [
        // Type keywords
        'class', 'struct', 'union', 'enum', 'namespace', 'using',
        'typename', 'void', 'bool',
        'char', 'char8_t', 'char16_t', 'char32_t', 'wchar_t',
        'short', 'int', 'long', 'signed', 'unsigned', 'float', 'double',
        // Modifiers
        'static', 'extern', 'const', 'volatile', 'mutable',
        'constexpr', 'consteval', 'constinit',
        'inline', 'virtual', 'explicit', 'export', 'friend', 'typedef',
        // Exception handling
        'try', 'catch', 'throw',
        // Operators & literals
        'new', 'delete', 'this', 'nullptr', 'true', 'false',
        'sizeof', 'typeid', 'decltype',
        'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
        'operator',
        // C++11 features
        'alignas', 'alignof', 'auto', 'static_assert', 'noexcept',
        'thread_local',
        // C++17/20 features
        'concept', 'requires', 'co_await', 'co_return', 'co_yield',
        // Alternative operators (ISO C++)
        'and', 'or', 'not',
        'and_eq', 'or_eq', 'xor', 'xor_eq',
        'bitand', 'bitor', 'compl', 'not_eq',
        // Contextual keywords
        'final', 'override', 'import', 'module',
        // Other
        'asm', 'register', 'goto',
    ],
);

export const CPP_IDENTIFIER_NODES = new Set([
    'identifier', 'type_identifier', 'field_identifier', 'namespace_identifier',
]);

export const CPP_COMMENT_NODES = new Set(['comment']);

export const CPP_METHOD_NODES = new Set([
    'function_definition', 'template_function',
]);

export const CPP_TYPE_NODES = new Set([
    'class_specifier', 'struct_specifier', 'union_specifier',
    'enum_specifier', 'type_definition', 'template_declaration',
]);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return CPP_KEYWORDS.has(term);
}
