import Ajv from "ajv";
import path from "path";
import fs from "fs";
import { FlameworkBuildInfo } from "../classes/buildInfo";
import type { ProjectConfig } from "./projectConfig";

interface Schemas {
	buildInfo: FlameworkBuildInfo;
	projectConfig: ProjectConfig;
}

/** Schemas that live in their own file, so editors can reference them directly. */
const STANDALONE_SCHEMAS: Record<string, string> = {
	projectConfig: "flamework.config.schema.json",
};

const SCHEMA = createSchema();

function createSchema() {
	const schema = new Ajv();
	schema.addSchema(readSchema("flamework-schema.json"), "root");

	for (const [key, file] of Object.entries(STANDALONE_SCHEMAS)) {
		schema.addSchema(readSchema(file), key);
	}

	return schema;
}

function readSchema(file: string) {
	return JSON.parse(fs.readFileSync(path.join(__dirname, "../..", file), { encoding: "utf8" }));
}

export function getSchemaErrors() {
	return SCHEMA.errors ?? [];
}

/** The parsed schema itself, for code that walks it alongside a value. */
export function getSchema<K extends keyof Schemas>(key: K): object {
	const validate = SCHEMA.getSchema(key in STANDALONE_SCHEMAS ? key : `root#/properties/${key}`);
	if (!validate || typeof validate.schema !== "object") {
		throw new Error(`No schema registered for '${key}'`);
	}

	return validate.schema;
}

export function validateSchema<K extends keyof Schemas>(key: K, value: unknown): value is Schemas[K] {
	return SCHEMA.validate(key in STANDALONE_SCHEMAS ? key : `root#/properties/${key}`, value);
}
