import { expect, test } from 'vitest';
import { deserialize, JSONProperty, Serializable, serialize } from '../src/index';

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
