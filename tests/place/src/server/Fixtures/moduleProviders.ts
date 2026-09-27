import { OnExtinguished, OnTick, Provider } from "@flamework-experimental/core";

// Providers the module cases register in modules of their own, outside every folder the game's
// module registers: path registration takes every class a module defines, exported or not.

@Provider()
export class Widget {
	public readonly kind = "widget";
}

@Provider()
export class Consumer {
	constructor(public readonly widget: Widget) {}
}

@Provider({ lazy: true })
export class Gadget {
	public static constructed = 0;

	constructor() {
		Gadget.constructed += 1;
	}
}

/** Ticks and counts its extinguish, to show what a module still holds after it went wrong. */
@Provider()
export class Ticking implements OnTick, OnExtinguished {
	public static frames = 0;
	public static extinguished = 0;

	public onTick() {
		Ticking.frames += 1;
	}

	public onExtinguished() {
		Ticking.extinguished += 1;
	}
}
