import { expect, test } from 'vitest';
import { deserialize, JSONDiscriminator, JSONProperty, JSONSubType, Serializable, serialize } from '../src/index';

test('strict and collect modes recognize all aliases while canonical input wins', () => {
	@Serializable()
	class Model {
		@JSONProperty({ aliases: ['old_value'] })
		public value!: string;

		public extra!: Record<string, unknown>;
	}
	const raw = {
		value:     'new',
		old_value: 'old',
	};

	expect(deserialize(Model, raw, '$', {
		strict: true,
	}).value).toBe('new');
	expect(deserialize(Model, raw, '$', {
		unknownProperties: 'collect',
		unknownProperty:   'extra',
	}).extra).toEqual({});
	expect(() => deserialize(Model, {
		...raw,
		extraneous: true,
	}, '$', {
		strict: true,
	})).toThrow('Unexpected property "extraneous"');
});

test('strict mode accepts an automatically emitted discriminator', () => {
	class Base {}
	class Child extends Base {}
	Serializable()(Base);
	JSONDiscriminator('kind')(Base);
	JSONSubType('child', Child)(Base);

	expect(deserialize(Base, serialize(new Child()), '$', {
		strict: true,
	})).toBeInstanceOf(Child);
});
