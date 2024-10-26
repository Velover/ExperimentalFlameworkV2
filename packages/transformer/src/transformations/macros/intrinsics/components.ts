import type ts from "typescript";
import { f } from "../../../util/factory";
import { updateComponentConfig } from "../updateComponentConfig";
import type { TransformState } from "../../../classes/transformState";

export function transformComponentConfig(
	state: TransformState,
	declaration: ts.ClassDeclaration,
	signature: ts.Signature,
	parameters: ts.Symbol[],
	args: ts.Expression[],
) {
	for (const parameter of parameters) {
		const parameterIndex = signature.parameters.findIndex((v) => v.valueDeclaration?.symbol === parameter);
		const argument = args[parameterIndex];
		const baseConfig = f.is.object(argument) ? argument : f.object([]);
		const componentConfig = updateComponentConfig(state, declaration, [...baseConfig.properties]);
		args[parameterIndex] = f.update.object(
			baseConfig,
			componentConfig.map((v) => (baseConfig.properties.includes(v) ? state.transformNode(v) : v)),
		);
	}
}
