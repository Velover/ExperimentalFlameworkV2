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
	 * @hideinherited
	 */
	onPhysics(dt: number): void;
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
	 * Only available for controllers.
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
