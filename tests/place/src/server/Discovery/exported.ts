import { BaseComponent, Component } from "@flamework-experimental/components";
import { Provider } from "@flamework-experimental/core";

// The discovery fixtures. This folder is registered by no module of the game: the path cases
// register it in modules of their own.

/** Exported and defined here: found once, not once per way of finding it. */
@Provider()
export class DiscoveryExported {}

/** An undecorated subclass inherits its parent's identifier and is never found as a class of its own. */
export class DiscoveryUndecoratedChild extends DiscoveryExported {}

@Component({ tag: "DiscoveryExported" })
export class DiscoveryExportedComponent extends BaseComponent<{}, Folder> {}
