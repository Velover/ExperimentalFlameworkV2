import type { TestSuite } from "./testkit";

import components = require("./specs/components");
import duplicateIds = require("./specs/duplicateIds");
import functions = require("./specs/functions");
import generatedCode = require("./specs/generatedCode");
import goldenLayouts = require("./specs/goldenLayouts");
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
import serializedMembers = require("./specs/serializedMembers");
import testing = require("./specs/testing");
import typeChecks = require("./specs/typeChecks");
import widthChecks = require("./specs/widthChecks");

/**
 * Every suite the Lune harness should run, in order.
 */
export const suites: TestSuite[] = [
	modding,
	paths,
	providers,
	modules,
	plugins,
	duplicateIds,
	scopes,
	lifecycle,
	components,
	networking,
	functions,
	middleware,
	serializedMembers,
	regressions,
	serialization,
	widthChecks,
	typeChecks,
	generatedCode,
	testing,
	goldenLayouts,
];
