/**
 * `--keep-awake`: asks Windows to keep the display on, and the machine awake, for as long as a
 * Studio run lasts. RenderStepped (and so Flamework's `onRender`) stops while the display is off,
 * so a client test that waits for a frame fails in a run nobody is watching once the display has
 * gone to sleep; a minimized or unfocused Studio window still renders, at about 60 frames a second.
 *
 * It is a request of this process, the one Windows' `SetThreadExecutionState` makes for the
 * calling thread, and changes no power setting: it is let go when the run ends, and Windows lets
 * it go by itself when the process exits, however it exits.
 */
import { dlopen, FFIType } from "bun:ffi";

import type { Interruption } from "./interrupt.ts";

/** Keeps the machine from sleeping. */
export const ES_SYSTEM_REQUIRED = 0x00000001;
/** Keeps the display on. */
export const ES_DISPLAY_REQUIRED = 0x00000002;
/** The state stays in effect until the next call that sets ES_CONTINUOUS: alone, it lets go again. */
export const ES_CONTINUOUS = 0x80000000;

/** What a run asks for while it lasts. */
export const KEEP_AWAKE_STATE = (ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED) >>> 0;

/**
 * kernel32's `SetThreadExecutionState`: sets the calling thread's execution state, and returns the
 * one before, or 0 when the call failed. May throw when the function cannot be reached at all.
 */
export type SetExecutionState = (state: number) => number;

let kernel32: { symbols: { SetThreadExecutionState: (state: number) => number } } | undefined;

/**
 * The real call, through `bun:ffi`, with kernel32 opened on first use. Windows only. JavaScript
 * runs on one thread here, so the request and its release are made on the same thread, as the
 * function asks.
 */
export const setThreadExecutionState: SetExecutionState = (state) => {
	kernel32 ??= dlopen("kernel32.dll", {
		SetThreadExecutionState: { args: [FFIType.u32], returns: FFIType.u32 },
	});
	return Number(kernel32.symbols.SetThreadExecutionState(state >>> 0));
};

export interface KeepAwakeIo {
	/** `process.platform`: only `win32` is asked. */
	platform: string;
	setExecutionState: SetExecutionState;
	log: (message: string) => void;
	error: (message: string) => void;
	interruption: Interruption;
}

/** What the request is named in the line an interrupted run ends on. */
export const KEEP_AWAKE_HOLD = "the request to keep the display on";
export const KEEP_AWAKE_UNDO = "let the display sleep again";

/**
 * Asks the system to keep the display on until the returned release is called, which lets go of
 * the request and may be called any number of times. Anywhere but Windows, and when Windows
 * refuses, the run goes on without it, saying so in one line.
 *
 * The request is held on the run's ledger as ending with the process: a second Ctrl+C, which exits
 * at once, does not leave it behind, since Windows lets go of a process's request when it exits.
 */
export function keepDisplayAwake(io: KeepAwakeIo): () => void {
	if (io.platform !== "win32") {
		io.log(`keep-awake does nothing on ${io.platform}: only Windows is asked to keep the display on`);
		return () => {};
	}

	let previous: number;
	try {
		previous = io.setExecutionState(KEEP_AWAKE_STATE);
	} catch (error) {
		io.error(
			`warning: could not ask Windows to keep the display on (${error instanceof Error ? error.message : String(error)}); the run goes on without it`,
		);
		return () => {};
	}
	if (previous === 0) {
		io.error(
			"warning: Windows refused to keep the display on (SetThreadExecutionState returned 0); the run goes on without it",
		);
		return () => {};
	}

	io.log("keeping the display on until the run ends (keep-awake)");
	const held = io.interruption.hold(KEEP_AWAKE_HOLD, KEEP_AWAKE_UNDO, { endsWithProcess: true });
	let released = false;
	return () => {
		if (released) return;
		released = true;
		try {
			io.setExecutionState(ES_CONTINUOUS);
		} catch {
			// The process's exit lets go of it all the same.
		}
		held();
	};
}
