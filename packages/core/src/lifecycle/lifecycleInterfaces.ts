/**
 * Hook into the OnInit lifecycle event.
 *
 * `onInit` runs during ignition, after every provider has been constructed and before any `onStart`,
 * in dependency order. It may return a Promise, which delays the initialisation of everything after
 * it until the Promise settles; a rejection fails ignition.
 *
 * This is where setup that must be complete before other providers start belongs.
 */
export interface OnInit {
	/**
	 * Called once during ignition, in dependency order, before any `onStart`.
	 *
	 * Yielding or returning a Promise delays the providers after this one, so keep it short.
	 *
	 * @hideinherited
	 */
	onInit(): void | Promise<void>;
}

/**
 * Hook into the OnStart lifecycle event.
 */
export interface OnStart {
	/**
	 * This function will be called after the current module has been initialized.
	 * This function will be called asynchronously.
	 *
	 * @hideinherited
	 */
	onStart(): void;
}

/**
 * Hook into the OnTick lifecycle event.
 * Equivalent to: RunService.PostSimulation
 */
export interface OnTick {
	/**
	 * Called every frame, after physics.
	 *
	 * @hideinherited
	 */
	onTick(dt: number): void;
}

/**
 * Hook into the OnPhysics lifecycle event.
 * Equivalent to: RunService.PreSimulation
 */
export interface OnPhysics {
	/**
	 * Called every frame, before physics.
	 *
	 * @param dt The time since the previous frame.
	 * @param time The elapsed game time, as returned by `time()`.
	 * @hideinherited
	 */
	onPhysics(dt: number, time: number): void;
}

/**
 * Hook into the OnRender lifecycle event.
 * Equivalent to: RunService.PreRender
 *
 * @client
 */
export interface OnRender {
	/**
	 * Called every frame, before rendering.
	 * Only fires on the client.
	 *
	 * @hideinherited
	 */
	onRender(dt: number): void;
}

/**
 * Runs when this module is terminated.
 *
 * It's not strictly required, but this can be convenient in code that must be run in tests or UI.
 */
export interface OnExtinguished {
	/**
	 * Runs when this module is terminated.
	 */
	onExtinguished(): void;
}
