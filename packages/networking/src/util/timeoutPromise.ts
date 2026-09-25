export function timeoutPromise(timeout: number, rejectValue: unknown) {
	// `Promise.delay` waits one frame for `math.huge`, so an infinite timeout must not reach it.
	if (timeout === math.huge) return new Promise<never>(() => {});

	return Promise.delay(timeout).then(() => Promise.reject(rejectValue));
}
