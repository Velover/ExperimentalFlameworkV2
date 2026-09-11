/**
 * The assertions come from the testing package, which is what a game's tests use too, so the
 * specs exercise the same helpers they ship. Only the suite shape is the harness's own.
 */
export {
	eventually,
	expectArrayEqual,
	expectDefined,
	expectEqual,
	expectFalse,
	expectNoThrow,
	expectRejects,
	expectResolves,
	expectThrows,
	expectTrue,
	fail,
} from "@flamework-experimental/testing";

export type TestCase = [name: string, run: () => void];

export interface TestSuite {
	name: string;
	cases: TestCase[];
}

export function suite(name: string, cases: TestCase[]): TestSuite {
	return { name, cases };
}
