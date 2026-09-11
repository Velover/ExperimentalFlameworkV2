import { Flamework } from "@flamework/core";

// Set in the fixture's .env; the call is replaced by the value as a string literal.
export const scopes: string | undefined = Flamework.env("FLAMEWORK_FIXTURE_SCOPES");

// Not set anywhere, so the fallback is what gets inlined, and the result is a string.
export const channel: string = Flamework.env("FLAMEWORK_FIXTURE_CHANNEL", "dev");

// Not set and no fallback: nil, and the type says so.
export const missing: string | undefined = Flamework.env("FLAMEWORK_FIXTURE_MISSING");
