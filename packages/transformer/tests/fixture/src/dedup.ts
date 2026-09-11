import { Flamework } from "@flamework-experimental/core";

interface Point {
	x: number;
	y: number;
}

// The fixture sets `optimizations.guardGenerationDedupLimit` to 3, so `Point` is emitted once and
// referenced three times rather than being inlined three times.
export const pointsGuard = Flamework.createGuard<{ a: Point; b: Point; c: Point }>();
