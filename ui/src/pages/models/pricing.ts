import type { RateRow } from '@/api/pricesApi';
import type { DumpModel, StoresDump } from '@/gateway-admin';

export type PriceProvider =
	| 'openai'
	| 'anthropic'
	| 'vertex'
	| 'gemini'
	| 'bedrock'
	| 'together'
	| 'vercel'
	| 'self-hosted'
	| 'other';

export type ApiRoute = 'completions' | 'messages' | 'responses' | 'native';

export const API_ROUTES: Array<{ value: ApiRoute; label: string; path: string }> = [
	{ value: 'completions', label: 'Chat Completions', path: '/v1/chat/completions' },
	{ value: 'messages', label: 'Messages', path: '/v1/messages' },
	{ value: 'responses', label: 'Responses', path: '/v1/responses' },
	{ value: 'native', label: 'Native', path: 'provider API, passed through' }
];

export const PROVIDER_LABELS: Record<PriceProvider, string> = {
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	vertex: 'Vertex AI',
	gemini: 'Gemini API',
	bedrock: 'Bedrock',
	together: 'Together',
	vercel: 'Vercel AI Gateway',
	'self-hosted': 'Self-hosted',
	other: 'Other'
};

// ProviderIcon keys.
export const PROVIDER_ICONS: Record<PriceProvider, string> = {
	openai: 'openai',
	anthropic: 'anthropic',
	vertex: 'vertex',
	gemini: 'gemini',
	bedrock: 'bedrock',
	together: 'togetherai',
	vercel: 'custom',
	'self-hosted': 'custom',
	other: 'custom'
};

// config-service's provider for each upstream; the others have no rate card.
const RATE_CARD_PROVIDER: Partial<Record<PriceProvider, string>> = {
	openai: 'openai',
	anthropic: 'anthropic',
	vertex: 'gcp.gemini',
	gemini: 'gcp.gemini',
	bedrock: 'bedrock',
	together: 'together'
};

export interface RouteSupport {
	route: ApiRoute;
	native: boolean;
}

export interface PricedModel {
	model: DumpModel;
	provider: PriceProvider;
	upstream: string;
	pattern: boolean;
	via?: string;
	routes: RouteSupport[];
	rates: ModelRates | null;
}

export interface ModelRates {
	slug: string;
	standard: RateRow[];
	batch: RateRow[];
}

// --- Backends -----------------------------------------------------------------------------

interface Endpoint {
	provider: Record<string, unknown>;
	hostOverride?: string | null;
}

function endpointsByBackend(dump: StoresDump): Map<string, Endpoint> {
	const out = new Map<string, Endpoint>();
	for (const raw of dump.backends ?? []) {
		const backend = (raw as { backend?: Record<string, unknown> }).backend;
		const ai = backend?.ai as
			| {
					name: string;
					namespace?: string;
					target?: { providers?: Array<{ active?: { backend?: { endpoint?: Endpoint } } }> };
			  }
			| undefined;
		if (!ai) continue;
		const endpoint = ai.target?.providers?.[0]?.active?.backend?.endpoint;
		if (endpoint) out.set(`${ai.namespace ?? ''}/${ai.name}`, endpoint);
	}
	return out;
}

// "ns/name/backend.listener" -> "ns/name".
function backendKey(ref: unknown): string | null {
	const name = (ref as { backend?: string } | undefined)?.backend;
	if (typeof name !== 'string') return null;
	return name.split('/').slice(0, 2).join('/');
}

// A literal CEL string model rewrite, e.g. "\"claude-fable-5-1\"".
function rewrittenModel(model: DumpModel): string | null {
	if (!('concrete' in model.kind)) return null;
	const expr = (
		model.kind.concrete.policies as { llm?: { transformations?: { model?: string } } } | null
	)?.llm?.transformations?.model;
	const literal = typeof expr === 'string' ? /^"([^"\\]*)"$/.exec(expr.trim()) : null;
	return literal ? literal[1] : null;
}

function globMatch(pattern: string, name: string) {
	return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

type ChatFormat = 'completions' | 'messages' | 'responses' | 'gemini' | 'converse';
type Format = ChatFormat | 'embeddings' | 'rerank';

function nativeFormats(provider: Record<string, unknown>, upstream: string): Format[] {
	if ('openAI' in provider) return ['responses', 'completions'];
	if ('anthropic' in provider) return ['messages'];
	if ('gemini' in provider) return ['gemini', 'completions'];
	if ('bedrock' in provider) return ['converse', 'messages', 'responses'];
	if ('vertex' in provider) {
		return upstream.startsWith('claude') ? ['messages'] : ['gemini', 'completions'];
	}
	const custom = provider.custom as { formats?: Array<{ type: string }> } | undefined;
	return (custom?.formats ?? []).flatMap(f =>
		f.type === 'generateContent' ? ['gemini' as const] : [f.type as Format]
	);
}

// Which chat inputs agentgateway translates to each provider format (CHAT_TRANSLATIONS in llm/mod.rs).
const ACCEPTS: Record<'completions' | 'messages' | 'responses', ChatFormat[]> = {
	completions: ['completions', 'gemini', 'messages', 'converse'],
	messages: ['messages', 'gemini', 'completions', 'responses', 'converse'],
	responses: ['responses', 'completions', 'converse']
};

function routesFor(formats: Format[]): RouteSupport[] {
	const out: RouteSupport[] = [];
	for (const route of ['completions', 'messages', 'responses'] as const) {
		if (formats.some(f => (ACCEPTS[route] as Format[]).includes(f))) {
			out.push({ route, native: formats.includes(route) });
		}
	}
	return out;
}

function classify(
	provider: Record<string, unknown>,
	host: string
): Exclude<PriceProvider, 'vercel'> | 'vercel' {
	if ('openAI' in provider) return 'openai';
	if ('anthropic' in provider) return 'anthropic';
	if ('vertex' in provider) return 'vertex';
	if ('gemini' in provider) return 'gemini';
	if ('bedrock' in provider) return 'bedrock';
	const custom = provider.custom as { providerOverride?: string } | undefined;
	if (custom?.providerOverride === 'togetherai' || host.includes('together.xyz')) return 'together';
	if (host.includes('vercel.sh')) return 'vercel';
	if (host.includes('.svc.cluster.local') || !host.includes(':443')) return 'self-hosted';
	return 'other';
}

// --- Rates --------------------------------------------------------------------------------

// Comparable model key: no vendor prefix, no date suffix, dots as dashes, lower case.
export function modelKey(name: string): string {
	const last = name.toLowerCase().replace(/@.*$/, '').split('/').pop() ?? '';
	return last.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '').replace(/\./g, '-');
}

export type RateIndex = Map<string, Map<string, ModelRates>>;

export function indexRates(rows: RateRow[]): RateIndex {
	const index: RateIndex = new Map();
	for (const row of rows) {
		const batch = row.model.endsWith(':batch');
		const slug = batch ? row.model.slice(0, -':batch'.length) : row.model;
		const key = modelKey(slug);
		let byModel = index.get(row.provider);
		if (!byModel) {
			byModel = new Map();
			index.set(row.provider, byModel);
		}
		let entry = byModel.get(key);
		if (!entry) {
			entry = { slug, standard: [], batch: [] };
			byModel.set(key, entry);
		}
		(batch ? entry.batch : entry.standard).push(row);
	}
	return index;
}

// --- Models -------------------------------------------------------------------------------

export function priceModels(dump: StoresDump, rates: RateIndex | null): PricedModel[] {
	const endpoints = endpointsByBackend(dump);
	const modelsListener = dump.models.filter(m => m.listenerKey.endsWith('.models'));

	function resolve(
		model: DumpModel,
		depth: number
	): Omit<PricedModel, 'model' | 'rates' | 'routes'> & { formats: Format[] } {
		const upstream = rewrittenModel(model) ?? model.name;
		const pattern = upstream.includes('*');
		if (!('concrete' in model.kind)) {
			return { provider: 'other', upstream, pattern, formats: [] };
		}
		const endpoint = endpoints.get(backendKey(model.kind.concrete.backend) ?? '');
		if (!endpoint) return { provider: 'other', upstream, pattern, formats: [] };
		const host = endpoint.hostOverride ?? '';
		const formats = nativeFormats(endpoint.provider, upstream);
		// A hop to this gateway's models listener: price what that listener serves.
		if (depth === 0 && 'custom' in endpoint.provider && host.endsWith(':8080')) {
			const target = modelsListener.find(m => globMatch(m.name, upstream));
			if (target) {
				const inner = resolve(target, 1);
				return {
					provider: inner.provider,
					upstream: inner.pattern ? upstream : inner.upstream,
					pattern,
					via: target.name,
					formats
				};
			}
		}
		return { provider: classify(endpoint.provider, host), upstream, pattern, formats };
	}

	return dump.models.map(model => {
		const r = resolve(model, 0);
		const routes: RouteSupport[] =
			r.provider === 'vercel' ? [{ route: 'native', native: true }] : routesFor(r.formats);
		const card = RATE_CARD_PROVIDER[r.provider];
		const found =
			card && rates && !r.pattern ? (rates.get(card)?.get(modelKey(r.upstream)) ?? null) : null;
		return {
			model,
			provider: r.provider,
			upstream: r.upstream,
			pattern: r.pattern,
			via: r.via,
			routes,
			rates: found
		};
	});
}

// --- Price at the default slice -----------------------------------------------------------

export const PER_MILLION = 1_000_000;

export function perMillion(row: RateRow | undefined): number | null {
	return row ? Number(row.rate_per_unit) * PER_MILLION : null;
}

export function baseRow(rates: ModelRates, lineItem: string): RateRow | undefined {
	return rates.standard.find(
		r =>
			r.line_item === lineItem &&
			r.service_tier === 'standard' &&
			r.context_tier === 'base' &&
			r.region === 'global'
	);
}

export const LINE_LABELS: Record<string, string> = {
	input: 'Input',
	output: 'Output',
	cache_read: 'Cache read',
	cache_write_5m: 'Cache write 5m',
	cache_write_1h: 'Cache write 1h'
};

export interface LongTier {
	threshold: number;
	inputFactor: number;
	lines: Array<{ lineItem: string; base: number; long: number; factor: number }>;
}

// Standard-tier, global long-context rates in $/1M, each with its multiplier over base.
export function longTier(rates: ModelRates): LongTier | null {
	const rows = rates.standard.filter(
		r =>
			r.context_tier === 'long' &&
			r.service_tier === 'standard' &&
			r.region === 'global' &&
			r.unit === 'token'
	);
	if (!rows.length) return null;
	const lines = Object.keys(LINE_LABELS).flatMap(lineItem => {
		const long = rows.find(r => r.line_item === lineItem);
		const base = baseRow(rates, lineItem);
		if (!long || !base) return [];
		const b = Number(base.rate_per_unit);
		const l = Number(long.rate_per_unit);
		return [{ lineItem, base: b * PER_MILLION, long: l * PER_MILLION, factor: b ? l / b : 0 }];
	});
	return {
		threshold: rows[0].context_min_tokens,
		inputFactor: lines.find(l => l.lineItem === 'input')?.factor ?? 0,
		lines
	};
}

// --- Playground ---------------------------------------------------------------------------

export interface PriceParams {
	serviceTier: string;
	region: string;
	batch: boolean;
	ttl: '5m' | '1h';
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	webSearches: number;
}

export const FALLBACK_PARAMS: PriceParams = {
	serviceTier: 'standard',
	region: 'global',
	batch: false,
	ttl: '5m',
	inputTokens: 20_000,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 2_000,
	webSearches: 0
};

export interface ParamOptions {
	serviceTiers: string[];
	regions: string[];
	batch: boolean;
	ttl1h: boolean;
	cacheWrite: boolean;
	cacheRead: boolean;
	webSearch: boolean;
	long: number | null;
}

export function paramOptions(rates: ModelRates): ParamOptions {
	const rows = rates.standard;
	const unique = (values: string[]) => [...new Set(values)];
	const longRow = rows.find(r => r.context_tier === 'long');
	return {
		serviceTiers: unique(['standard', ...rows.map(r => r.service_tier)]),
		regions: unique(['global', ...rows.map(r => r.region)]),
		batch: rates.batch.length > 0,
		ttl1h: rows.some(r => r.line_item === 'cache_write_1h'),
		cacheWrite: rows.some(r => r.line_item.startsWith('cache_write')),
		cacheRead: rows.some(r => r.line_item === 'cache_read'),
		webSearch: rows.some(r => r.line_item === 'web_search'),
		long: longRow ? longRow.context_min_tokens : null
	};
}

export interface CostLine {
	label: string;
	quantity: number;
	unit: string;
	rate: number | null;
	cost: number;
	row?: RateRow;
	note?: string;
}

export interface CostResult {
	lines: CostLine[];
	total: number;
	contextTier: 'base' | 'long';
	promptTokens: number;
	// What our own records would say instead, and why.
	divergences: Array<{ title: string; source: string; detail: string; delta: number }>;
	warnings: string[];
}

interface Slice {
	tier: string;
	context: 'base' | 'long';
	region: string;
	batch: boolean;
}

function pick(rates: ModelRates, lineItem: string, slice: Slice) {
	const rows = slice.batch ? rates.batch : rates.standard;
	const tier = slice.batch ? 'standard' : slice.tier;
	const match = (context: string, region: string) =>
		rows.find(
			r =>
				r.line_item === lineItem &&
				r.service_tier === tier &&
				r.context_tier === context &&
				r.region === region
		);
	const exact = match(slice.context, slice.region);
	if (exact) return { row: exact };
	const global = match(slice.context, 'global');
	if (global) {
		return { row: global, note: `no ${slice.region} row; global price` };
	}
	if (slice.context === 'long') {
		const base = match('base', slice.region) ?? match('base', 'global');
		if (base) return { row: base, note: 'no long-context row; base price' };
	}
	return { row: undefined };
}

function costOf(rates: ModelRates, p: PriceParams, slice: Slice, warnings?: string[]) {
	const lines: CostLine[] = [];
	const add = (label: string, lineItem: string, quantity: number, unit = 'token') => {
		if (!quantity) return;
		const picked = pick(rates, lineItem, slice);
		if (!picked.row) {
			warnings?.push(`${label}: no rate for this tier/region on the card.`);
			lines.push({ label, quantity, unit, rate: null, cost: 0 });
			return;
		}
		const rate = Number(picked.row.rate_per_unit);
		lines.push({
			label,
			quantity,
			unit,
			rate: unit === 'token' ? rate * PER_MILLION : rate,
			cost: rate * quantity,
			row: picked.row,
			note: picked.note
		});
	};
	add('Input', 'input', p.inputTokens);
	add('Cache read', 'cache_read', p.cacheReadTokens);
	if (p.cacheWriteTokens) {
		const has1h = rates.standard.some(r => r.line_item === 'cache_write_1h');
		const has5m = rates.standard.some(r => r.line_item === 'cache_write_5m');
		if (p.ttl === '1h' && has1h) add('Cache write (1h)', 'cache_write_1h', p.cacheWriteTokens);
		else if (has5m) add('Cache write (5m)', 'cache_write_5m', p.cacheWriteTokens);
		else {
			warnings?.push('No cache-write price on this card; the tokens are priced as input.');
			add('Cache write (as input)', 'input', p.cacheWriteTokens);
		}
	}
	add('Output', 'output', p.outputTokens);
	add('Web search', 'web_search', p.webSearches, 'request');
	return { lines, total: lines.reduce((sum, line) => sum + line.cost, 0) };
}

// A saved default can name a tier or region this model lacks; fall back to standard/global.
export function fitParams(rates: ModelRates, params: PriceParams): PriceParams {
	const options = paramOptions(rates);
	return {
		...params,
		serviceTier: options.serviceTiers.includes(params.serviceTier)
			? params.serviceTier
			: 'standard',
		region: options.regions.includes(params.region) ? params.region : 'global',
		batch: params.batch && options.batch,
		ttl: options.ttl1h ? params.ttl : '5m'
	};
}

export function calculate(rates: ModelRates, params: PriceParams): CostResult {
	const options = paramOptions(rates);
	const p = fitParams(rates, params);
	const promptTokens = p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens;
	const contextTier = options.long !== null && promptTokens > options.long ? 'long' : 'base';
	const slice: Slice = {
		tier: p.serviceTier,
		context: contextTier,
		region: p.region,
		batch: p.batch && options.batch
	};
	const warnings: string[] = [];
	const { lines, total } = costOf(rates, p, slice, warnings);

	const divergences: CostResult['divergences'] = [];
	// The cost views price every request as standard tier, base context, global region.
	const reasons: string[] = [];
	if (contextTier === 'long') {
		reasons.push(
			`the prompt is over ${options.long?.toLocaleString()} tokens, so the invoice bills every line at the long rate; the views price base context`
		);
	}
	const regional = lines.find(line => line.row && line.row.region !== 'global')?.row?.region;
	if (regional) reasons.push(`the views price the global row, not ${regional}`);
	if (slice.batch) reasons.push('Batch API jobs bill the batch rate; the views price standard');
	else if (slice.tier !== 'standard') {
		reasons.push(
			`usage records do not capture the ${slice.tier} tier, so the views price standard`
		);
	}
	if (reasons.length) {
		const views = costOf(rates, p, {
			tier: 'standard',
			context: 'base',
			region: 'global',
			batch: false
		});
		const delta = views.total - total;
		if (Math.abs(delta) > 1e-9) {
			divergences.push({
				title: 'Tier, context and region',
				source: 'BigQuery cost views',
				detail: `${reasons.join('; ').replace(/^./, c => c.toUpperCase())}.`,
				delta
			});
		}
	}
	if (p.ttl === '1h' && p.cacheWriteTokens && options.ttl1h) {
		const delta = costOf(rates, { ...p, ttl: '5m' }, slice).total - total;
		if (Math.abs(delta) > 1e-9) {
			divergences.push({
				title: '1h cache write',
				source: "agentgateway's llm.cost",
				detail:
					'It has one cache-write price, the 5m one. The BigQuery cost views use the 1h rate.',
				delta
			});
		}
	}
	return { lines, total, contextTier, promptTokens, divergences, warnings };
}

// --- Defaults, kept in code ---------------------------------------------------------------

// Where the playground starts per provider; the table always shows standard tier, base context, global region.
const PROVIDER_DEFAULTS: Record<PriceProvider, Partial<PriceParams>> = {
	openai: {},
	anthropic: {},
	vertex: {},
	gemini: {},
	bedrock: {},
	together: {},
	vercel: {},
	'self-hosted': {},
	other: {}
};

export function defaultParams(provider: PriceProvider): PriceParams {
	return { ...FALLBACK_PARAMS, ...PROVIDER_DEFAULTS[provider] };
}

// The defaults behind a model's prices and the params the playground lets you change.
export function describeDefaults(
	rates: ModelRates,
	provider: PriceProvider
): { defaults: string[]; adjustable: string[] } {
	const o = paramOptions(rates);
	const d = defaultParams(provider);
	const long = longTier(rates);
	const defaults = [
		`Service tier: ${d.serviceTier}`,
		long
			? `Context: base (prompt up to ${long.threshold.toLocaleString()} tokens)`
			: 'Context: base (no long tier)',
		`Region: ${d.region}`
	];
	if (o.cacheWrite) defaults.push(`Cache write TTL: ${d.ttl}`);
	if (o.batch) defaults.push('Batch: off');
	defaults.push(
		`Playground start: ${d.inputTokens.toLocaleString()} input, ${d.outputTokens.toLocaleString()} output, ${d.cacheReadTokens.toLocaleString()} cache read, ${d.cacheWriteTokens.toLocaleString()} cache write tokens`
	);
	const adjustable: string[] = [];
	if (o.serviceTiers.length > 1) adjustable.push(`Service tier: ${o.serviceTiers.join(', ')}`);
	if (o.regions.length > 1) adjustable.push(`Region: ${o.regions.join(', ')}`);
	if (o.ttl1h) adjustable.push('Cache write TTL: 5m, 1h');
	if (o.batch) adjustable.push('Batch API job');
	if (long) {
		adjustable.push(
			`Long context: prompt over ${long.threshold.toLocaleString()} tokens (${long.lines
				.map(l => `${LINE_LABELS[l.lineItem].toLowerCase()} ${Number(l.factor.toPrecision(3))}×`)
				.join(', ')})`
		);
	}
	if (o.cacheRead) adjustable.push('Cache read tokens');
	if (o.webSearch) adjustable.push('Web searches (per request)');
	return { defaults, adjustable };
}
