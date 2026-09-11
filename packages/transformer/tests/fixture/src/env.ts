import { Flamework } from "@flamework/core";

// Set in the fixture's .env; the call is replaced by the value as a string literal.
export const scopes = Flamework.env("FLAMEWORK_FIXTURE_SCOPES");

// Not set anywhere, so the fallback is what gets inlined.
export const channel = Flamework.env("FLAMEWORK_FIXTURE_CHANNEL", "dev");
