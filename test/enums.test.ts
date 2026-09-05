import { test, expect } from 'vitest';
import { deserialize, JSONProperty, Serializable, getEnumValues } from '../src';

enum Numeric {
	Negative = -1,
	Fraction = 1.5,
	Large    = 1e21,
}

test('numeric enums reject reverse names for every numeric key representation', () => {
	@Serializable()
	class Model {
		@JSONProperty({
			type: Numeric,
		})
		public value!: Numeric;
	}

	expect(getEnumValues(Numeric)).toEqual([-1, 1.5, 1e21]);
	for (const value of ['Negative', 'Fraction', 'Large']) {
		expect(() => deserialize(Model, {
			value,
		})).toThrow('Expected one of');
	}

	for (const value of [-1, 1.5, 1e21]) {
		expect(deserialize(Model, {
			value,
		}).value).toBe(value);
	}
});
