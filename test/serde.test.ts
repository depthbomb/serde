import { describe, test, expect } from 'vitest';
import {
	Serializable,
	JSONProperty,
	JSONDiscriminator,
	JSONSubType,
	deserialize,
	deserializeArray,
	serialize,
	serializeArray,
	toJSON,
	fromJSON,
	clone,
	isSerializable,
	isEnum,
	patch,
} from '../src/serde';
import { SerializationError } from '../src/errors';

// simple class
@Serializable()
class User {
	@JSONProperty({ name: 'first_name' })
	firstName!: string;

	@JSONProperty()
	age!: number;
}

describe('core serde functionality', () => {
	test('primitive properties serialize/deserialize', () => {
		const u = new User();
		u.firstName = 'Ada';
		u.age = 36;

		expect(serialize(u)).toEqual({ first_name: 'Ada', age: 36 });

		const v = deserialize(User, { first_name: 'Ada', age: 36 });
		expect(v).toBeInstanceOf(User);
		expect(v.firstName).toBe('Ada');
	});

	test('toJSON/fromJSON round trip', () => {
		const u = new User();
		u.firstName = 'Bob';
		u.age = 20;
		const json = toJSON(u);
		expect(fromJSON(User, json)).toEqual(u);
	});

	test('isSerializable helper', () => {
		expect(isSerializable(User)).toBe(true);
		expect(isSerializable(class {})).toBe(false);
	});

	test('deserialize with strict mode rejects unknown keys', () => {
		expect(() => deserialize(User, { first_name: 'A', age: 1, extra: true }, '$', { strict: true })).toThrow(SerializationError);
	});

	test('strict mode on arrays rejects extras', () => {
		expect(() => deserializeArray(User, [{ first_name: 'foo', age: 1, extra: 2 }], '$', { strict: true })).toThrow(SerializationError);
	});

	test('serializeArray / deserializeArray', () => {
		const arr = [new User(), new User()];
		arr[0].firstName = 'X';
		arr[0].age = 1;
		arr[1].firstName = 'Y';
		arr[1].age = 2;
		const plain = serializeArray(arr);
		expect(Array.isArray(plain)).toBe(true);
		expect(deserializeArray(User, plain)).toEqual(arr);
	});
});

// nested types, defaults, arrays, maps
@Serializable()
class Address {
	@JSONProperty()
	street!: string;

	@JSONProperty()
	city!: string;
}

@Serializable()
class Person {
	@JSONProperty()
	name!: string;

	@JSONProperty({ type: () => Address })
	address!: Address;
}

describe('nested / collection examples', () => {
	test('nested class deserializes properly', () => {
		const raw = { name: 'Grace', address: { street: '42', city: 'NY' } };
		const p = deserialize(Person, raw);
		expect(p.address).toBeInstanceOf(Address);
		expect(serialize(p)).toEqual(raw);
	});

	@Serializable()
	class Order {
		@JSONProperty({ type: () => LineItem, isArray: true })
		items!: LineItem[];
	}

	@Serializable()
	class LineItem {
		@JSONProperty()
		name!: string;
		@JSONProperty()
		qty!: number;
	}

	test('array of classes', () => {
		const o = new Order();
		o.items = [{ name: 'a', qty: 1 }].map((x) => Object.assign(new LineItem(), x));
		const round = deserialize(Order, serialize(o));
		expect(round).toEqual(o);
	});

	@Serializable()
	class Catalog {
		@JSONProperty({ type: () => Product, isMap: true })
		products!: Map<string, Product>;
	}

	@Serializable()
	class Product {
		@JSONProperty()
		price!: number;
	}

	test('map property', () => {
		const cat = new Catalog();
		cat.products = new Map([['sku', Object.assign(new Product(), { price: 5 })]]);
		const plain = serialize(cat);
		expect(plain).toEqual({ products: { sku: { price: 5 } } });
		const back = deserialize(Catalog, plain);
		expect(back.products.get('sku')).toBeInstanceOf(Product);
	});
});

// defaults/optional/nullable/validation
@Serializable()
class Settings {
	@JSONProperty({ defaultValue: 'light' })
	theme!: string;

	@JSONProperty({ defaultValue: () => [] })
	tags!: string[];

	@JSONProperty({ optional: false })
	required!: number;

	@JSONProperty({ nullable: 'error' })
	notNull!: string | null;
}

describe('defaults/required/nullable/validation', () => {
	test('defaults applied and required enforced', () => {
		const s = deserialize(Settings, { required: 1, notNull: 'x' });
		expect(s.theme).toBe('light');
		expect(s.tags).toEqual([]);
		expect(() => deserialize(Settings, { notNull: 'x' })).toThrow(SerializationError);
	});

	test('nullable error behaviour', () => {
		expect(() => deserialize(Settings, { required: 2, notNull: null })).toThrow(SerializationError);
	});

	@Serializable()
	class Positive {
		@JSONProperty({ validate: (v: number) => v > 0 || 'must be >0' })
		value!: number;
	}

	test('validation function', () => {
		expect(() => deserialize(Positive, { value: -1 })).toThrow(SerializationError);
	});
});

// discriminator tests
// declare the base class first without decorators
class Shape {
	@JSONProperty()
	type!: string;
	@JSONProperty()
	color!: string;
}

@Serializable()
class Circle extends Shape {
	@JSONProperty()
	radius!: number;
}

@Serializable()
class Rectangle extends Shape {
	@JSONProperty()
	width!: number;
}

// now apply serialization-related decorators to Shape after subclasses exist
Serializable()(Shape);
JSONDiscriminator('type')(Shape);
JSONSubType('circle', Circle)(Shape);
JSONSubType('rect', Rectangle)(Shape);

describe('polymorphic deserialization', () => {
	test('dispatches to correct subtype', () => {
		const raw = { type: 'circle', color: 'red', radius: 5 };
		const s = deserialize(Shape, raw);
		expect(s).toBeInstanceOf(Circle);
		expect(s).toEqual(Object.assign(new Circle(), raw));
	});

	test('invalid discriminator value throws', () => {
		expect(() => deserialize(Shape, { type: 'triangle' } as any)).toThrow(SerializationError);
	});
});

// miscellaneous behaviours
// undecorated objects now throw during serialization
describe('miscellaneous behaviours', () => {
	test('serializing plain object throws', () => {
		expect(() => serialize({ foo: 1 } as any)).toThrow(SerializationError);
	});

	test('clone creates deep copy', () => {
		const u = new User();
		u.firstName = 'foo';
		u.age = 3;
		const c = clone(User, u);
		expect(c).toEqual(u);
		expect(c).not.toBe(u);
	});

	test('patch merges partial updates', () => {
		const u = new User();
		u.firstName = 'Alice';
		u.age = 25;
		const updated = patch(User, u, { age: 26 });
		expect(updated.firstName).toBe('Alice');
		expect(updated.age).toBe(26);
		expect(updated).not.toBe(u); // returns new instance
	});
});

// Enums

enum StringStatus {
	Active = 'ACTIVE',
	Inactive = 'INACTIVE',
	Pending = 'PENDING'
}

enum NumericPriority {
	Low = 0,
	Medium = 1,
	High = 2
}

enum HeterogeneousKind {
	Success = 'SUCCESS',
	Failed = 1,
	Warning = 'WARNING'
}

@Serializable()
class Task {
	@JSONProperty()
	title!: string;

	@JSONProperty({ type: () => StringStatus })
	status!: StringStatus;

	@JSONProperty({ type: () => NumericPriority })
	priority!: NumericPriority;

	@JSONProperty({ type: () => HeterogeneousKind, optional: true })
	kind?: HeterogeneousKind;
}

@Serializable()
class TaskList {
	@JSONProperty({ type: () => Task, isArray: true })
	tasks!: Task[];

	@JSONProperty({ type: () => StringStatus, isMap: true })
	statusLookup!: Map<string, StringStatus>;
}

describe('enum support', () => {
	test('string enum deserializes and serializes', () => {
		const raw = { title: 'Fix bug', status: 'ACTIVE', priority: 1 };
		const task = deserialize(Task, raw);
		expect(task.status).toBe(StringStatus.Active);
		expect(task.priority).toBe(NumericPriority.Medium);
		expect(serialize(task)).toEqual(raw);
	});

	test('numeric enum round-trips', () => {
		const task = new Task();
		task.title = 'Test';
		task.status = StringStatus.Pending;
		task.priority = NumericPriority.High;
		const plain = serialize(task);
		expect(plain.priority).toBe(2);
		const back = deserialize(Task, plain);
		expect(back.priority).toBe(NumericPriority.High);
	});

	test('heterogeneous enum works', () => {
		const raw = { title: 'Task', status: 'ACTIVE', priority: 0, kind: 'SUCCESS' };
		const task = deserialize(Task, raw);
		expect(task.kind).toBe(HeterogeneousKind.Success);
		expect(serialize(task)).toEqual(raw);
	});

	test('heterogeneous numeric enum value', () => {
		const raw = { title: 'Task', status: 'ACTIVE', priority: 0, kind: 1 };
		const task = deserialize(Task, raw);
		expect(task.kind).toBe(HeterogeneousKind.Failed);
		expect(serialize(task)).toEqual(raw);
	});

	test('invalid enum value throws', () => {
		expect(() => deserialize(Task, { title: 'Task', status: 'INVALID', priority: 0 })).toThrow(SerializationError);
	});

	test('enum in array', () => {
		const raw = {
			tasks: [
				{ title: 'Task 1', status: 'ACTIVE', priority: 0 },
				{ title: 'Task 2', status: 'PENDING', priority: 2 }
			],
			statusLookup: { active: 'ACTIVE', pending: 'PENDING' }
		};
		const list = deserialize(TaskList, raw);
		expect(list.tasks[0].status).toBe(StringStatus.Active);
		expect(list.tasks[1].status).toBe(StringStatus.Pending);
		expect(serialize(list)).toEqual(raw);
	});

	test('enum in map', () => {
		const raw = {
			tasks: [],
			statusLookup: { a: 'ACTIVE', b: 'INACTIVE' }
		};
		const list = deserialize(TaskList, raw);
		expect(list.statusLookup.get('a')).toBe(StringStatus.Active);
		expect(list.statusLookup.get('b')).toBe(StringStatus.Inactive);
		expect(serialize(list)).toEqual(raw);
	});

	test('invalid enum in array throws', () => {
		expect(() => deserialize(TaskList, {
			tasks: [{ title: 'Task', status: 'NOPE', priority: 0 }],
			statusLookup: {}
		})).toThrow(SerializationError);
	});

	test('isEnum detects enums', () => {
		expect(isEnum(StringStatus)).toBe(true);
		expect(isEnum(NumericPriority)).toBe(true);
		expect(isEnum(HeterogeneousKind)).toBe(true);
		expect(isEnum({ foo: 'bar' })).toBe(false);
		expect(isEnum(Task)).toBe(false);
		expect(isEnum([])).toBe(false);
		expect(isEnum(null)).toBe(false);
	});

	test('enum with toJSON/fromJSON', () => {
		const task = new Task();
		task.title = 'Test';
		task.status = StringStatus.Active;
		task.priority = NumericPriority.High;
		const json = toJSON(task);
		const back = fromJSON(Task, json);
		expect(back.status).toBe(StringStatus.Active);
		expect(back.priority).toBe(NumericPriority.High);
	});

	test('enum clone preserves values', () => {
		const task = new Task();
		task.title = 'Original';
		task.status = StringStatus.Inactive;
		task.priority = NumericPriority.Low;
		const cloned = clone(Task, task);
		expect(cloned.status).toBe(StringStatus.Inactive);
		expect(cloned.priority).toBe(NumericPriority.Low);
	});
});
