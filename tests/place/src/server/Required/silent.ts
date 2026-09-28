import { requiredLog } from "server/Fixtures/requiredLog";

// A side effect and no exports: loaded, and left out of what the folder returns.
requiredLog.push("silent");
