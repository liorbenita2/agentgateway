import type { CatalogModel, CatalogRates, CatalogResponse, CatalogTier } from '@/api/pricesApi';
import type { PricedModel, PriceProvider } from '@/pages/models/pricing';

// Models-page provider -> agentgateway provider name in the price job's catalog.
const CATALOG_PROVIDER: Partial<Record<PriceProvider, string>> = {
	openai: 'openai',
	anthropic: 'anthropic',
	vertex: 'gcp.vertex_ai',
	gemini: 'gcp.gemini',
	bedrock: 'aws.bedrock',
	together: 'togetherai'
};

export const CATALOG_COLUMNS: Array<{ key: keyof CatalogRates; line: string; label: string }> = [
	{ key: 'input', line: 'input', label: 'Input' },
	{ key: 'output', line: 'output', label: 'Output' },
	{ key: 'cacheRead', line: 'cache_read', label: 'Cache read' },
	{ key: 'cacheWrite', line: 'cache_write_5m', label: 'Write 5m' },
	{ key: 'cacheWrite1h', line: 'cache_write_1h', label: 'Write 1h' }
];

export function catalogEntry(
	catalog: CatalogResponse | null,
	model: PricedModel
): CatalogModel | null {
	const provider = CATALOG_PROVIDER[model.provider];
	if (!catalog || !provider) return null;
	// Gemini on Vertex is priced under gcp.vertex_ai, so Google models try both.
	const google = provider.startsWith('gcp.') ? ['gcp.vertex_ai', 'gcp.gemini'] : [provider];
	// Vertex names its models google/<id>; the catalog keys the bare id.
	const names = [model.upstream, model.upstream.split('/').pop() ?? model.upstream];
	for (const p of google) {
		for (const name of names) {
			const hit = catalog.providers[p]?.models[name];
			if (hit) return hit;
		}
	}
	return null;
}

export function tierLabel(tier: CatalogTier) {
	const parts = [tier.serviceTier, tier.region].filter(Boolean) as string[];
	if (tier.contextOver) {
		const k = tier.contextOver / 1000;
		parts.push(
			`over ${tier.contextOver >= 1000 ? `${Number(k.toPrecision(6))}k` : tier.contextOver}`
		);
	}
	return parts.join(' · ');
}

// agentgateway 1.7 bills only the standard, global price and its long-context bands.
export function billedByGateway(tier: CatalogTier) {
	return !tier.serviceTier && !tier.region;
}
