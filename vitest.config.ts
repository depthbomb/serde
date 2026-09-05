import { defineConfig } from 'vitest/config';

export default defineConfig({
	oxc:  {
		tsconfig: './tsconfig.test.json',
	},
	test: {
		exclude: ['dist/**', 'node_modules/**'],
	},
});
