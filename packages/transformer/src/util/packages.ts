/**
 * The npm scope every Flamework package is published under, and the package names the transformer
 * emits imports for or resolves. Nothing else in the transformer spells the scope out.
 */
export const FLAMEWORK_SCOPE = "@flamework-experimental";
export const CORE_PACKAGE = `${FLAMEWORK_SCOPE}/core`;
export const COMPONENTS_PACKAGE = `${FLAMEWORK_SCOPE}/components`;
export const NETWORKING_PACKAGE = `${FLAMEWORK_SCOPE}/networking`;
export const PLUGIN_PACKAGE = `${FLAMEWORK_SCOPE}/transformer-plugin`;
