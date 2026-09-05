import { expect, test } from 'vitest';
import { JSONProperty, Serializable, serialize, serializeAsync } from '../src/index';

test('async serialization permits shared siblings and rejects ancestor cycles', async () => {
	@Serializable()
	class Child {
		@JSONProperty()
		public id = 1;
	}
	@Serializable()
	class Parent {
		@JSONProperty({ isArray: true })
		public children = [] as object[];
	}
	const child  = new Child();
	const parent = new Parent();
	parent.children = [child, child];

	expect(await serializeAsync(parent)).toEqual(serialize(parent));
	parent.children = [parent];
	await expect(serializeAsync(parent)).rejects.toMatchObject({
		code: 'CIRCULAR_REFERENCE',
		path: '$.children[0]',
	});
});
