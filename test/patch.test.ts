import { test, expect } from 'vitest';
import { patch, JSONProperty, Serializable } from '../src';

test('patch aliases replace existing canonical values and have deterministic precedence', () => {
	@Serializable()
	class Model {
		@JSONProperty({
			name:    'canonical',
			aliases: ['old_value'],
		})
		public value = 'original';
	}
	const original = new Model();
	const options = {
		strictPatch: true,
		strict:      true,
	};

	expect(patch(Model, original, {
		old_value: 'updated',
	}, options).value).toBe('updated');
	expect(patch(Model, original, {
		old_value: 'alias',
		canonical: 'canonical',
	}, options).value).toBe('canonical');
	expect(patch(Model, original, {
		old_value: 'alias',
		canonical: 'canonical',
		value:     'property',
	}, options).value).toBe('property');
	expect(original.value).toBe('original');
});
