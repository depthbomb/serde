import ts from 'typescript';
import { test, expect } from 'vitest';
import { serialize, deserialize, JSONProperty, Serializable, getJSONProperties, generateJSONSchema } from '../src';

test('actual standard decorators expose inherited metadata before construction', () => {
	const source = `
const required = JSONProperty({
	type:     String,
	optional: false,
});
@Serializable()
class Base {
	@required
	public first!: string;

	@required
	public second!: string;

	public constructor() {
		throw new Error('Schema generation must not construct instances');
	}
}
@Serializable()
class Child extends Base {
	@JSONProperty({
		type: Number,
	})
	public third!: number;
}
@Serializable()
class Sibling extends Base {
	@JSONProperty({
		type: Boolean,
	})
	public fourth!: boolean;
}

return {
	Base,
	Child,
	Sibling,
};
`;
	const compiled = ts.transpileModule(source, {
		compilerOptions: {
			target:                 ts.ScriptTarget.ES2022,
			module:                 ts.ModuleKind.None,
			experimentalDecorators: false,
		},
	}).outputText;
	const { Base, Child, Sibling } = new Function('JSONProperty', 'Serializable', compiled)(JSONProperty, Serializable);

	expect(getJSONProperties(Child).map(meta => meta.propertyKey)).toEqual(['third', 'first', 'second']);
	expect(getJSONProperties(Sibling).map(meta => meta.propertyKey)).toEqual(['fourth', 'first', 'second']);
	expect(generateJSONSchema(Base).required).toEqual(['first', 'second']);
	expect(generateJSONSchema(Child).required).toEqual(['first', 'second']);
	expect(() => deserialize(Child, {})).toThrow('Constructor for "Child" failed');
	const value = Object.assign(Object.create(Child.prototype), {
		first:  'one',
		second: 'two',
		third:  3,
	});
	expect(serialize(value)).toEqual({
		first:  'one',
		second: 'two',
		third:  3,
	});
});
