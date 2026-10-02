import { Provider } from "@flamework-experimental/core";

// The provider the duplicate-id cases register twice, in modules of their own. It lives outside
// every folder the game's module registers: path registration takes every class a module defines.

@Provider()
export class DupLedger {}
