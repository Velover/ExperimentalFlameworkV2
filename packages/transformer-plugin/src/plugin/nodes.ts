import type { Expression, Node, NodeHint } from "../types";

type WrapArg<T> = T extends Node ? NodeHint<T> : T extends (infer U extends Node)[] ? NodeHint<U>[] : T;
type WrapArgs<T> = { [k in keyof T]: WrapArg<T[k]> };

type ConvertFactory<T> = {
	[k in keyof T]: T[k] extends ((...args: infer A) => infer R extends Node)
		? (previous: number | undefined, ...args: WrapArgs<A>) => NodeHint<R>
		: never;
};

type ObjectField<T = Expression> = { name: string; value: T };

declare const $factory: ConvertFactory<{
	string(value: string): Expression;
	bool(bool: boolean): Expression;
	number(value: number): Expression;
	array(values: Expression[]): Expression;
	identifier(name: string, unique?: boolean): Expression;
	object(fields: ObjectField<number>[]): Expression;
}>;

const NODE_CACHE = new Map<number, Node>();

export function instantiateNode<T extends Node>(index: NodeHint<T>) {
	const result = NODE_CACHE.get(index);
	if (result) {
		return result as never;
	}

	const value = { _nominal_Node: undefined!, id: index };
	NODE_CACHE.set(index, value);

	return value as unknown as T;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NodeFactory extends ReturnType<typeof createNodeFactory> {}

export function createNodeFactory() {
	const type = createTypeFactory();
	const expr = createExpressionFactory();
	const stmt = createStatementFactory();

	return { type, expr, stmt };
}

function factory<A extends unknown[], E extends Node>(
	invoker: (previous: NodeHint<E> | undefined, ...args: A) => NodeHint<E>,
) {
	function Factory(...args: A) {
		return instantiateNode(invoker(undefined, ...args));
	}

	Factory.update = function (previous: E, ...args: A) {
		return instantiateNode(invoker(previous.id as NodeHint<E>, ...args));
	};

	return Factory;
}

function createExpressionFactory() {
	const string = factory($factory.string);
	const bool = factory($factory.bool);
	const number = factory($factory.number);
	const identifier = factory($factory.identifier);
	const undefined = identifier("undefined");
	const array = factory((previous, values: Expression[]) =>
		$factory.array(
			previous,
			values.map((v) => v.id),
		),
	);
	const object = factory((previous, values: Record<string, Expression> | ObjectField[]) => {
		const fields = new Array<ObjectField<number>>();

		if (Array.isArray(values)) {
			fields.push(...values.map((v) => ({ name: v.name, value: v.value.id })));
		} else {
			for (const [name, value] of Object.entries(values)) {
				fields.push({ name, value: value.id });
			}
		}

		return $factory.object(previous, fields);
	});

	return { string, bool, number, identifier, undefined, array, object };
}

function createStatementFactory() {}

function createTypeFactory() {}
