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

test('schema identifiers distinguish same-name constructors and recursive root references', () => {
	const First = class Model {};
	const Other = class Model {};
	const Root  = class Model {};
	JSONProperty({ type: String })(First.prototype, 'text');
	JSONProperty({ type: Number })(Other.prototype, 'number');
	JSONProperty({ type: First })(Root.prototype, 'first');
	JSONProperty({ type: Other })(Root.prototype, 'other');
	JSONProperty({ type: Root })(Other.prototype, 'root');
	JSONProperty({ type: Other })(Other.prototype, 'self');
	const schema = generateJSONSchema(Root);

	expect(schema.properties).toEqual({
		first: {
			$ref: '#/$defs/Model_2',
		},
		other: {
			$ref: '#/$defs/Model_3',
		},
	});
	expect(schema.$defs).toMatchObject({
		Model_2: {
			properties: {
				text: {
					type: 'string',
				},
			},
		},
		Model_3: {
			properties: {
				number: {
					type: 'number',
				},
				root: {
					$ref: '#',
				},
				self: {
					$ref: '#/$defs/Model_3',
				},
			},
		},
	});
});
