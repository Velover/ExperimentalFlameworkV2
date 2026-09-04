import type { TestSuite } from "./testkit";

import components = require("./specs/components");
import functions = require("./specs/functions");
import lifecycle = require("./specs/lifecycle");
import middleware = require("./specs/middleware");
import modding = require("./specs/modding");
import modules = require("./specs/modules");
import networking = require("./specs/networking");
import providers = require("./specs/providers");

/**
 * Every suite the Lune harness should run, in order.
 */
export const suites: TestSuite[] = [
	modding,
	providers,
	modules,
	lifecycle,
	components,
	networking,
	functions,
	middleware,
];
