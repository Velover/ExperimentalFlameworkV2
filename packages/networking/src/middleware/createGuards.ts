import { t } from "@rbxts/t";
import { SignalContainer } from "../util/createSignalContainer";
import { EventNetworkingEvents } from "../handlers";
import { NetworkInfo } from "../types";
import { Players } from "@rbxts/services";
import { Guards } from "./processor";

/**
 * The generated argument checks of one event or function, for the receive pipeline, which runs them
 * ahead of all user middleware. A failure warns (with `warnOnInvalid`) and fires `onBadRequest`.
 */
export function createGuards(
	name: string,
	fixedParameters: t.check<unknown>[],
	restParameter: t.check<unknown> | undefined,
	parametersAfterRest: t.check<unknown>[] | undefined,
	networkInfo: NetworkInfo,
	warnOnInvalid: boolean,
	signals: SignalContainer<EventNetworkingEvents>,
): Guards {
	return {
		fixed: fixedParameters,
		rest: restParameter,
		after: parametersAfterRest,
		reject: (player, index, value) => {
			if (warnOnInvalid) {
				if (player) {
					warn(`'${player}' sent invalid arguments for event '${name}' (arg #${index}):`, value);
				} else {
					warn(`Server sent invalid arguments for event '${name}' (arg #${index}):`, value);
				}
			}

			signals.fire("onBadRequest", player ?? Players.LocalPlayer, {
				networkInfo,
				argIndex: index,
				argValue: value,
			});
		},
	};
}
