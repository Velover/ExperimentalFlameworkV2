import { Module, OnExtinguished, OnInit, OnPhysics, OnStart, OnTick, Provider } from "@flamework-experimental/core";

// Providers the lifecycle cases register in modules of their own. They live outside every folder the
// game's module registers: path registration takes every class a module defines, exported or not,
// and these must not join the game's module, whose ticks and extinguishes the cases do not count.

export const inits = new Array<string>();

@Provider({ lazy: true })
export class LazyInit implements OnInit, OnStart {
	public onInit() {
		inits.push("lazy:init");
	}

	public onStart() {
		inits.push("lazy:start");
	}
}

/**
 * Resolves the lazy provider from its `onInit`, the way a provider setting itself up would. Through
 * the module it was built by: `Dependency<T>()` without one answers from the game's module here.
 */
@Provider()
export class LazyResolver implements OnInit {
	constructor(private readonly module: Module) {}

	public onInit() {
		inits.push("resolver:init");
		this.module.resolveDependency<LazyInit>();
		inits.push("resolver:resolved");
	}
}

/** Implements three events, so that listening for one of them shows which ones attach. */
@Provider()
export class Multi implements OnTick, OnPhysics, OnExtinguished {
	public ticks = 0;
	public physics = 0;
	public extinguishes = 0;

	public onTick() {
		this.ticks += 1;
	}

	public onPhysics() {
		this.physics += 1;
	}

	public onExtinguished() {
		this.extinguishes += 1;
	}
}

export const dupLog = new Array<string>();

/** Logs its events; the subclass below re-declares every interface it implements. */
@Provider()
export class DupBase implements OnInit, OnStart, OnTick {
	public onInit() {
		dupLog.push("init");
	}

	public onStart() {
		dupLog.push("start");
	}

	public onTick() {
		dupLog.push("tick");
	}
}

/** Re-declares its parent's interfaces, so the transformer writes every id on both classes. */
@Provider()
export class DupChild extends DupBase implements OnInit, OnStart, OnTick {}
