let inactiveThread: thread | undefined;

function reusableThread(func: () => void) {
	const thread = coroutine.running();

	while (true) {
		if (inactiveThread === thread) {
			inactiveThread = undefined;
		}

		func();

		// If there's a different idle thread, we should end the current thread.
		if (inactiveThread !== undefined) {
			break;
		}

		inactiveThread = thread;
		[func] = coroutine.yield() as LuaTuple<[never]>;
	}
}

export function recycleThread(func: () => void) {
	if (inactiveThread) {
		task.spawn(inactiveThread, func);
	} else {
		task.spawn(reusableThread, func);
	}
}
