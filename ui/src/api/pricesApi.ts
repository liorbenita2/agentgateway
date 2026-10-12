import { requestJson } from '@/api/base';

// One rate-card row from config-service's /v1/rates, served by the tools host at <base>/prices.
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

export interface RatesResponse {
	fetch_run_id: string;
	fetched_at: string;
	unit: string;
	rates: RateRow[];
}

export function listRates() {
	return requestJson<RatesResponse>('/prices');
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

export function getCatalog() {
	return requestJson<CatalogResponse>('/catalog');
}
