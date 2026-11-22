import type { DumpModel } from '@/gateway-admin';

/**
 * Model names a client can request: public concrete models and virtual models.
 * Internal models are excluded because they can only be targeted by virtual models.
 * The same model can be served by several listeners, so names are deduplicated.
 */
export function requestableDumpModelNames(models: DumpModel[]) {
	const names = new Set<string>();
	for (const model of models) {
		if ('concrete' in model.kind) {
			if (model.kind.concrete.visibility === 'public') names.add(model.name);
		} else {
			names.add(model.name);
		}
	}
	return [...names].sort((left, right) => left.localeCompare(right));
}

// ai21 fork: the iap listener (tools-host API) repeats every port-80 model, so list each name once, port 80's first.
export function uniqueModels(models: DumpModel[]): DumpModel[] {
	const rank = (m: DumpModel) =>
		m.listenerKey.endsWith('.models') ? 2 : m.listenerKey.endsWith('.iap') ? 1 : 0;
	const seen = new Set<string>();
	return [...models]
		.sort((a, b) => rank(a) - rank(b))
		.filter(m => {
			if (rank(m) === 1 && seen.has(m.name)) return false;
			seen.add(m.name);
			return true;
		});
}
