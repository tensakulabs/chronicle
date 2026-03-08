import { extract, detectLanguage, isSupported } from '../../src/parser/extractor.js';

describe('detectLanguage', () => {
    test('detects TypeScript files', () => {
        expect(detectLanguage('src/main.ts')).toBe('typescript');
        expect(detectLanguage('src/App.tsx')).toBe('typescript');
    });

    test('detects JavaScript files', () => {
        expect(detectLanguage('src/index.js')).toBe('javascript');
        expect(detectLanguage('src/App.jsx')).toBe('javascript');
        expect(detectLanguage('src/lib.mjs')).toBe('javascript');
    });

    test('detects Python files', () => {
        expect(detectLanguage('main.py')).toBe('python');
    });

    test('detects Rust files', () => {
        expect(detectLanguage('src/lib.rs')).toBe('rust');
    });

    test('detects C# files', () => {
        expect(detectLanguage('Program.cs')).toBe('csharp');
    });

    test('returns null for unsupported files', () => {
        expect(detectLanguage('README.md')).toBeNull();
        expect(detectLanguage('data.json')).toBeNull();
        expect(detectLanguage('style.css')).toBeNull();
    });
});

describe('isSupported', () => {
    test('returns true for supported extensions', () => {
        expect(isSupported('file.ts')).toBe(true);
        expect(isSupported('file.py')).toBe(true);
        expect(isSupported('file.rs')).toBe(true);
    });

    test('returns false for unsupported extensions', () => {
        expect(isSupported('file.md')).toBe(false);
        expect(isSupported('file.yaml')).toBe(false);
    });
});

describe('extract', () => {
    test('returns null for unsupported file types', () => {
        const result = extract('# Hello', 'README.md');
        expect(result).toBeNull();
    });

    test('extracts identifiers from TypeScript', () => {
        const code = `
const myVariable = 42;
function processData(input: string): number {
    return input.length;
}
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();
        expect(result!.language).toBe('typescript');

        const terms = result!.items.map(i => i.term);
        expect(terms).toContain('myVariable');
        expect(terms).toContain('processData');
    });

    test('extracts methods from TypeScript', () => {
        const code = `
function greet(name: string): string {
    return \`Hello, \${name}\`;
}

async function fetchData(url: string): Promise<Response> {
    return fetch(url);
}
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();

        const methodNames = result!.methods.map(m => m.name);
        expect(methodNames).toContain('greet');
        expect(methodNames).toContain('fetchData');

        const fetchMethod = result!.methods.find(m => m.name === 'fetchData');
        expect(fetchMethod!.isAsync).toBe(true);
    });

    test('extracts types from TypeScript', () => {
        const code = `
interface UserConfig {
    name: string;
    age: number;
}

class UserService {
    getUser(id: number): UserConfig {
        return { name: 'test', age: 0 };
    }
}

enum Status {
    Active,
    Inactive,
}
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();

        const typeNames = result!.types.map(t => t.name);
        expect(typeNames).toContain('UserConfig');
        expect(typeNames).toContain('UserService');
        expect(typeNames).toContain('Status');

        const userConfig = result!.types.find(t => t.name === 'UserConfig');
        expect(userConfig!.kind).toBe('interface');

        const userService = result!.types.find(t => t.name === 'UserService');
        expect(userService!.kind).toBe('class');

        const status = result!.types.find(t => t.name === 'Status');
        expect(status!.kind).toBe('enum');
    });

    test('extracts header comments', () => {
        const code = `/**
 * This is a header comment
 * describing the module
 */

function main() {}
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();
        expect(result!.headerComments.length).toBeGreaterThan(0);
        expect(result!.headerComments[0]).toContain('header comment');
    });

    test('extracts arrow functions as methods', () => {
        const code = `
const handleClick = (event: MouseEvent) => {
    console.log(event);
};
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();

        const methodNames = result!.methods.map(m => m.name);
        expect(methodNames).toContain('handleClick');
    });

    test('filters out short identifiers and keywords', () => {
        const code = `
const x = 1;
if (true) {
    return false;
}
`;
        const result = extract(code, 'test.ts');
        expect(result).not.toBeNull();

        const terms = result!.items.map(i => i.term);
        // Single-char 'x' should be filtered (< 2 chars)
        expect(terms).not.toContain('x');
        // Keywords should be filtered
        expect(terms).not.toContain('if');
        expect(terms).not.toContain('return');
        expect(terms).not.toContain('const');
    });

    test('extracts from Python code', () => {
        const code = `
class Calculator:
    def add(self, a: int, b: int) -> int:
        return a + b

    def multiply(self, a: int, b: int) -> int:
        return a * b
`;
        const result = extract(code, 'calculator.py');
        expect(result).not.toBeNull();
        expect(result!.language).toBe('python');

        const typeNames = result!.types.map(t => t.name);
        expect(typeNames).toContain('Calculator');

        const methodNames = result!.methods.map(m => m.name);
        expect(methodNames).toContain('add');
        expect(methodNames).toContain('multiply');
    });
});
