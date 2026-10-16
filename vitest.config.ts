import swc from 'unplugin-swc'
import {defineConfig} from 'vitest/config'

export default defineConfig({
    // esbuild drops decorator metadata, which the generated TypeORM models need.
    plugins: [swc.vite({jsc: {parser: {syntax: 'typescript', decorators: true}, transform: {legacyDecorator: true, decoratorMetadata: true}}})],
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
    },
})
