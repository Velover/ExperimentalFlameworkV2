/**
 * Ctrl+C. An interrupted run stops waiting at once and unwinds through the cleanup a run that ends
 * goes through anyway: the play session it started is stopped, the Studio window it opened is
 * closed, its window-name claim is released, the patch's temp folder is removed and the child
 * processes it started are stopped. Nothing new is started once it has been interrupted.
 *
 * What a run holds that would outlive it is kept on a ledger meanwhile, so the line an interrupted
 * run ends on can say what was cleaned up and what was left (a task already created on Open Cloud
 * runs on, say), and a second Ctrl+C during the cleanup, which exits at once, can say what may be
 * left.
 */

/** What every wait of an interrupted run rejects with. */
export class Interrupted extends Error {
	/** `SIGINT`, `SIGBREAK` (Windows) or `SIGTERM` (not Windows: see the CLI's INTERRUPT_SIGNALS). */
	readonly signal: string;

	constructor(signal: string) {
		super(`interrupted by ${describeSignal(signal)}`);
		this.name = "Interrupted";
		this.signal = signal;
	}
}

/** How a signal is named to the person who sent it. */
export function describeSignal(signal: string): string {
	if (signal === "SIGINT") return "Ctrl+C";
	if (signal === "SIGBREAK") return "Ctrl+Break";
	return signal;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };

/** The exit code of a run a signal interrupted: 128 plus its number, so 130 for Ctrl+C. */
export function interruptedExitCode(signal: string): number {
	return 128 + (SIGNAL_NUMBERS[signal] ?? 2);
}

/**
 * Lets go of something held: see {@link Interruption.hold}. Letting go twice does nothing. `instead`
 * is what became of it when that is not what its undo says, for "cleaned up": a window the run
 * meant to close that had already closed.
 */
export type Release = (instead?: string) => void;

interface Held {
	/** What is held, as "may be left" names it. */
	what: string;
	/** What letting it go did, as "cleaned up" names it; nothing for what cannot be undone. */
	undo: string | undefined;
	/** Whether it ends with this process anyway, so that exiting at once does not leave it. */
	endsWithProcess: boolean;
	/** The hold this one ends with: a play session ends with the window it plays in. */
	within: number | undefined;
}

export class Interruption {
	/** The signal the run was interrupted by; undefined while it goes on. */
	private signal: string | undefined;
	private readonly controller = new AbortController();
	private cleaning = 0;
	private readonly held = new Map<number, Held>();
	private readonly ids = new WeakMap<Release, number>();
	private nextHold = 0;
	private readonly cleaned: string[] = [];

	get interrupted(): boolean {
		return this.signal !== undefined;
	}

	/** The signal the run was interrupted by, if it was. */
	get by(): string | undefined {
		return this.signal;
	}

	/**
	 * Aborted when the run is interrupted, for what can be stopped rather than only left behind: a
	 * child process is ended, a request aborted.
	 */
	get abortSignal(): AbortSignal {
		return this.controller.signal;
	}

	/** Interrupts the run: every pending wait rejects. False when it already was, which is then a second signal. */
	interrupt(signal: string): boolean {
		if (this.signal !== undefined) return false;
		this.signal = signal;
		this.controller.abort();
		return true;
	}

	/** Throws when the run has been interrupted and this is not its cleanup: nothing new starts then. */
	check(): void {
		if (this.signal !== undefined && this.cleaning === 0) throw new Interrupted(this.signal);
	}

	/**
	 * Starts `start` and waits for it, unless the run is interrupted: then it is not started, or the
	 * wait rejects with {@link Interrupted} at once, and `dispose` is handed what it yields if it
	 * yields it after all (a proxy that connects late is closed, a claim made late released). Inside
	 * {@link cleanup} it is a plain call: the cleanup is what an interrupted run waits for.
	 */
	run<T>(start: () => Promise<T>, dispose?: (value: T) => void): Promise<T> {
		if (this.cleaning > 0) return start();
		if (this.signal !== undefined) return Promise.reject(new Interrupted(this.signal));

		const work = start();
		const late = () =>
			void work.then(
				(value) => dispose?.(value),
				() => {},
			);
		// Started, and interrupted while it was starting (by something it did).
		if (this.signal !== undefined) {
			late();
			return Promise.reject(new Interrupted(this.signal));
		}

		const signal = this.controller.signal;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				reject(new Interrupted(this.signal!));
				late();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			work.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	/**
	 * Runs part of a run's cleanup (stopping the play session, closing its window): what it waits
	 * for is never refused, so a Ctrl+C that comes during the cleanup does not cut it short. Only
	 * a second one does, and that exits.
	 */
	async cleanup<T>(body: () => Promise<T>): Promise<T> {
		this.cleaning += 1;
		try {
			return await body();
		} finally {
			this.cleaning -= 1;
		}
	}

	/**
	 * Records something the run holds that would outlive it, until the returned release is called.
	 * `undo` names what letting it go did, for the line an interrupted run ends on: "closed the
	 * Studio window it opened". Something that cannot be undone has none and is released only when
	 * it ends by itself, so an interrupted run names it as left. What `endsWithProcess` is never
	 * named as left by a second Ctrl+C: a child process, which Bun ends when this process exits.
	 *
	 * What is held `within` another hold ends when that one is let go: the play session a run
	 * started ends with the window it plays in, so closing the window lets the session go too, and
	 * an interrupted run says it "ended with it" rather than naming it as left.
	 */
	hold(what: string, undo?: string, options: { endsWithProcess?: boolean; within?: Release } = {}): Release {
		const id = this.nextHold;
		this.nextHold += 1;
		const within = options.within !== undefined ? this.ids.get(options.within) : undefined;
		this.held.set(id, { what, undo, endsWithProcess: options.endsWithProcess === true, within });
		const release: Release = (instead) => this.letGo(id, instead);
		this.ids.set(release, id);
		return release;
	}

	private letGo(id: number, instead?: string): void {
		const held = this.held.get(id);
		if (held === undefined) return;
		this.held.delete(id);
		const said = instead ?? held.undo;
		const undone = this.signal !== undefined && said !== undefined;
		if (undone) this.cleaned.push(said);
		for (const [inner, what] of [...this.held].filter(([, other]) => other.within === id)) {
			this.held.delete(inner);
			if (undone) this.cleaned.push(`${what.what} ended with it`);
		}
	}

	/** What the run cleaned up once it was interrupted, and what it still holds, oldest first. */
	report(): { cleaned: string[]; left: string[] } {
		return { cleaned: [...this.cleaned], left: [...this.held.values()].map((held) => held.what) };
	}

	/** The line an interrupted run ends on. */
	summary(): string {
		const { cleaned, left } = this.report();
		const by = describeSignal(this.signal ?? "SIGINT");
		const done = cleaned.length > 0 ? `cleaned up: ${cleaned.join("; ")}` : "nothing needed cleaning up";
		return `interrupted by ${by}: ${done}${left.length > 0 ? `; left: ${left.join("; ")}` : ""}`;
	}

	/** The line a second signal exits on, at once. */
	abandoned(signal: string): string {
		const left = [...this.held.values()].filter((held) => !held.endsWithProcess).map((held) => held.what);
		return `${describeSignal(signal)} again: exiting without finishing the cleanup${left.length > 0 ? `; may be left: ${left.join("; ")}` : ""}`;
	}
}

/** Rethrows an interruption that a catch meant for something else has caught. */
export function rethrowInterrupted(error: unknown): void {
	if (error instanceof Interrupted) throw error;
}
