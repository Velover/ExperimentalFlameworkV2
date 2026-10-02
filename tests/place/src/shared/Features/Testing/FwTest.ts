import { RunService } from "@rbxts/services";

/**
 * Minimal reporter for the Studio battletest (see docs/testing/studio.md at the repository root).
 *
 * Every check prints one line so a run can be read from the Output window or scraped from the
 * console, and `summary` closes each realm's run. Nothing here depends on Flamework, so a failure in
 * the framework cannot hide the report.
 */
export namespace FwTest {
	export const realm = RunService.IsServer() ? "server" : "client";

	let passed = 0;
	let failed = 0;
	let skipped = 0;

	export function check(name: string, pass: boolean, detail?: string) {
		if (pass) passed++;
		else failed++;
		print(`[FWTEST] ${realm} ${name}: ${pass ? "PASS" : "FAIL"}${detail !== undefined ? ` (${detail})` : ""}`);
	}

	/** A check the environment rules out: neither a pass nor a failure. */
	export function skip(name: string, reason: string) {
		skipped++;
		print(`[FWTEST] ${realm} ${name}: SKIP (${reason})`);
	}

	export function info(name: string, detail: string) {
		print(`[FWTEST] ${realm} ${name}: INFO ${detail}`);
	}

	/** Polls `predicate` every frame until it holds or `timeout` seconds pass. */
	export function eventually(predicate: () => boolean, timeout = 5): boolean {
		const deadline = os.clock() + timeout;
		while (os.clock() < deadline) {
			if (predicate()) return true;
			task.wait();
		}
		return predicate();
	}

	export function summary() {
		print(`[FWTEST] ${realm} SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped`);
	}
}
