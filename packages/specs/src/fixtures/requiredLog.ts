/**
 * What the modules under `required/` did as they loaded, in order. Outside that folder, so that
 * requiring the folder does not load it as one of them.
 */
export const requiredLog = new Array<string>();
