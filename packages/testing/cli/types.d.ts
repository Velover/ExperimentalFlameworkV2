// The Luau the CLI submits or runs is kept as files, imported as text. They are not `.luau`
// because a game's Rojo project syncs `node_modules/@flamework-experimental` into the place, and
// Rojo would make a ModuleScript of every `.luau` it found here.
declare module "*.lune" {
	const text: string;
	export default text;
}
