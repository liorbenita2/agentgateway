import { requestJson } from '@/api/base';

// One price row, built from the gateway catalog (catalogRates).
export interface RateRow {
	provider: string;
	model: string;
	line_item: string;
	service_tier: string;
	context_tier: string;
	context_min_tokens: number;
	region: string;
	unit: string;
	rate_per_unit: string;
	price_source: string;
	source_endpoint_tag: string | null;
	effective_from: string | null;
	effective_to: string | null;
}

// Daily token caps per model (-1 = uncapped), as the chart gives the limiter; served at <base>/caps.
export interface DailyCap {
	input: number;
	output: number;
}

export interface CapsResponse {
	default: DailyCap;
	models: Record<string, DailyCap>;
}

export function listCaps() {
	return requestJson<CapsResponse>('/caps');
}

// The price job's ai21-model-catalog: $ per 1M tokens as decimal strings, served at <base>/catalog.
export interface CatalogRates {
	input?: string;
	output?: string;
	cacheRead?: string;
	cacheWrite?: string;
	cacheWrite1h?: string;
}

export interface CatalogTier {
	serviceTier?: string;
	region?: string;
	contextOver?: number;
	rates: CatalogRates;
}

export interface CatalogModel {
	rates?: CatalogRates;
	tiers?: CatalogTier[];
}

export interface CatalogResponse {
	providers: Record<string, { models: Record<string, CatalogModel> }>;
}

type RawRates = CatalogRates & { cacheWriteDetails?: Record<string, string> };

function withWrite1h(rates: RawRates | undefined): CatalogRates | undefined {
	if (!rates) return rates;
	const { cacheWriteDetails, ...rest } = rates;
	const write1h = cacheWriteDetails?.['1h'] ?? rest.cacheWrite1h;
	return write1h === undefined ? rest : { ...rest, cacheWrite1h: write1h };
}

export async function getCatalog(): Promise<CatalogResponse> {
	const raw = await requestJson<CatalogResponse>('/catalog');
	const providers = Object.fromEntries(
		Object.entries(raw.providers).map(([provider, { models }]) => [
			provider,
			{
				models: Object.fromEntries(
					Object.entries(models).map(([model, entry]) => [
						model,
						{
							...entry,
							rates: withWrite1h(entry.rates),
							tiers: entry.tiers?.map(t => ({ ...t, rates: withWrite1h(t.rates) ?? {} }))
						}
					])
				)
			}
		])
	);
	return { ...raw, providers };
}
