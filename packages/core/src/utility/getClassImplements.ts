import { Reflect } from "../reflect";

/**
 * The interfaces a class implements, own and inherited, each once: the transformer writes every
 * class's own heritage clause, so a subclass that re-declares an interface its parent implements
 * carries the id twice up the chain, and attached to it twice -- the lifecycle's ordered lists ran
 * `onInit` and `onStart` twice for it.
 */
export function getClassImplements(constructor: object) {
	const classImplements = new Array<string>();
	const seen = new Set<string>();

	for (const implementList of Reflect.getMetadatas<string[]>(constructor, "flamework:implements")) {
		for (const implementId of implementList) {
			if (!seen.has(implementId)) {
				seen.add(implementId);
				classImplements.push(implementId);
			}
		}
	}

	return classImplements;
}
