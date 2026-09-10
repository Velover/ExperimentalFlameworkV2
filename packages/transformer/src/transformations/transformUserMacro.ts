import { v5 as uuidv5 } from "uuid";
import ts from "typescript";
import { Diagnostics } from "../classes/diagnostics";
import { TransformState } from "../classes/transformState";
import { f } from "../util/factory";
import { buildGuardFromTypeWithDedup } from "../util/functions/buildGuardFromType";
import { getTypeUid } from "../util/uid";
import { NodeMetadata } from "../classes/nodeMetadata";
import { buildPathGlobIntrinsic, buildPathIntrinsic } from "./macros/intrinsics/paths";
import { validateParameterConstIntrinsic } from "./macros/intrinsics/parameters";
import {
	transformNetworkingMiddlewareIntrinsic,
	transformObfuscatedObjectIntrinsic,
	transformShuffleArrayIntrinsic,
} from "./macros/intrinsics/networking";
import { buildTupleGuardsIntrinsic } from "./macros/intrinsics/guards";
import {
	buildDecoderFromType,
	buildResultDecoderFromType,
	buildSerializerFromType,
} from "../util/functions/buildSerializerFromType";
import { isTupleType } from "../util/functions/isTupleType";
import { inlineMacroIntrinsic } from "./macros/intrinsics/inlining";
import { addLeadingComment } from "../util/functions/addLeadingComment";
import { transformComponentConfig } from "./macros/intrinsics/components";

export function transformUserMacro(
	state: TransformState,
	node: ts.NewExpression | ts.CallExpression,
	signature: ts.Signature,
): ts.Expression | undefined {
	const signatureDeclaration = signature.getDeclaration();
	const nodeMetadata = NodeMetadata.fromCache(state, signatureDeclaration);
	const args = node.arguments ? [...node.arguments] : [];
	const parameters = new Map<number, UserMacro>();

	let highestParameterIndex = -1;
	for (let i = 0; i < getParameterCount(state, signature); i++) {
		// This parameter is passed explicitly, so we don't need to evaluate it.
		if (!isUndefinedArgument(args[i])) {
			continue;
		}

		const targetParameter = state.typeChecker.getParameterType(signature, i).getNonNullableType();
		const userMacro = getUserMacroOfUnion(state, node, targetParameter);
		if (userMacro) {
			parameters.set(i, userMacro);
			highestParameterIndex = Math.max(highestParameterIndex, i);
		}
	}

	// Every argument has to be visited, not just the ones up to the last generated parameter:
	// arguments beyond it can contain macros of their own, and leaving them untransformed emits a
	// call to a `declare`d function that only fails at runtime. `highestParameterIndex` still
	// determines how far to pad with `nil` so that a generated parameter lands at the right index.
	const argumentCount = Math.max(args.length, highestParameterIndex + 1);
	for (let i = 0; i < argumentCount; i++) {
		const userMacro = parameters.get(i);
		if (userMacro) {
			args[i] = buildUserMacro(state, node, userMacro);
		} else {
			args[i] = args[i] ? state.transform(args[i]) : f.nil();
		}
	}

	const networkingMiddleware = nodeMetadata.getSymbol("intrinsic-middleware");
	if (networkingMiddleware) {
		transformNetworkingMiddlewareIntrinsic(state, signature, args, networkingMiddleware);
	}

	const componentConfigs = nodeMetadata.getSymbol("intrinsic-component-config");
	if (componentConfigs) {
		const decoratorParent = ts.findAncestor(node, ts.isDecorator);
		if (decoratorParent && f.is.classDeclaration(decoratorParent.parent)) {
			transformComponentConfig(state, decoratorParent.parent, signature, componentConfigs, args);
		}
	}

	const inlineIntrinsic = nodeMetadata.getSymbol("intrinsic-inline");
	if (inlineIntrinsic && inlineIntrinsic.length === 1) {
		return inlineMacroIntrinsic(signature, args, inlineIntrinsic[0]);
	}

	validateParameterConstIntrinsic(node, signature, nodeMetadata.getSymbol("intrinsic-const") ?? []);

	// `intrinsic-flamework-rewrite` redirects the call to a real implementation, which is how a
	// `declare`d macro such as `Flamework.implements` reaches `Flamework._implements` at runtime.
	// Without it the emitted call targets a declaration that has no runtime value.
	let callee: ts.Expression | undefined;

	const rewrite = nodeMetadata.getSymbol("intrinsic-flamework-rewrite")?.[0];
	if (rewrite) {
		if (!rewrite.parent) {
			Diagnostics.error(node, `The rewrite target '${rewrite.name}' is not declared inside a namespace.`);
		}

		const namespace = state.addFileImport(state.getSourceFile(node), "@flamework/core", rewrite.parent.name);
		callee = f.elementAccessExpression(namespace, rewrite.name);
	}

	callee ??= state.transformNode(node.expression);

	if (ts.isNewExpression(node)) {
		return ts.factory.updateNewExpression(node, callee, node.typeArguments, args);
	} else if (ts.isCallExpression(node)) {
		return ts.factory.updateCallExpression(node, callee, node.typeArguments, args);
	} else {
		Diagnostics.error(node, `Macro could not be transformed.`);
	}
}

export function getDependencyInjectionMetadata(state: TransformState, node: ts.Node, type: ts.Type, concise = false) {
	const id = getTypeUid(state, type, node);
	const metadata = getInjectableMetadata(state, type)?.map((v) => {
		return transformUserMacroType(state, node, v);
	});

	if (concise && !metadata) {
		return f.string(id);
	} else {
		const object = {} as Record<string, f.ConvertableExpression>;
		object.id = id;
		if (metadata) {
			object.metadata = metadata ? f.array(metadata) : undefined!;
		}
		return f.object(object);
	}
}

function getInjectableMetadata(state: TransformState, type: ts.Type) {
	const injectableConfig = state.typeChecker.getTypeOfPropertyOfType(type, "_flamework_injectable");
	if (injectableConfig) {
		const reflect = state.typeChecker.getTypeOfPropertyOfType(injectableConfig, "metadata");
		if (reflect && isTupleType(state, reflect)) {
			return reflect.typeArguments;
		}
	}
}

function transformUserMacroType(state: TransformState, node: ts.Node, type: ts.Type) {
	const macro = getUserMacroOfMany(state, node, type);
	return buildUserMacro(state, node, macro);
}

function isUndefinedArgument(argument: ts.Node | undefined) {
	return argument ? f.is.identifier(argument) && argument.text === "undefined" : true;
}

function getLabels(state: TransformState, type: ts.Type): UserMacro {
	if (!isTupleType(state, type)) {
		return {
			kind: "literal",
			value: undefined,
		};
	}

	const names = new Array<UserMacro>();
	const declarations = type.target.labeledElementDeclarations;

	if (!declarations) {
		return {
			kind: "literal",
			value: undefined,
		};
	}

	for (const namedMember of declarations) {
		// TypeScript 5.0+ allows nameless tuple elements, so we'll default to an empty string in that case.
		names.push({
			kind: "literal",
			value: namedMember ? (namedMember.name as ts.Identifier).text : "",
		});
	}

	return {
		kind: "many",
		members: names,
	};
}

function buildUserMacro(state: TransformState, node: ts.Node, macro: UserMacro): ts.AsExpression {
	if (macro.kind === "generic") {
		const metadata = getGenericMetadata(macro);
		if (metadata) {
			return f.asNever(metadata);
		}
	} else if (macro.kind === "caller") {
		const metadata = getCallerMetadata(macro);
		if (metadata) {
			return f.asNever(metadata);
		}
	} else if (macro.kind === "many") {
		if (Array.isArray(macro.members)) {
			return f.asNever(f.array(macro.members.map((userMacro) => buildUserMacro(state, node, userMacro))));
		} else {
			const elements = new Array<ts.ObjectLiteralElementLike>();

			for (const [name, userMacro] of macro.members) {
				const expression = buildUserMacro(state, node, userMacro);
				if (f.is.nil(expression.expression)) {
					continue;
				}

				elements.push(f.propertyAssignmentDeclaration(f.string(name), expression));
			}

			return f.asNever(f.object(elements, false));
		}
	} else if (macro.kind === "literal") {
		const value = macro.value;
		return f.asNever(
			typeof value === "string"
				? f.string(value)
				: typeof value === "number"
					? f.number(value)
					: typeof value === "boolean"
						? f.bool(value)
						: f.nil(),
		);
	} else if (macro.kind === "intrinsic") {
		return f.asNever(buildIntrinsicMacro(state, node, macro));
	} else if (macro.kind === "sharedRef") {
		const result = buildUserMacro(state, node, macro.value);
		if (ts.isSimpleInlineableExpression(result.expression)) {
			return result;
		}

		const nextStatement = ts.findAncestor(node, f.is.statement);
		if (nextStatement && f.is.file(nextStatement.parent)) {
			// We are already at the next root, so we don't need to create temporaries.
			return result;
		}

		const line = ts.getLineOfLocalPosition(node.getSourceFile(), node.getStart());
		const uniqueName = f.identifier(`${getNodeDebugName(state, node)}_${line + 1}`, true);
		const comment = ts.factory.createEmptyStatement();
		const variable = f.variableStatement(uniqueName, result);

		addLeadingComment(comment, ` Flamework hoisted this macro's metadata (${uniqueName.text}) to the file root.`);
		addLeadingComment(variable, ` Flamework user macro metadata (line ${line + 1})`);

		state.nextRootStatements.push(variable);
		state.prereq(comment);

		return f.asNever(uniqueName);
	}

	return f.asNever(f.nil());

	function getGenericMetadata(macro: UserMacro & { kind: "generic" }) {
		if (macro.metadata === "id") {
			return f.string(getTypeUid(state, macro.target, node));
		}

		if (macro.metadata === "guard") {
			const result = buildGuardFromTypeWithDedup(state, node, macro.target);
			state.prereqList(result.statements);

			return result.guard;
		}

		if (macro.metadata === "text") {
			return f.string(state.typeChecker.typeToString(macro.target));
		}

		if (macro.metadata === "dependency" || macro.metadata === "dependencyConcise") {
			return getDependencyInjectionMetadata(state, node, macro.target, macro.metadata === "dependencyConcise");
		}
	}

	function getCallerMetadata(macro: UserMacro & { kind: "caller" }) {
		const lineAndCharacter = ts.getLineAndCharacterOfPosition(node.getSourceFile(), node.getStart());

		if (macro.metadata === "line") {
			return f.number(lineAndCharacter.line + 1);
		}

		if (macro.metadata === "character") {
			return f.number(lineAndCharacter.character + 1);
		}

		if (macro.metadata === "width") {
			return f.number(node.getWidth());
		}

		if (macro.metadata === "uuid") {
			return f.string(getCallsiteUuid(state, node));
		}

		if (macro.metadata === "text") {
			return f.string(node.getText());
		}
	}
}

function buildIntrinsicMacro(state: TransformState, node: ts.Node, macro: UserMacro & { kind: "intrinsic" }) {
	if (macro.id === "pathglob") {
		const [pathType] = macro.inputs;
		if (!pathType) {
			throw new Error(`Invalid intrinsic usage`);
		}

		return buildPathGlobIntrinsic(state, node, pathType);
	}

	if (macro.id === "path") {
		const [pathType] = macro.inputs;
		if (!pathType) {
			throw new Error(`Invalid intrinsic usage`);
		}

		return buildPathIntrinsic(state, node, pathType);
	}

	if (macro.id === "obfuscate-obj") {
		const [macroType, hashType] = macro.inputs;
		if (!macroType || !hashType) {
			throw new Error(`Invalid intrinsic usage`);
		}

		const innerMacro = getUserMacroOfMany(state, node, macroType);
		if (!innerMacro) {
			throw new Error(`Intrinsic obfuscate-obj received no inner macro.`);
		}

		transformObfuscatedObjectIntrinsic(state, innerMacro, hashType);

		return buildUserMacro(state, node, innerMacro);
	}

	if (macro.id === "shuffle-array") {
		const [macroType] = macro.inputs;
		if (!macroType) {
			throw new Error(`Invalid intrinsic usage`);
		}

		const innerMacro = getUserMacroOfMany(state, node, macroType);
		if (!innerMacro) {
			throw new Error(`Intrinsic obfuscate-obj received no inner macro.`);
		}

		transformShuffleArrayIntrinsic(state, innerMacro);

		return buildUserMacro(state, node, innerMacro);
	}

	if (macro.id === "tuple-guards") {
		const [tupleType] = macro.inputs;
		if (!tupleType) {
			throw new Error(`Invalid intrinsic usage`);
		}

		return buildTupleGuardsIntrinsic(state, node, tupleType);
	}

	if (macro.id === "serializer") {
		const [type] = macro.inputs;
		if (!type) {
			throw new Error(`Invalid intrinsic usage`);
		}

		return buildSerializerFromType(state, node, type);
	}

	// Networking metadata: the decoder for an argument list (or, given a function type, for its
	// result), only built when the project enables serialization so it costs nothing otherwise. `nil`
	// tells the runtime to pass values through. The matching encoding is generated at each call site
	// (see transformNetworkingCall).
	if (macro.id === "network-decoder" || macro.id === "network-result-decoder") {
		const [type] = macro.inputs;
		if (!type) {
			throw new Error(`Invalid intrinsic usage`);
		}

		if (state.projectConfig.networking?.serialization !== true) {
			return f.nil();
		}

		return macro.id === "network-decoder"
			? buildDecoderFromType(state, node, type)
			: buildResultDecoderFromType(state, node, type);
	}

	if (macro.id === "plugin") {
		const [pluginName, input] = macro.inputs;
		if (!pluginName || !pluginName.isStringLiteral() || !input) {
			Diagnostics.error(
				node,
				'A plugin macro must be declared as `Modding.Intrinsic<"plugin", [id, T], R>` where `id` is a string literal.',
			);
		}

		if (!state.pluginHost) {
			Diagnostics.error(
				node,
				`The macro type '${pluginName.value}' requires a plugin, but no plugins are configured.`,
				"Add the plugin to the `plugins` array of the Flamework transformer options in your tsconfig.json.",
			);
		}

		const transform = state.pluginHost.executeMacroType(pluginName.value, input, node);
		if (!transform) {
			const registered = state.pluginHost.getRegisteredMacroTypes();
			Diagnostics.error(
				node,
				`No loaded plugin registered the macro type '${pluginName.value}'.`,
				registered.length > 0
					? `Registered macro types: ${registered.join(", ")}`
					: "No plugin registered any macro types.",
			);
		}

		return transform;
	}

	throw `Unexpected intrinsic ID '${macro.id}' with ${macro.inputs.length} inputs`;
}

function getMetadataFromType(metadataType: ts.Type) {
	if (metadataType.isStringLiteral()) {
		return metadataType.value;
	}
}

function getUserMacroOfMany(state: TransformState, node: ts.Node, target: ts.Type): UserMacro {
	const sharedRefMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_shared_ref");

	// A basic macro is a constant already, so `Constant` around it changes nothing and the value
	// stays inline.
	const basicUserMacro = getBasicUserMacro(state, node, target);
	if (basicUserMacro) {
		return basicUserMacro;
	}

	// `Constant<Emit<T>>` carries both markers; the shared-ref one has to win or the `Constant` is
	// dropped and the table is rebuilt on every call.
	if (sharedRefMetadata) {
		return {
			kind: "sharedRef",
			type: sharedRefMetadata,
			value: getUserMacroOfMany(state, node, sharedRefMetadata),
		};
	}

	const manyMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_many");
	if (manyMetadata) {
		return getUserMacroOfMany(state, node, manyMetadata);
	}

	if (isTupleType(state, target)) {
		const userMacros = new Array<UserMacro>();

		for (const member of state.typeChecker.getTypeArguments(target)) {
			const userMacro = getUserMacroOfMany(state, node, member);

			userMacros.push(userMacro);
		}

		return {
			kind: "many",
			members: userMacros,
		};
	} else if (state.typeChecker.isArrayType(target)) {
		const targetType = state.typeChecker.getTypeArguments(target as ts.TypeReference)[0];
		const constituents = targetType.isUnion() ? targetType.types : [targetType];
		const userMacros = new Array<UserMacro>();

		for (const member of constituents) {
			// `never` may be encountered when a union has no constituents, so we should just return an empty array.
			if (member.flags & ts.TypeFlags.Never) {
				break;
			}

			const userMacro = getUserMacroOfMany(state, node, member);
			userMacros.push(userMacro);
		}

		return {
			kind: "many",
			members: userMacros,
		};
	} else if (isObjectType(target)) {
		const userMacros = new Map<string, UserMacro>();

		for (const member of target.getProperties()) {
			const memberType = state.typeChecker.getTypeOfPropertyOfType(target, member.name);
			if (!memberType) continue;

			const userMacro = getUserMacroOfMany(state, node, memberType);
			userMacros.set(member.name, userMacro);
		}

		return {
			kind: "many",
			members: userMacros,
		};
	} else if (target.isStringLiteral() || target.isNumberLiteral()) {
		return {
			kind: "literal",
			value: target.value,
		};
	} else if (target.flags & ts.TypeFlags.Undefined) {
		return {
			kind: "literal",
			value: undefined,
		};
	} else if (target.flags & ts.TypeFlags.BooleanLiteral) {
		return {
			kind: "literal",
			value: (target as ts.FreshableType).regularType === state.typeChecker.getTrueType() ? true : false,
		};
	}

	Diagnostics.error(node, `Unknown type '${target.checker.typeToString(target)}' encountered`);
}

function getBasicUserMacro(state: TransformState, node: ts.Node, target: ts.Type): UserMacro | undefined {
	const genericMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_generic");
	if (genericMetadata) {
		const targetType = state.typeChecker.getTypeOfPropertyOfType(genericMetadata, "0");
		const metadataType = state.typeChecker.getTypeOfPropertyOfType(genericMetadata, "1");
		if (!targetType) return;
		if (!metadataType) return;

		const metadata = getMetadataFromType(metadataType);
		if (!metadata) {
			Diagnostics.error(
				node,
				`Flamework encountered invalid metadata: '${state.typeChecker.typeToString(metadataType)}'`,
			);
		}

		return {
			kind: "generic",
			target: targetType,
			metadata,
		};
	}

	const callerMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_caller");
	if (callerMetadata) {
		const metadata = getMetadataFromType(callerMetadata);
		if (!metadata) return;

		return {
			kind: "caller",
			metadata,
		};
	}

	const hashMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_hash");
	if (hashMetadata) {
		const text = state.typeChecker.getTypeOfPropertyOfType(hashMetadata, "0");
		const context = state.typeChecker.getTypeOfPropertyOfType(hashMetadata, "1");
		const isObfuscation = state.typeChecker.getTypeOfPropertyOfType(hashMetadata, "2");
		if (!text || !text.isStringLiteral()) return;
		if (!context) return;

		const contextName = context.isStringLiteral() ? context.value : "@";
		return {
			kind: "literal",
			value: isObfuscation
				? state.obfuscateText(text.value, contextName)
				: state.buildInfo.hashString(text.value, contextName),
		};
	}

	const nonNullableTarget = target.getNonNullableType();
	const labelMetadata = state.typeChecker.getTypeOfPropertyOfType(nonNullableTarget, "_flamework_macro_tuple_labels");
	if (labelMetadata) {
		return getLabels(state, labelMetadata);
	}

	const intrinsicMetadata = state.typeChecker.getTypeOfPropertyOfType(nonNullableTarget, "_flamework_intrinsic");
	if (intrinsicMetadata) {
		if (isTupleType(state, intrinsicMetadata) && intrinsicMetadata.typeArguments) {
			const [id, ...inputs] = intrinsicMetadata.typeArguments;
			if (!id || !id.isStringLiteral()) return;

			return {
				kind: "intrinsic",
				id: id.value,
				inputs,
			};
		}
	}
}

function getUserMacroOfType(state: TransformState, node: ts.Expression, target: ts.Type): UserMacro | undefined {
	// The shared-ref marker is only inspected on the way through `getUserMacroOfMany`, so without
	// this a `Modding.Caller.Constant<T>` parameter that is not wrapped in `Modding.Emit` generates
	// no argument at all -- the macro silently does not fire and the parameter is nil at runtime.
	// It is checked ahead of the `Emit` marker because `Constant<Emit<T>>` carries both, and finding
	// `Emit` first silently dropped the `Constant`.
	if (state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_shared_ref")) {
		return getUserMacroOfMany(state, node, target);
	}

	const manyMetadata = state.typeChecker.getTypeOfPropertyOfType(target, "_flamework_macro_many");
	if (manyMetadata) {
		return getUserMacroOfMany(state, node, manyMetadata);
	}

	return getBasicUserMacro(state, node, target);
}

/**
 * This allows user macros to specify signatures that can accept non-metadata, like in Flamework components.
 * Multiple modding types in a single parameter aren't supported, and Flamework will choose a random one.
 *
 * For example, `string | Modding.Target.Id<T>`, will generate the ID for `T`, but also allow users to pass in one manually.
 */
function getUserMacroOfUnion(state: TransformState, node: ts.Expression, target: ts.Type) {
	if (!target.isUnion()) {
		return getUserMacroOfType(state, node, target);
	}

	for (const constituent of target.types) {
		const macro = getUserMacroOfType(state, node, constituent);
		if (macro) {
			return macro;
		}
	}
}

function isObjectType(type: ts.Type): boolean {
	return type.isIntersection() ? type.types.every(isObjectType) : (type.flags & ts.TypeFlags.Object) !== 0;
}

function getParameterCount(state: TransformState, signature: ts.Signature) {
	const length = signature.parameters.length;
	if (ts.signatureHasRestParameter(signature)) {
		const restType = state.typeChecker.getTypeOfSymbol(signature.parameters[length - 1]);
		if (isTupleType(state, restType)) {
			return length + restType.target.fixedLength - (restType.target.hasRestElement ? 0 : 1);
		}
	}
	return length;
}

/** Namespace for the callsite uuids; any fixed uuid works, it only has to never change. */
const CALLSITE_UUID_NAMESPACE = "6f4c1d2e-8b3a-4e5f-9c7d-2a1b0e9f8d7c";

/**
 * A uuid that is unique per callsite and identical across compilations.
 *
 * It is derived from the package, the file, the enclosing declaration and the offset within it, so
 * two builds of the same source emit the same value and a game's output is reproducible. A random
 * uuid per compile would rename every remote folder on every build.
 */
function getCallsiteUuid(state: TransformState, node: ts.Node) {
	const file = state.getSourceFile(node);
	const declaration = ts.findAncestor(node, isCallsiteScope);
	const declarationName = declaration?.name && f.is.identifier(declaration.name) ? declaration.name.text : "";
	const offset = declaration ? node.getStart() - declaration.getStart() : node.getStart();
	const key = `${state.packageName}:${state.getFileId(file)}@${declarationName}+${offset}`;

	return uuidv5(key, CALLSITE_UUID_NAMESPACE);
}

/**
 * The declarations a callsite id is anchored to: the units a user names and moves around as one.
 *
 * TypeScript's own `isNamedDeclaration` accepts anything with a `name` property, which includes the
 * property access in `callsite().uuid`, so it cannot be used here.
 */
function isCallsiteScope(node: ts.Node): node is ts.NamedDeclaration {
	return (
		ts.isVariableDeclaration(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isPropertyDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

function getNodeDebugName(state: TransformState, node: ts.Node) {
	if (f.is.call(node)) {
		const symbol = state.getSymbol(node.expression);
		if (symbol) {
			return symbol.name;
		}
	}

	return `macro`;
}

export type UserMacro =
	| {
			kind: "generic";
			target: ts.Type;
			metadata: string;
	  }
	| {
			kind: "caller";
			metadata: string;
	  }
	| {
			kind: "many";
			members: Map<string, UserMacro> | Array<UserMacro>;
	  }
	| {
			kind: "literal";
			value: string | number | boolean | undefined;
	  }
	| {
			kind: "intrinsic";
			id: string;
			inputs: ts.Type[];
	  }
	| {
			kind: "sharedRef";
			type: ts.Type;
			value: UserMacro;
	  };
