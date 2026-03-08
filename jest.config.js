/** @type {import('jest').Config} */
export default {
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                useESM: true,
                tsconfig: {
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    target: 'ES2022',
                    strict: true,
                    esModuleInterop: true,
                    isolatedModules: true,
                    rootDir: '.',
                },
            },
        ],
    },
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/build/'],
};
