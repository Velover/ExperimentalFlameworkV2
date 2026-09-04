import { Flamework, Provider } from "@flamework/core";

@Provider()
export class Target {}

// Regression: every parameter here is passed explicitly, which used to stop the transformer from
// visiting the arguments at all -- leaving the nested `Flamework.id` macro as a raw runtime call.
export const module = Flamework.createModule()
	.registerClassProvider(Target)
	.registerProvider<string>({ type: "alias", injectionId: Flamework.id<Target>() }, "alias")
	.build();

export const nestedInArray = [Flamework.id<Target>(), Flamework.id<Target>()];
