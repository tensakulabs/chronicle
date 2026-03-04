/**
 * Python language configuration for Chronicle
 */
import { buildKeywords } from './common.js';

export const PYTHON_KEYWORDS = buildKeywords(
    [
        // Keywords
        'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
        'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
        'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
        'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
        'try', 'while', 'with', 'yield',
        // Soft keywords (Python 3.10+)
        'match', 'case', 'type',
        // Built-in types
        'int', 'float', 'str', 'bool', 'bytes', 'list', 'dict', 'set',
        'tuple', 'frozenset', 'object',
        // Built-in functions (common ones)
        'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
        'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'round',
        'open', 'input', 'isinstance', 'issubclass', 'hasattr', 'getattr',
        'setattr', 'delattr', 'callable', 'iter', 'next', 'super',
        'staticmethod', 'classmethod', 'property',
        // Common exceptions
        'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
        'AttributeError', 'RuntimeError', 'StopIteration',
        // Common decorators
        'abstractmethod', 'dataclass', 'overload',
        // Type hints
        'Optional', 'List', 'Dict', 'Set', 'Tuple', 'Union', 'Any',
        'Callable', 'Iterable', 'Iterator', 'Generator',
        'TypeVar', 'Generic', 'Protocol',
        // Magic names
        'self', 'cls',
    ],
);

export const PYTHON_IDENTIFIER_NODES = new Set(['identifier']);
export const PYTHON_COMMENT_NODES = new Set(['comment']);
export const PYTHON_METHOD_NODES = new Set(['function_definition']);
export const PYTHON_TYPE_NODES = new Set(['class_definition']);

/** Case-sensitive keyword check */
export function isKeyword(term: string): boolean {
    return PYTHON_KEYWORDS.has(term);
}
