import { callsiteId, luauLine } from "./macros";

// Two callsites in one declaration-free scope: their ids must differ from each other and be
// identical from one compilation to the next.
export const first = callsiteId();
export const second = callsiteId();

// The Luau line is read when this runs: the argument is a `debug.info` call, not a literal.
export const emittedLine = luauLine();
