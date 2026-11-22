import { requestJson } from '@/api/base';

// ai21 fork: the chart's costs server, which reads BigQuery's gateway_usage.v_gateway_costs; served at <base>/costs/*.
export const COST_GROUPS = [
	'client',
	'cost_center',
	'model',
	'upstream',
	'user',
	'price_source'
] as const;
export type CostGroup = (typeof COST_GROUPS)[number];

export const COST_FILTERS = ['client', 'cost_center', 'model', 'upstream'] as const;
export type CostFilter = (typeof COST_FILTERS)[number];
export type CostFilters = Partial<Record<CostFilter, string>>;

export const PRICE_SOURCES = ['catalog', 'gateway', 'self-hosted', 'no-usage', 'unpriced'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const COST_DAYS = [1, 7, 14, 30] as const;

export interface CostAmount {
	cost_usd: number;
	requests: number;
}

interface CostWindow {
	days: number;
	from: string;
	to: string;
	dates: string[];
	filters: CostFilters;
	updated_at: string;
	group_by: CostGroup;
}

export interface CostSummary extends CostWindow {
	total: CostAmount;
	groups: Array<CostAmount & { key: string; by_source: Partial<Record<PriceSource, CostAmount>> }>;
	sources: Array<CostAmount & { price_source: PriceSource }>;
}

export interface CostDaily extends CostWindow {
	groups: string[];
	rows: Array<CostAmount & { dt: string; key: string }>;
}

export interface CostRequest {
	ts: string;
	span_id: string;
	client: string;
	cost_center: string | null;
	user: string | null;
	model: string | null;
	upstream: string | null;
	http_status: number | null;
	input_tokens: number | null;
	uncached_input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	reasoning_tokens: number | null;
	cost_usd: number | null;
	price_source: PriceSource;
}

export interface CostRequests {
	days: number;
	limit: number;
	filters: CostFilters;
	rows: CostRequest[];
	updated_at: string;
}

export function costQuery(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) search.set(key, String(value));
	}
	return search.toString();
}

export function getCostSummary(days: number, groupBy: CostGroup, filters: CostFilters) {
	return requestJson<CostSummary>(
		`/costs/summary?${costQuery({ days, group_by: groupBy, ...filters })}`
	);
}

export function getCostDaily(days: number, groupBy: CostGroup, filters: CostFilters) {
	return requestJson<CostDaily>(
		`/costs/daily?${costQuery({ days, group_by: groupBy, ...filters })}`
	);
}

export function getCostRequests(days: number, limit: number, filters: CostFilters) {
	return requestJson<CostRequests>(`/costs/requests?${costQuery({ days, limit, ...filters })}`);
}
