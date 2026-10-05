/**
 * The hidden desktop `flamework-test test` opens its Studio windows on, so that a run never shows a
 * window or takes the focus. Windows only.
 *
 * A desktop is a surface of the user's window station (WinSta0) that holds windows of its own; only
 * one, the user's, is ever shown, and nothing here switches to another. A process started on a
 * desktop (CreateProcessW with `STARTUPINFOW.lpDesktop`) opens all its windows there, its dialogs
 * and splash screens included. Studio on one runs as it does anywhere: the MCP proxy reaches it, a
 * play session starts, and its client renders (measured 2026-10-05, see docs/testing/studio.md).
 *
 * Nothing on the user's desktop sees such a window: EnumWindows, and the `MainWindowTitle` Windows
 * PowerShell reads, list the windows of the caller's own desktop only. So a window is found by its
 * process (the PID a launch returns) and the command line it was started with, and its title is
 * read by enumerating the hidden desktop itself ({@link desktopWindows}).
 *
 * The desktop is made by the first launch (CreateDesktopW opens it when it exists already), and the
 * handle is kept until this process exits, so the desktop is there while Studio attaches to it.
 * Windows removes a desktop once nothing holds it: no handle, and no thread of a process on it.
 *
 * Bun's own spawn (libuv) can only pass `SW_HIDE` or `SW_SHOWDEFAULT` and no desktop, so the launch
 * calls kernel32 and user32 through `bun:ffi`, with the structures built in buffers.
 */
import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";

/** The desktop every hidden window opens on, for every run and project of this user. */
export const HIDDEN_DESKTOP = "flamework-test";

/** `STARTUPINFOW.wShowWindow`: shown, without activating it (taking the focus). */
export const SW_SHOWNOACTIVATE = 4;
/** `STARTUPINFOW.dwFlags`: `wShowWindow` is to be read. */
export const STARTF_USESHOWWINDOW = 0x1;
/**
 * The creation flags, those of a detached launch through libuv (Node's and Bun's `spawn` with
 * `detached`): no console of this process, a process group of its own, so a Ctrl+C in the terminal
 * never reaches Studio.
 */
export const CREATION_FLAGS = 0x8 /* DETACHED_PROCESS */ | 0x200; /* CREATE_NEW_PROCESS_GROUP */
/** What the desktop is made with: everything, for this process; the desktop is the user's own. */
const GENERIC_ALL = 0x10000000;
/** What a look at the desktop's windows needs. */
const DESKTOP_READOBJECTS = 0x0001;
const DESKTOP_ENUMERATE = 0x0040;
/** `GetWindow`: the window's owner; a main window has none. */
const GW_OWNER = 4;

/** `STARTUPINFOW` on 64-bit Windows: 104 bytes, `lpDesktop` at 16, `dwFlags` at 60, `wShowWindow` at 64. */
export const STARTUPINFOW_SIZE = 104;
/** `PROCESS_INFORMATION` on 64-bit Windows: two handles, then the process and thread ids. */
export const PROCESS_INFORMATION_SIZE = 24;

/** A string as Windows' wide functions take it: UTF-16, ended by a 0. */
function wide(text: string): Buffer {
	return Buffer.from(`${text}\0`, "utf16le");
}

/**
 * One argument of a Windows command line, quoted as the C runtime reads one back (and as libuv
 * quotes it): left bare when it has no space, tab or quote; otherwise in quotes, with a quote
 * escaped and the backslashes before a quote, or before the closing quote, doubled.
 */
export function quoteArgument(argument: string): string {
	if (argument !== "" && !/[\s"]/.test(argument)) return argument;
	let quoted = '"';
	let backslashes = 0;
	for (const character of argument) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		quoted += "\\".repeat(character === '"' ? backslashes * 2 + 1 : backslashes) + character;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/** The command line a launch passes: every argument quoted as {@link quoteArgument} does. */
export function commandLineOf(command: readonly string[]): string {
	return command.map(quoteArgument).join(" ");
}

/**
 * The `STARTUPINFOW` of a launch onto a desktop, as bytes: its size, the desktop's name
 * (`WinSta0\<name>`, a pointer to a wide string the caller keeps alive through the call), and the
 * show command. Everything else is zero, so Windows picks the rest as for any launch.
 */
export function startupInfo(desktop: Pointer | number, show: number): Buffer {
	const info = Buffer.alloc(STARTUPINFOW_SIZE);
	info.writeUInt32LE(STARTUPINFOW_SIZE, 0);
	info.writeBigUInt64LE(BigInt(desktop), 16);
	info.writeUInt32LE(STARTF_USESHOWWINDOW, 60);
	info.writeUInt16LE(show, 64);
	return info;
}

/** The functions this needs. */
function open() {
	return {
		kernel32: dlopen("kernel32.dll", {
			CreateProcessW: {
				args: [
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.i32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
				],
				returns: FFIType.i32,
			},
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		}),
		user32: dlopen("user32.dll", {
			CreateDesktopW: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
				returns: FFIType.ptr,
			},
			OpenDesktopW: { args: [FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			CloseDesktop: { args: [FFIType.ptr], returns: FFIType.i32 },
			EnumDesktopWindows: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
			GetWindowTextW: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetWindow: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.ptr },
		}),
	};
}
let libraries: ReturnType<typeof open> | undefined;

/** kernel32 and user32, opened on first use. */
function win32(): ReturnType<typeof open> {
	return (libraries ??= open());
}

/** The desktops this process has made or opened, by name: each handle is kept until the process exits. */
const desktops = new Map<string, unknown>();

/** Makes the desktop, or opens it when it exists already, and keeps its handle. */
function holdDesktop(name: string): void {
	if (desktops.has(name)) return;
	const { kernel32, user32 } = win32();
	const handle = user32.symbols.CreateDesktopW(wide(name), null, null, 0, GENERIC_ALL, null);
	if (!handle) {
		throw new Error(
			`could not make the hidden desktop ${name} (CreateDesktopW: error ${kernel32.symbols.GetLastError()})`,
		);
	}
	desktops.set(name, handle);
}

/**
 * Starts a program on a desktop of the user's window station, made when it does not exist yet, and
 * returns its process id; throws when Windows refuses. The program is shown there without taking
 * the focus, and nothing of it ever appears on the user's desktop. Its handles are closed at once:
 * the process is known by its id from here, as a detached spawn's is. Windows only.
 *
 * `creationFlags` is for the tests, which start a console program (PowerShell) that has to run
 * without a console of its own: `DETACHED_PROCESS` ends one at once.
 */
export function launchOnDesktop(
	command: readonly string[],
	desktop = HIDDEN_DESKTOP,
	creationFlags = CREATION_FLAGS,
): number {
	if (command.length === 0) throw new Error("nothing to launch");
	holdDesktop(desktop);
	const { kernel32 } = win32();
	// Every buffer stays referenced until the call has returned.
	const application = wide(command[0]!);
	const line = wide(commandLineOf(command));
	const station = wide(`WinSta0\\${desktop}`);
	const info = startupInfo(ptr(station), SW_SHOWNOACTIVATE);
	const processInfo = Buffer.alloc(PROCESS_INFORMATION_SIZE);
	const ok = kernel32.symbols.CreateProcessW(
		application,
		line,
		null,
		null,
		0,
		creationFlags,
		null,
		null,
		info,
		processInfo,
	);
	if (ok === 0) {
		throw new Error(
			`could not start ${command[0]} on the hidden desktop ${desktop} (CreateProcessW: error ${kernel32.symbols.GetLastError()})`,
		);
	}
	const processHandle = Number(processInfo.readBigUInt64LE(0));
	const threadHandle = Number(processInfo.readBigUInt64LE(8));
	if (threadHandle !== 0) kernel32.symbols.CloseHandle(threadHandle as Pointer);
	if (processHandle !== 0) kernel32.symbols.CloseHandle(processHandle as Pointer);
	return processInfo.readUInt32LE(16);
}

/** A top-level window on a desktop: the process it belongs to, and its title. */
export interface DesktopWindow {
	pid: number;
	title: string;
}

/**
 * The main windows on a desktop, by process: the visible ones without an owner, as Windows
 * PowerShell picks a process's `MainWindowTitle` on the user's desktop. None when the desktop does
 * not exist (no run has made it since every window on it closed) or cannot be opened. Windows only.
 */
export function desktopWindows(desktop = HIDDEN_DESKTOP): DesktopWindow[] {
	const { user32 } = win32();
	const handle = user32.symbols.OpenDesktopW(wide(desktop), 0, 0, DESKTOP_READOBJECTS | DESKTOP_ENUMERATE);
	if (!handle) return [];
	const found: DesktopWindow[] = [];
	const pid = new Uint32Array(1);
	const text = new Uint16Array(1024);
	const callback = new JSCallback(
		(window: Pointer) => {
			if (user32.symbols.IsWindowVisible(window) === 0) return 1;
			const owner = user32.symbols.GetWindow(window, GW_OWNER);
			if (owner) return 1;
			pid[0] = 0;
			user32.symbols.GetWindowThreadProcessId(window, pid);
			const length = user32.symbols.GetWindowTextW(window, text, text.length);
			found.push({
				pid: pid[0]!,
				title: Buffer.from(text.buffer, 0, Math.max(0, length) * 2).toString("utf16le"),
			});
			return 1;
		},
		{ args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
	);
	try {
		user32.symbols.EnumDesktopWindows(handle, callback.ptr, null);
	} finally {
		callback.close();
		user32.symbols.CloseDesktop(handle);
	}
	return found;
}

/**
 * The title each process on the hidden desktop shows, by PID: a titled main window's, the first
 * `… - Roblox Studio` one when it has several (a splash or a transient window may come first).
 * Empty anywhere but Windows, and when the desktop cannot be looked at.
 */
export function hiddenTitles(desktop = HIDDEN_DESKTOP): Map<number, string> {
	const titles = new Map<number, string>();
	if (process.platform !== "win32") return titles;
	let windows: DesktopWindow[];
	try {
		windows = desktopWindows(desktop);
	} catch {
		return titles;
	}
	for (const window of windows) {
		const before = titles.get(window.pid);
		const better =
			before === undefined ||
			(before === "" && window.title !== "") ||
			(!/\S\s+-\s+Roblox Studio$/.test(before) && /\S\s+-\s+Roblox Studio$/.test(window.title));
		if (better) titles.set(window.pid, window.title);
	}
	return titles;
}
