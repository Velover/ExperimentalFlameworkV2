import { Reflect } from "../reflect";

export function getClassImplements(constructor: object) {
	const classImplements = new Array<string>();

	for (const implementList of Reflect.getMetadatas<string[]>(constructor, "flamework:implements")) {
		for (const implementId of implementList) {
			classImplements.push(implementId);
		}
	}

	return classImplements;
}
