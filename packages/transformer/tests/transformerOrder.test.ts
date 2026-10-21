import { afterAll, describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import ts from "typescript";
import { compileProbes } from "./compile";

/*
 * A transformer listed before Flamework's in tsconfig `plugins` hands Flamework the statements it
 * rewrote (`factory.update*`, as a transformer rewriting code that uses a service does), and those
 * have no `parent`. Flamework placed what a statement hoists to file level (the serializer's
 * helpers, guards, macro metadata) only ahead of a statement whose parent is the file, so a rewritten
 * provider class that was the file's last statement lost its helpers (TS2304 "Cannot find name
 * 'vsize'"), and one followed by another statement got them after itself.
 *
 * The fixture's `rewriteFirstPlugin.cjs` is that transformer; it rewrites only the files named
 * `rewriteFirst*` here, so the rest of the fixture emits as it always does.
 */

const FIXTURE = path.resolve(import.meta.dir, "fixture");
const PROBE_CONFIG = path.join(FIXTURE, "tsconfig.rewrite-probe.json");

const plain = (output: string) => output.replace(/\x1b\[[0-9;]*m/g, "");

/** A provider whose method sends a serialized event: the serializer's helpers are hoisted for it. */
function provider(name: string, after = "") {
	return `import { Provider } from "@flamework-experimental/core";
import { Networking } from "@flamework-experimental/networking";

interface ${name}Item {
	id: number;
	name: string;
}

interface ServerEvents {}

interface ClientEvents {
	${name}Update: Networking.Serialized<(items: ${name}Item[]) => void>;
}

const ${name}Events = Networking.createEvent<ServerEvents, ClientEvents>();
const ${name}Server = ${name}Events.createServer({});

@Provider()
export class ${name}Provider {
	update(player: Player, items: ${name}Item[]) {
		${name}Server.${name}Update.fire(player, items);
	}
}
${after}`;
}

const PROVIDERS = {
	// The class is the file's last statement: nothing after it took what it hoisted.
	rewriteFirstLast: provider("rewriteFirstLast"),
	// Another statement follows: what the class hoisted went after the class.
	rewriteFirstFollowed: provider("rewriteFirstFollowed", "\nexport const rewriteFirstAfter = 1;\n"),
};

/** A component, whose decorator's config Flamework fills in from the class it decorates. */
const COMPONENT = `import { BaseComponent, Component } from "@flamework-experimental/components";

@Component({ tag: "RewriteFirstTagged" })
export class RewriteFirstComponent extends BaseComponent<{ power: number }, BasePart> {}
`;

/** A macro that reads where it is called from, called in a statement of its own (line 8). */
const CALLER = `import { Modding } from "@flamework-experimental/core";

/** @metadata macro */
export function rewriteFirstWhere(line?: Modding.Caller.Line, text?: Modding.Caller.Text) {
	return \`\${line} \${text}\`;
}

rewriteFirstWhere();
`;

/** An error Flamework reports at a call the transformer before it rewrote (line 7, column 31). */
const ERROR = `import { BaseComponent, Component } from "@flamework-experimental/components";
import { Dependency } from "@flamework-experimental/core";

@Component({})
export class RewriteFirstQuestsUI extends BaseComponent<{}, Instance> {}

export const rewriteFirstUi = Dependency<RewriteFirstQuestsUI>();
`;

/** Compiles `sources` with `rewriteFirstPlugin.cjs` in `mode` listed before Flamework's transformer. */
function compileRewritten(mode: "classes" | "statements" | "deep", sources: Record<string, string>) {
	const { config } = ts.readConfigFile(path.join(FIXTURE, "tsconfig.json"), ts.sys.readFile);
	config.compilerOptions.plugins = [
		{ transform: "./rewriteFirstPlugin.cjs", mode, files: "rewriteFirst" },
		...config.compilerOptions.plugins,
	];
	fs.writeFileSync(PROBE_CONFIG, JSON.stringify(config, undefined, "\t"));

	try {
		const result = compileProbes(sources, {}, ["-p", PROBE_CONFIG]);
		return { ...result, output: plain(result.output) };
	} finally {
		fs.rmSync(PROBE_CONFIG, { force: true });
	}
}

function emittedFile(result: ReturnType<typeof compileRewritten>, name: string) {
	const source = result.files.get(name);
	if (source === undefined) throw new Error(`'${name}' was not emitted:\n${result.output}`);
	return source;
}

/** The serializer's helpers are declared ahead of the class that uses them, which keeps its module metadata. */
function expectHelpersAhead(result: ReturnType<typeof compileRewritten>, name: string) {
	const source = emittedFile(result, name);
	const declared = source.search(new RegExp(`^local ${name}Provider$`, "m"));

	expect(declared).toBeGreaterThan(0);
	for (const helper of ["local codec = {}", "local vsize = ", "local vwrite = ", `codec.w_${name}Item = `]) {
		const at = source.indexOf(helper);
		expect({ helper, at: at >= 0 && at < declared }).toEqual({ helper, at: true });
	}

	// Read from the class's parent, which a rewritten class does not have.
	expect(source).toContain(`Reflect.defineMetadata(${name}Provider, "flamework:module", script)`);
}

afterAll(() => {
	fs.rmSync(PROBE_CONFIG, { force: true });
});

describe("a transformer listed before Flamework's", () => {
	test("rewriting class declarations: a provider keeps its hoisted helpers, last or not", () => {
		const result = compileRewritten("classes", PROVIDERS);

		expect(result.output).not.toContain("TS2304");
		expect(result.status).toBe(0);
		expectHelpersAhead(result, "rewriteFirstLast");
		expectHelpersAhead(result, "rewriteFirstFollowed");
	}, 600_000);

	test("rewriting every top-level statement: helpers, caller metadata", () => {
		const result = compileRewritten("statements", { ...PROVIDERS, rewriteFirstCaller: CALLER });

		expect(result.output).not.toContain("TS2304");
		expect(result.output).not.toContain("Flamework failure");
		expect(result.status).toBe(0);
		expectHelpersAhead(result, "rewriteFirstLast");
		expectHelpersAhead(result, "rewriteFirstFollowed");

		// A call the transformer rewrote has no file to measure; its line and text are the written ones.
		expect(emittedFile(result, "rewriteFirstCaller")).toContain('rewriteFirstWhere(8, "rewriteFirstWhere()")');
	}, 600_000);

	test("rewriting everything in every statement: helpers, a component's config", () => {
		const result = compileRewritten("deep", { ...PROVIDERS, rewriteFirstComponent: COMPONENT });

		expect(result.output).not.toContain("TS2304");
		expect(result.output).not.toContain("Flamework failure");
		expect(result.status).toBe(0);
		expectHelpersAhead(result, "rewriteFirstLast");
		expectHelpersAhead(result, "rewriteFirstFollowed");

		// The config is found through the decorator's class, which a rewritten decorator does not have.
		const component = emittedFile(result, "rewriteFirstComponent").replace(/\s+/g, " ");
		expect(component).toContain("attributes = { power = t.number, }");
		expect(component).toContain('instanceShape = { isA = { "BasePart" }, }');
	}, 600_000);

	test("rewriting everything in every statement: an error at a rewritten call names where it is written", () => {
		const result = compileRewritten("deep", { rewriteFirstError: ERROR });

		expect(result.status).not.toBe(0);
		expect(result.output).not.toContain("Flamework failure");
		expect(result.output).not.toContain("TypeError");
		expect(result.output).toContain(
			"src/rewriteFirstError.ts:7:31 - error TS @flamework-experimental/transformer: 'RewriteFirstQuestsUI' is a component (@Component), not a provider",
		);
	}, 600_000);
});
