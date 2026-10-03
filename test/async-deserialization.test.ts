import { test, expect } from 'vitest';
import { JSONProperty, Serializable, deserializeAsync } from '../src';

test('async hooks skip absent and ignored fields but process supplied values and defaults', async () => {
	const transformed = [] as string[];
	@Serializable()
	class Child {
		@JSONProperty({
			deserializeAsyncTransform: async (value: string) => {
				transformed.push(value);

				return value.toUpperCase();
			},
			validateAsync:             async value => value.length > 0,
		})
		public optional = 'constructor';

		@JSONProperty({
			defaultValue:              'default',
			deserializeAsyncTransform: async (value: string) => value.toUpperCase(),
		})
		public defaulted!: string;
	}
	@Serializable()
	class Parent {
		@JSONProperty({
			type:    Child,
			isArray: true,
		})
		public children!: Child[];
	}
	const value = await deserializeAsync(Parent, {
		children: [{}, {
			optional: null,
		}, {
			optional: 'present',
		}],
	});

	expect(value.children.map(child => child.optional)).toEqual(['constructor', 'constructor', 'PRESENT']);
	expect(value.children.map(child => child.defaulted)).toEqual(['DEFAULT', 'DEFAULT', 'DEFAULT']);
	expect(transformed).toEqual(['present']);
});

test.each(['array', 'set', 'map'] as const)('async %s children finish before parent hooks and still run concurrently', async kind => {
	const calls = [] as string[];
	@Serializable()
	class Child {
		@JSONProperty({
			deserializeAsyncTransform: async (value: string) => {
				calls.push(`start:${value}`);
				await Promise.resolve();
				calls.push(`end:${value}`);

				return value.toUpperCase();
			},
			validateAsync: async value => {
				calls.push(`validate:${value}`);
			},
		})
		public value!: string;
	}
	@Serializable()
	class Parent {
		@JSONProperty<unknown>({
			type: Child,
			isArray: kind === 'array',
			isSet: kind === 'set',
			isMap: kind === 'map',
			deserializeAsyncTransform: async value => {
				const children = value instanceof Map ? Array.from(value.values()) : Array.from(value as Iterable<Child | null>);
				expect(children.map(child => child?.value)).toEqual([undefined, 'A', 'B']);
				calls.push('parent');

				return value;
			},
			validateAsync: async () => {
				calls.push('validate:parent');
			},
		})
		public values!: unknown;
	}
	const entries = [null, { value: 'a' }, { value: 'b' }];
	await deserializeAsync(Parent, {
		values: kind === 'map' ? Object.fromEntries(entries.map((value, index) => [String(index), value])) : entries,
	});

	expect(calls.slice(0, 2)).toEqual(['start:a', 'start:b']);
	expect(calls.slice(-2)).toEqual(['parent', 'validate:parent']);
	expect(calls.filter(value => value.startsWith('validate:'))).toEqual(['validate:A', 'validate:B', 'validate:parent']);
});

test('async validation retains escaped paths through nested maps', async () => {
	@Serializable()
	class Child {
		@JSONProperty({
			validateAsync: async () => 'invalid value',
		})
		public value!: number;
	}
	class Parent {
		@JSONProperty({
			name: 'value.list',
			type: Child,
			isMap: true,
		})
		public values!: Map<string, Child>;
	}

	await expect(deserializeAsync(Parent, {
		'value.list': {
			'key.with.dot': { value: 1 },
		},
	})).rejects.toMatchObject({
		code: 'VALIDATION_FAILED',
		path: '$["value.list"]["key.with.dot"].value',
	});
});
