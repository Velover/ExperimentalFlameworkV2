import { registerPlugin, type Expression } from "../index";

registerPlugin((api) => {
	const expr = api.factory.expr;

	api.registerMacroType("testPlugin", (ty) => {
		const array = new Array<Expression>();

		if (!ty.isUnion() && !ty.isIntersection()) {
			return expr.array([]);
		}

		for (const constituent of ty.getConstituents()) {
			if (!constituent.isTuple()) {
				continue;
			}

			for (const tupleElement of constituent.getElements()) {
				array.push(
					expr.object({
						name: tupleElement.name ? expr.string(tupleElement.name) : expr.undefined,
						optional: expr.bool(tupleElement.optional),
						spread: expr.bool(tupleElement.spread),
						type: expr.string(tupleElement.type.toString()),
					}),
				);
			}
		}

		return expr.array(array);
	});

	api.registerMacroType("testPlugin2", (ty) => {
		const result = new Array<Expression>();
		if (ty.isObjectLike()) {
			for (const sig of ty.getCallSignatures()) {
				result.push(
					expr.string(`(${sig.inputs.map((v) => v.toString()).join(", ")}) -> ${sig.output.toString()}`),
				);
			}

			for (const sig of ty.getConstructSignatures()) {
				result.push(
					expr.string(`new (${sig.inputs.map((v) => v.toString()).join(", ")}) -> ${sig.output.toString()}`),
				);
			}

			for (const sig of ty.getIndexSignatures()) {
				result.push(
					expr.string(`${sig.readonly ? "readonly " : ""}[${sig.key.toString()}]: ${sig.value.toString()}`),
				);
			}

			for (const field of ty.getFields()) {
				result.push(
					expr.object({
						name: expr.string(field.name),
						readonly: expr.bool(field.readonly),
						type: expr.string(field.type.toString()),
					}),
				);
			}
		}
		return expr.array(result.map((v) => expr.object({ value: v })));
	});
});
