/**
 * What the modules under `src/server/Required` did as they loaded. Outside that folder, so that
 * requiring the folder does not load it as one of them.
 */
export const requiredLog = new Array<string>();
