/**
 * An example Flamework transformer plugin, also used as the fixture for the plugin test suite.
 *
 * Plugins are loaded with `require`, so they must be CommonJS.
 */
const { registerPlugin } = require("rbxts-transformer-flamework-plugin");

registerPlugin((api) => {
	const expr = api.factory.expr;
	const prefix = api.options.prefix ?? "";

	function describe(type) {
		if (type.isLiteral("string")) return `string:${type.getLiteralValue()}`;
		if (type.isLiteral("number")) return `number:${type.getLiteralValue()}`;
		if (type.isLiteral("boolean")) return `boolean:${type.getLiteralValue()}`;
		if (type.isPrimitive("string")) return "string";
		if (type.isPrimitive("number")) return "number";
		if (type.isPrimitive("boolean")) return "boolean";
		if (type.isTuple())
			return `tuple[${type
				.getElements()
				.map((v) => describe(v.type))
				.join(",")}]`;
		if (type.isArray()) return `array<${describe(type.getElementType())}>`;
		if (type.isUnion()) return `union(${type.getConstituents().map(describe).sort().join("|")})`;
		return type.toString();
	}

	/** Emits `{ name, kind, optional, readonly }` for every field of an object type. */
	api.registerMacroType("fieldInfo", (type) => {
		if (!type.isObjectLike()) {
			return expr.array([]);
		}

		return expr.array(
			type.getFields().map((field) =>
				expr.object({
					name: expr.string(prefix + field.name),
					kind: expr.string(describe(field.type)),
					optional: expr.bool(field.optional),
					readonly: expr.bool(field.readonly),
				}),
			),
		);
	});

	/** Exercises the expression factory beyond literals. */
	api.registerMacroType("describe", (type) => expr.string(describe(type)));

	/** Builds a callable, to prove the factory can emit more than data. */
	api.registerMacroType("counter", (type, context) => {
		context.warning(`counter macro used with ${type.toString()}`);

		return expr.arrow(["increment"], expr.binary(expr.identifier("increment"), "+", expr.number(1)));
	});

	/** Reports a diagnostic at the call site when misused. */
	api.registerMacroType("mustBeUnion", (type, context) => {
		if (!type.isUnion()) {
			context.error("mustBeUnion requires a union type");
		}

		return expr.number(type.getConstituents().length);
	});
});
