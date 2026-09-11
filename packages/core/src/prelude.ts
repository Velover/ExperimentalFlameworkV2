/**
 * Re-exports `t` so that generated guards can import it through `@flamework-experimental/core/out/prelude`.
 *
 * The transformer does this when the consuming project resolves a different `@rbxts/t` than core
 * does, so that guards always run against the version core was built and tested with.
 */
import { t } from "@rbxts/t";

export { t };
