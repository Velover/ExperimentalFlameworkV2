import type { TestSuite } from "./testkit";

import components = require("./specs/components");
import functions = require("./specs/functions");
import lifecycle = require("./specs/lifecycle");
import middleware = require("./specs/middleware");
import modding = require("./specs/modding");
import modules = require("./specs/modules");
import networking = require("./specs/networking");
import paths = require("./specs/paths");
import plugins = require("./specs/plugins");
import providers = require("./specs/providers");
import regressions = require("./specs/regressions");
import scopes = require("./specs/scopes");
import serialization = require("./specs/serialization");

/**
 * Every suite the Lune harness should run, in order.
 */
export const suites: TestSuite[] = [
	modding,
	paths,
	providers,
	modules,
	plugins,
	scopes,
	lifecycle,
	components,
	networking,
	functions,
	middleware,
	regressions,
	serialization,
];
