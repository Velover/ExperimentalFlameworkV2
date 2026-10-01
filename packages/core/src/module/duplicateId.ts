import type { ModuleProvider } from "./moduleDefinition";
import { getProviderClassScope } from "./providerRegistration";
import { getActiveScopes, listConditions } from "./scopes";

/**
 * Where a registration came from. Recorded once, as the registration is made, and read only by the
 * error two registrations under one id raise.
 */
export interface RegistrationSource {
	/**
	 * The call that made it: `registerClassProvider`, `registerProvider` or `provideInstance`, or,
	 * for a class a folder registration found, that registration as written:
	 * `registerProviders("src/server/services")`.
	 */
	readonly call: string;

	/** Who made it: `the module builder`, or `plugin 'Name'`. */
	readonly origin: string;

	/**
	 * The line that made it, as `script:line`: the first frame that is not core's own. Absent when
	 * core made the registration itself, or the stack did not say.
	 */
	readonly site?: string;
}

/** The origin of what the module builder registers. */
export const BUILDER_ORIGIN = "the module builder";

/** One side of a collision: a registration the module judged, or an object a plugin provided. */
export type Registration =
	| { readonly kind: "registration"; readonly provider: ModuleProvider }
	| { readonly kind: "instance"; readonly value: unknown; readonly source?: RegistrationSource };

const BASE_CALLS = new Set(["registerClassProvider", "registerProvider", "provideInstance"]);

/** `@rbxts/compiler-types` declares the built-in generics: `Set`, `Map`, `Array`, `Promise`, ... */
const COMPILER_TYPES = "@rbxts/compiler-types:";

/**
 * The type name an id carries: `Set` in `@rbxts/compiler-types:types/Set@Set`, `Shop` in a short
 * or tiny id's `Shop{a1b2}`. Nothing for an obfuscated id, or one given by hand.
 */
function typeNameOf(id: string): string | undefined {
	const [full] = id.match("^[^:]+:.+@([%w_]+)$");
	if (typeIs(full, "string")) return full;

	const [short] = id.match("([%w_]+){[^{}]*}$");
	return typeIs(short, "string") ? short : undefined;
}

/** A roblox-ts class is its instances' metatable, and its own metatable names it. */
function classNameOf(value: object): string | undefined {
	const [ok, name] = pcall(() => {
		const metatable = getmetatable(value);
		return typeIs(metatable, "table") ? tostring(metatable) : undefined;
	});

	if (ok && typeIs(name, "string") && name.find("^table: ")[0] === undefined) {
		return name;
	}
}

function describeValue(value: unknown): string {
	if (typeIs(value, "Instance")) {
		return `${value.ClassName} ${value.GetFullName()}`;
	}

	if (typeIs(value, "table")) {
		return classNameOf(value) ?? "table";
	}

	return typeOf(value);
}

function sourceOf(registration: Registration) {
	return registration.kind === "registration" ? registration.provider.source : registration.source;
}

/** The class a registration constructs, when it is a class registration. */
function classOf(registration: Registration): object | undefined {
	if (registration.kind === "registration" && registration.provider.config.type === "class") {
		return registration.provider.config.value;
	}
}

/** The folder registration that found it, as written, when one did. */
function folderOf(registration: Registration): string | undefined {
	const source = sourceOf(registration);
	if (source !== undefined && !BASE_CALLS.has(source.call)) {
		return source.call;
	}
}

/** The scope conditions of its own it was kept under: the registration's and its class's. */
function conditionsOf(registration: Registration): string[] {
	if (registration.kind === "instance") {
		return [];
	}

	const { config } = registration.provider;
	return listConditions([config, getProviderClassScope(config)]);
}

function describeKind(registration: Registration): string {
	if (registration.kind === "instance") {
		return `provideInstance(value: ${describeValue(registration.value)})`;
	}

	const { config, source } = registration.provider;
	if (config.type === "class") {
		const name = tostring(config.value);
		if (source === undefined) return `class provider ${name}`;
		if (source.call === "registerClassProvider") return `registerClassProvider(${name})`;
		if (source.call === "registerProvider") return `registerProvider({ type: "class", value: ${name} })`;
		return `class ${name}, found by ${source.call}`;
	}

	if (config.type === "function") {
		return `registerProvider({ type: "function" })`;
	}

	return `registerProvider({ type: "alias", injectionId: "${config.injectionId}" })`;
}

function describeRegistration(registration: Registration | undefined): string {
	if (registration === undefined) {
		return "(not recorded)";
	}

	let text = describeKind(registration);

	const source = sourceOf(registration);
	if (source !== undefined) {
		text += ` from ${source.origin}`;
		if (source.site !== undefined) {
			text += `, at ${source.site}`;
		}
	}

	const conditions = conditionsOf(registration);
	if (!conditions.isEmpty()) {
		text += `, scoped ${conditions.join("; ")}`;
	}

	return text;
}

const OWN_ID =
	'an id of its own, given as a string (provideInstance(value, "my-id"), registerProvider(config, "my-id")) ' +
	'and resolved by it (module.resolveDependency<T>("my-id"))';

/** The hint for an id of `@rbxts/compiler-types`: a built-in generic, whose instantiations all share it. */
function genericHint(id: string): string {
	const name = typeNameOf(id) ?? "the type";
	return (
		`${name} is generic, and an id names a type's declaration, not its type arguments: ` +
		`${name}<A> and ${name}<B> both get this one, ${name}'s id in @rbxts/compiler-types. ` +
		`Give one of them a type of its own -- an interface (interface My${name} extends ${name}<...> {}), ` +
		`provided and injected as that type, or a class that holds the value -- or ${OWN_ID}. ` +
		`A type alias is not a type of its own: it still names ${name}.`
	);
}

/** The hint for two class registrations. */
function classHint(first: Registration, second: Registration, firstClass: object, secondClass: object): string {
	if (firstClass !== secondClass) {
		return (
			"two classes are registered under one id. To stand one in for the other (a fake for a real provider), " +
			"give them scope conditions that keep at most one in any build (activeIn / inactiveIn), " +
			"or register the stand-in in a module that imports the one with the real provider; otherwise keep one."
		);
	}

	const firstFolder = folderOf(first);
	const secondFolder = folderOf(second);
	if (firstFolder !== undefined && secondFolder !== undefined) {
		return firstFolder === secondFolder
			? `${firstFolder} is made twice, and registers the class each time: keep one of the two.`
			: `the class is under both folders, so ${firstFolder} and ${secondFolder} overlap: ` +
					"register the outer folder alone, or move the class out of one of them.";
	}

	const folder = firstFolder ?? secondFolder;
	if (folder !== undefined) {
		return (
			`the class is under ${folder}, which registers it already: ` +
			"drop the other registration, or move the class out of that folder."
		);
	}

	return "the same class is registered twice: keep one of the two registrations.";
}

/** The hint for two registrations of which one at least is not a class: a value, a function, an alias. */
function valueHint(id: string, first: Registration | undefined, second: Registration): string {
	const instances = (first?.kind === "instance" ? 1 : 0) + (second.kind === "instance" ? 1 : 0);
	const opening =
		instances === 2
			? "the id is provided twice: provide one value under it"
			: instances === 1
				? "the id is both provided and registered: keep one"
				: "two registrations claim the id: keep one";

	// The id came from a type argument, or was given by hand, and a type argument may be a generic's.
	const name = typeNameOf(id);
	const generic =
		name !== undefined
			? `If ${name} is generic, note that type arguments are not part of an id: ${name}<A> and ${name}<B> share this one.`
			: "If the id's type is generic, note that type arguments are not part of an id: Box<A> and Box<B> share one.";

	return `${opening}, or, to keep both, give one of them ${OWN_ID}. ${generic}`;
}

function hintFor(id: string, first: Registration | undefined, second: Registration): string {
	let hint: string;
	if (id.sub(1, COMPILER_TYPES.size()) === COMPILER_TYPES) {
		hint = genericHint(id);
	} else {
		const firstClass = first !== undefined ? classOf(first) : undefined;
		const secondClass = classOf(second);
		hint =
			first !== undefined && firstClass !== undefined && secondClass !== undefined
				? classHint(first, second, firstClass, secondClass)
				: valueHint(id, first, second);
	}

	if ((first !== undefined && !conditionsOf(first).isEmpty()) || !conditionsOf(second).isEmpty()) {
		hint +=
			` Both are kept in this build (active scopes [${getActiveScopes().join(", ")}]): ` +
			"two registrations may share an id only when their scope conditions keep at most one of them.";
	}

	return hint;
}

/**
 * The error two registrations under one id raise: the id and the module, then each registration --
 * what it is, who made it and the line that did -- and what to do about it. `first` is the one
 * that held the id when `second` was judged.
 */
export function duplicateIdMessage(
	debugName: string,
	id: string,
	first: Registration | undefined,
	second: Registration,
): string {
	return [
		`module '${debugName}': provider ID was registered more than once: ${id}`,
		`  first:  ${describeRegistration(first)}`,
		`  second: ${describeRegistration(second)}`,
		`  hint: ${hintFor(id, first, second)}`,
	].join("\n");
}
