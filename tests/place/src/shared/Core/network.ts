import { Networking } from "@flamework-experimental/networking";
import { FwCrazyPayload, FwRichPayload } from "shared/Features/Testing/FwTestConfig";

interface ClientToServerEvents {
	FwTest: {
		Ping(nonce: number): void;
		/** Asks the server to change the Speed attribute of the test part, so the client can observe it. */
		Bump(): void;
		/**
		 * Asks the server to bring the part a link attribute names inside the streaming radius, so
		 * the client can watch the handle it is parked on resolve.
		 */
		StreamInLinkTarget(near: boolean): void;
		/** Declared raw: travels as a plain value, guards still apply. */
		RawPing: Networking.RawReliable<(nonce: number) => void>;
	};
}

interface ServerToClientEvents {
	FwTest: {
		Pong(nonce: number): void;
		RawPong: Networking.RawReliable<(nonce: number) => void>;
	};
}

interface ClientToServerFunctions {
	FwTest: {
		Echo(value: string): string;
		/** Returns the payload with its numbers bumped, proving every field survived serialization. */
		RichEcho(payload: FwRichPayload): FwRichPayload;
		/** Returns the nested payload with one change per collection. */
		CrazyEcho(payload: FwCrazyPayload): FwCrazyPayload;
		/** Declared raw: request and result travel as plain values. */
		RawEcho: Networking.Raw<(value: string) => string>;
	};
}

interface ServerToClientFunctions {}

export const GlobalEvents = Networking.createEvent<ClientToServerEvents, ServerToClientEvents>();
export const GlobalFunctions = Networking.createFunction<ClientToServerFunctions, ServerToClientFunctions>();
