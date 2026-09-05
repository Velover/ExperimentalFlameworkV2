/**
 * Finds a metadata module written by the transformer (`include/flamework/<name>.json`) by walking up
 * from this script until a `flamework` folder with the requested child is found. The include
 * directory is an ancestor of every Flamework package in a roblox-ts project, which is what makes
 * this work; Rojo turns the JSON file into a ModuleScript returning its table.
 */
export function findMetadataContainer<T>(name: string): T | undefined {
	// Outside a real place (the Lune harness) `script` is a plain table: there is no tree to walk.
	if (!typeIs(script, "Instance")) return undefined;

	let current: Instance | undefined = script;
	while (current) {
		const flamework = current.FindFirstChild("flamework");
		if (flamework) {
			const metadata = flamework.FindFirstChild(name);
			if (metadata && metadata.IsA("ModuleScript")) {
				return require(metadata) as T;
			}
		}

		current = current.Parent;
	}
}
