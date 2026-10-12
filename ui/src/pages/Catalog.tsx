import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
	type CatalogRates,
	type CatalogResponse,
	type CatalogTier,
	getCatalog
} from '@/api/pricesApi';
import { EmptyState, PageHeader, Panel, StatusBanner } from '@/components/Primitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import { PROVIDER_ICONS, PROVIDER_LABELS, type PriceProvider } from '@/pages/models/pricing';

// agentgateway provider names in the catalog -> the models page's provider keys.
const CATALOG_PROVIDERS: Record<string, PriceProvider> = {
	openai: 'openai',
	anthropic: 'anthropic',
	'gcp.vertex_ai': 'vertex',
	'gcp.gemini': 'gemini',
	'aws.bedrock': 'bedrock',
	togetherai: 'together'
};

const RATE_COLUMNS: Array<{ key: keyof CatalogRates; label: string }> = [
	{ key: 'input', label: 'Input' },
	{ key: 'output', label: 'Output' },
	{ key: 'cacheRead', label: 'Cache read' },
	{ key: 'cacheWrite', label: 'Write 5m' },
	{ key: 'cacheWrite1h', label: 'Write 1h' }
];

interface Row {
	provider: string;
	model: string;
	rates?: CatalogRates;
	tiers: CatalogTier[];
}

function rows(catalog: CatalogResponse): Row[] {
	const out: Row[] = [];
	for (const [provider, p] of Object.entries(catalog.providers)) {
		for (const [model, entry] of Object.entries(p.models)) {
			out.push({ provider, model, rates: entry.rates, tiers: entry.tiers ?? [] });
		}
	}
	return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

function tierLabel(tier: CatalogTier) {
	const parts = [tier.serviceTier, tier.region].filter(Boolean) as string[];
	if (tier.contextOver) parts.push(`over ${formatTokens(tier.contextOver)}`);
	return parts.join(' · ');
}

// agentgateway 1.6 bills only the standard, global price and its long-context bands.
function billedByGateway(tier: CatalogTier) {
	return !tier.serviceTier && !tier.region;
}

function formatTokens(n: number) {
	return n >= 1000 ? `${Number((n / 1000).toPrecision(6))}k` : String(n);
}

function money(value?: string) {
	return value ? `$${Number(value)}` : '—';
}

export function CatalogPage() {
	const [search, setSearch] = useState('');
	const [provider, setProvider] = useState('all');
	const query = useQuery({
		queryKey: ['ai21-model-catalog'],
		queryFn: getCatalog,
		retry: false,
		staleTime: 5 * 60_000
	});
	const all = useMemo(() => (query.data ? rows(query.data) : []), [query.data]);
	const providers = useMemo(() => [...new Set(all.map(r => r.provider))], [all]);
	const needle = search.trim().toLowerCase();
	const visible = all.filter(
		r => (provider === 'all' || r.provider === provider) && r.model.toLowerCase().includes(needle)
	);
	const variants = all.reduce((n, r) => n + r.tiers.length, 0);

	return (
		<div className="page-stack">
			<PageHeader
				title="AI21 model catalog"
				description="Every price OpenRouter lists for each model the gateway routes, refreshed hourly by the price job into the ai21-model-catalog ConfigMap: standard rates plus service tiers, regions and long-context bands. $ per 1M tokens."
			/>
			{query.isError ? (
				<StatusBanner state="warn" title="Catalog unavailable">
					{(query.error as Error).message}. The price job writes it on its first run.
				</StatusBanner>
			) : null}
			<Panel>
				{query.isLoading ? (
					<StatusBanner state="loading" title="Loading the catalog" />
				) : !all.length ? (
					<EmptyState title="No models" description="The catalog has no priced models yet." />
				) : (
					<>
						<div className="price-route-bar">
							<div className="catalog-filters">
								<select
									aria-label="Provider"
									value={provider}
									onChange={e => setProvider(e.target.value)}
								>
									<option value="all">All providers ({all.length})</option>
									{providers.map(p => (
										<option key={p} value={p}>
											{PROVIDER_LABELS[CATALOG_PROVIDERS[p] ?? 'other']} (
											{all.filter(r => r.provider === p).length})
										</option>
									))}
								</select>
								<input
									type="search"
									placeholder="Filter models"
									aria-label="Filter models"
									value={search}
									onChange={e => setSearch(e.target.value)}
								/>
							</div>
							<small>
								{all.length} models, {variants} tier/region/long-context variants. Muted variants
								are not billed by agentgateway 1.6 yet (only standard, global and its long-context
								bands are); the full set is our upstream catalog proposal.
							</small>
						</div>
						<div className="table-wrap">
							<table className="dump-models-table price-table catalog-table">
								<thead>
									<tr>
										<th>Model</th>
										<th>Provider</th>
										<th>Variant</th>
										{RATE_COLUMNS.map(c => (
											<th key={c.key} className="numeric">
												{c.label}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{visible.map(r => {
										const p = CATALOG_PROVIDERS[r.provider] ?? 'other';
										return [
											<tr key={`${r.provider}/${r.model}`} className="catalog-model">
												<td>
													<strong>{r.model}</strong>
												</td>
												<td>
													<span className="price-provider">
														<ProviderIcon provider={PROVIDER_ICONS[p]} />
														{PROVIDER_LABELS[p]}
													</span>
												</td>
												<td>
													<span className="badge">standard</span>
												</td>
												{RATE_COLUMNS.map(c => (
													<td key={c.key} className="numeric">
														{money(r.rates?.[c.key])}
													</td>
												))}
											</tr>,
											...r.tiers.map(tier => (
												<tr
													key={`${r.provider}/${r.model}/${tierLabel(tier)}`}
													className="catalog-tier"
												>
													<td className="catalog-tier-cell" />
													<td className="catalog-tier-cell" />
													<td className="catalog-tier-cell">
														<span className={billedByGateway(tier) ? 'badge' : 'badge muted'}>
															{tierLabel(tier)}
														</span>
													</td>
													{RATE_COLUMNS.map(c => (
														<td key={c.key} className="numeric catalog-tier-cell">
															{money(tier.rates[c.key])}
														</td>
													))}
												</tr>
											))
										];
									})}
								</tbody>
							</table>
						</div>
					</>
				)}
			</Panel>
		</div>
	);
}
