import { expect, test } from 'vitest';
import { generateJSONSchema, JSONDiscriminator, JSONProperty, JSONSubType, JSONVersion, Serializable, serialize } from '../src/index';

test('schemas declare emitted version and discriminator fields', () => {
	@Serializable()
	class Base {}
	class Child extends Base {}
	JSONVersion(2, {
		field: 'revision',
	})(Base);
	JSONDiscriminator('kind')(Base);
	JSONSubType('child', Child)(Base);
	const schema = generateJSONSchema(Child);
	const raw    = serialize(new Child());

	expect(schema.properties).toEqual({
		revision: {
			type:  'integer',
			const: raw.revision,
		},
		kind: {
			type: 'string',
			enum: [raw.kind],
		},
	});
	expect(schema.required).toEqual(['revision', 'kind']);
});
