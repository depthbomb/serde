import { test, expect } from 'vitest';
import { serialize, deserialize, JSONProperty, Serializable } from '../src';

test('an explicit null default satisfies a required nullable field', () => {
	@Serializable()
	class NullableDefault {
		@JSONProperty({
			defaultValue: null,
			optional:     false,
			nullable:     'null',
		})
		public value!: string | null;
	}
	const value = deserialize(NullableDefault, {});

	expect(value.value).toBeNull();
	expect(serialize(value)).toEqual({
		value: null,
	});
});
