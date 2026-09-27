import { Provider } from "@flamework-experimental/core";

/** Below a folder of the path: path registration requires every module under it. */
@Provider()
class DeepProvider {}

export const deepName = tostring(DeepProvider);
