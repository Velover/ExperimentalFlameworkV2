import type { Modding } from "../modding";

const cachedDependencyInfo = new Map<string, Modding.DependencyInfo>();

/**
 * Converts concise dependency info into `Modding.DependencyInfo`
 */
export function convertConciseDependencyInfo(dependency?: string | Modding.DependencyInfo) {
	assert(dependency !== undefined);

	if (typeIs(dependency, "string")) {
		let metadata = cachedDependencyInfo.get(dependency);
		if (!metadata) {
			cachedDependencyInfo.set(dependency, (metadata = { id: dependency }));
		}

		return metadata;
	}

	return dependency;
}
