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
