import { test, expect } from 'vitest';
import { serialize, deserialize, JSONProperty, Serializable, generateJSONSchema } from '../src';

test('one reusable property decorator registers every field on a class', () => {
	const required = JSONProperty({
		optional: false,
	});
	@Serializable()
	class Pair {
		@required
		public first = 1;

		@required
		public second = 2;
	}

	expect(serialize(new Pair())).toEqual({
		first:  1,
		second: 2,
	});
	expect(generateJSONSchema(Pair).required).toEqual(['first', 'second']);
	expect(() => deserialize(Pair, {
		first: 1,
	})).toThrow('Missing required property "second"');
});
