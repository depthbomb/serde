import { test, expect } from 'vitest';
import { deserialize, JSONSubType, JSONDiscriminator } from '../src';

test('subclass subtype overrides do not change base or sibling dispatch', () => {
	class Base {}
	class First extends Base {}
	class Branch extends Base {}
	class Second extends Branch {}
	JSONDiscriminator('kind')(Base);
	JSONSubType('item', First)(Base);
	JSONSubType('item', Second)(Branch);

	expect(deserialize(Base, { kind: 'item' })).toBeInstanceOf(First);
	expect(deserialize(First, { kind: 'item' })).toBeInstanceOf(First);
	expect(deserialize(Branch, { kind: 'item' })).toBeInstanceOf(Second);
});

test('subclass registrations retain inherited mappings without extending the base registry', () => {
	class Base {}
	class First extends Base {}
	class Branch extends Base {}
	class Second extends Branch {}
	JSONDiscriminator('kind')(Base);
	JSONSubType('first', First)(Base);
	JSONSubType('second', Second)(Branch);

	expect(deserialize(Branch, { kind: 'first' })).toBeInstanceOf(First);
	expect(deserialize(Branch, { kind: 'second' })).toBeInstanceOf(Second);
	expect(() => deserialize(Base, { kind: 'second' })).toThrow('Unknown discriminator value');
	expect(() => deserialize(First, { kind: 'second' })).toThrow('Unknown discriminator value');
});
