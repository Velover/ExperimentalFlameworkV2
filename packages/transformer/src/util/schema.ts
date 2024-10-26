import Ajv from "ajv";
import path from "path";
import fs from "fs";
import { FlameworkBuildInfo } from "../classes/buildInfo";

const SCHEMA = createSchema();

interface Schemas {
	buildInfo: FlameworkBuildInfo;
}

function createSchema() {
	const schemaPath = path.join(__dirname, "../../flamework-schema.json");
	const schema = new Ajv();
	schema.addSchema(JSON.parse(fs.readFileSync(schemaPath, { encoding: "ascii" })), "root");

	return schema;
}

export function getSchemaErrors() {
	return SCHEMA.errors ?? [];
}

export function validateSchema<K extends keyof Schemas>(key: K, value: unknown): value is Schemas[K] {
	return SCHEMA.validate(`root#/properties/${key}`, value);
}
