import { Provider } from "@flamework-experimental/core";

/** Exported and defined here: found once, not once per way of finding it. */
@Provider()
export class ExportedProvider {}

/** An undecorated subclass inherits its parent's identifier and is never found as a class of its own. */
export class UndecoratedChild extends ExportedProvider {}
