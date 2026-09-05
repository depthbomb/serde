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

test('async serialization preserves codecs and synchronous wire transforms', async () => {
	@Serializable()
	class Child {
		@JSONProperty()
		public id = 7;
	}
	const codec = {
		serialize:   (value: Child) => value.id,
		deserialize: (value: unknown) => Object.assign(new Child(), {
			id: Number(value),
		}),
	};
	@Serializable()
	class Parent {
		@JSONProperty({ codec })
		public child = new Child();

		@JSONProperty({
			codec,
			isArray: true,
		})
		public children = [new Child()];

		@JSONProperty({ serializeTransform: (value: Child) => value.id })
		public transformed = new Child();
	}
	const value = new Parent();

	expect(await serializeAsync(value)).toEqual({
		child:       7,
		children:    [7],
		transformed: 7,
	});
	expect(await serializeAsync(value)).toEqual(serialize(value));
});

test('async hooks run inside plain objects and nested array wrappers', async () => {
	@Serializable()
	class Child {
		@JSONProperty({ serializeAsyncTransform: async (value: string) => value.toUpperCase() })
		public value = 'lowercase';
	}
	@Serializable()
	class Parent {
		@JSONProperty()
		public wrapper = {
			children: [[new Child()]],
		};
	}

	expect(await serializeAsync(new Parent())).toEqual({
		wrapper: {
			children: [[{
				value: 'LOWERCASE',
			}]],
		},
	});
});

test('async transforms normalize unsupported input before serialization', async () => {
	@Serializable()
	class Bytes {
		@JSONProperty({ serializeAsyncTransform: async (value: Uint8Array) => Array.from(value) })
		public bytes = new Uint8Array([1, 2]);

		@JSONProperty({
			sensitive: true,
			serializeAsyncTransform: async () => {
				throw new Error('Hidden transforms must not run');
			},
		})
		public secret = 'hidden';
	}
	@Serializable()
	class Parent {
		@JSONProperty({ type: Bytes })
		public child = new Bytes();
	}

	expect(await serializeAsync(new Parent())).toEqual({
		child: {
			bytes: [1, 2],
		},
	});
	expect(() => serialize(new Bytes())).toThrow('unmarked class');
});
