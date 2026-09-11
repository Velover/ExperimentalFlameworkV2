// The transformer ships no declaration files on purpose: a game's tsconfig lists the scope in its
// typeRoots, and TypeScript would pull a declared transformer, `typescript` types and all, into
// every place's program. This is the one function and the one shape the CLI uses from it.
declare module "@flamework-experimental/transformer/out/util/projectConfig.js" {
	export interface CloudConfig {
		universeId?: string;
		placeId?: string;
		apiKey?: string;
	}

	export interface LoadedProjectConfig {
		project: { cloud?: CloudConfig };
		configPath?: string;
		env: Record<string, string>;
	}

	/**
	 * Finds flamework.config.json from `projectDirectory` up to `rootDirectory`, substitutes its
	 * `${NAME}` references from `.env`, `.env.local` and `processEnv`, validates it, and returns it.
	 */
	export function loadProjectConfig(
		projectDirectory: string,
		rootDirectory: string,
		inlineConfig: { configFile?: string },
		processEnv?: Record<string, string>,
	): LoadedProjectConfig;
}
