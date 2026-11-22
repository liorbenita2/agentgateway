import { useQuery } from '@tanstack/react-query';
import {
	SegmentedControl,
	SegmentedControlIndicator,
	SegmentedControlItem
} from '@ui-sdk/react/segmented-control';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectItemIndicator,
	SelectTrigger,
	SelectValue
} from '@ui-sdk/react/select';
import { Check, ChevronDown, Filter, X } from 'lucide-react';
import { useMemo } from 'react';
import {
	Bar,
	BarChart,
	CartesianGrid,
	Tooltip as RechartsTooltip,
	ResponsiveContainer,
	XAxis,
	YAxis
} from 'recharts';

import {
	COST_DAYS,
	COST_FILTERS,
	COST_GROUPS,
	type CostFilter,
	type CostFilters,
	type CostGroup,
	getCostDaily,
	getCostRequests,
	getCostSummary,
	PRICE_SOURCES,
	type PriceSource
} from '@/api/gatewayCostsApi';
import { EmptyState, formatNumber, PageHeader, Panel, StatusBanner } from '@/components/Primitives';
import { useStoredStringState } from '@/hooks';
import '@/styles/ai21.css';
import {
	chartRows,
	chartSeries,
	formatUsd,
	groupLabel,
	seriesColor,
	shortDate,
	withFilter
} from '@/pages/costs/costsView';

const GROUP_LABELS: Record<CostGroup, string> = {
	client: 'Client',
	cost_center: 'Cost center',
	model: 'Model',
	upstream: 'Upstream',
	user: 'User',
	price_source: 'Price source'
};

const SOURCE_HELP: Record<PriceSource, string> = {
	catalog:
		'Priced from ai21-model-catalog (OpenRouter) at the price version live when the request ran.',
	gateway: "Not in the catalog; agentgateway's own llm.cost price.",
	'self-hosted': 'Our own models (upstream central): $0 here, GPU cost is not counted.',
	'no-usage': 'The response reported no tokens (errors, cancelled streams): $0.',
	unpriced: 'Tokens but no price anywhere: $0 until the catalog has the model.'
};

const FETCH = { retry: 1, staleTime: 60_000, refetchOnWindowFocus: false } as const;

export function GatewayCostsPage() {
	const [daysText, setDaysText] = useStoredStringState('ai21.costs.days', '7');
	const [groupText, setGroupText] = useStoredStringState('ai21.costs.groupBy', 'client');
	const [filtersText, setFiltersText] = useStoredStringState('ai21.costs.filters', '{}');
	const days = COST_DAYS.find(d => String(d) === daysText) ?? 7;
	const groupBy = (COST_GROUPS as readonly string[]).includes(groupText)
		? (groupText as CostGroup)
		: 'client';
	const filters = useMemo(() => parseFilters(filtersText), [filtersText]);
	const setFilters = (next: CostFilters) => setFiltersText(JSON.stringify(next));

	const summary = useQuery({
		queryKey: ['ai21-costs', 'summary', days, groupBy, filters],
		queryFn: () => getCostSummary(days, groupBy, filters),
		...FETCH
	});
	const daily = useQuery({
		queryKey: ['ai21-costs', 'daily', days, groupBy, filters],
		queryFn: () => getCostDaily(days, groupBy, filters),
		...FETCH
	});
	const requests = useQuery({
		queryKey: ['ai21-costs', 'requests', days, filters],
		queryFn: () => getCostRequests(days, 50, filters),
		...FETCH
	});

	const series = useMemo(() => (daily.data ? chartSeries(daily.data) : []), [daily.data]);
	const rows = useMemo(() => (daily.data ? chartRows(daily.data) : []), [daily.data]);
	const filterable = (COST_FILTERS as readonly string[]).includes(groupBy)
		? (groupBy as CostFilter)
		: null;
	const error = summary.error ?? daily.error;

	return (
		<div className="page-stack">
			<PageHeader
				title="Costs"
				description="Spend per request through this gateway, from BigQuery's gateway_usage.v_gateway_costs, priced with ai21-model-catalog. Self-hosted GPU cost is not included."
			/>
			<Panel className="costs-controls">
				<div className="costs-control-row">
					<Seg
						label="Date range"
						value={String(days)}
						onChange={setDaysText}
						options={COST_DAYS.map(d => ({
							value: String(d),
							label: d === 1 ? 'Today' : `${d} days`
						}))}
					/>
					<div className="costs-group-by">
						<span>Group by</span>
						<Select
							value={groupBy}
							onValueChange={value => {
								if (typeof value === 'string') setGroupText(value);
							}}
						>
							<SelectTrigger className="ai21-select" aria-label="Group by">
								<SelectValue />
								<ChevronDown size={14} aria-hidden="true" />
							</SelectTrigger>
							<SelectContent>
								{COST_GROUPS.map(g => (
									<SelectItem key={g} value={g}>
										{GROUP_LABELS[g]}
										<SelectItemIndicator>
											<Check size={14} aria-hidden="true" />
										</SelectItemIndicator>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="costs-chips">
						{Object.entries(filters).map(([name, value]) => (
							<span key={name} className="costs-chip">
								{GROUP_LABELS[name as CostGroup]}: <strong>{groupLabel(value ?? '')}</strong>
								<button
									type="button"
									aria-label={`Remove ${GROUP_LABELS[name as CostGroup]} filter`}
									onClick={() => setFilters(withFilter(filters, name as CostFilter, null))}
								>
									<X size={12} aria-hidden="true" />
								</button>
							</span>
						))}
						{Object.keys(filters).length ? null : (
							<small>
								No filters. Group by client, cost center, model or upstream and pick a row to filter
								on it.
							</small>
						)}
					</div>
				</div>
			</Panel>

			{error ? (
				<StatusBanner state="bad" title="Costs unavailable">
					{errorText(error)}
				</StatusBanner>
			) : null}

			<div className="costs-stats">
				<Stat label="Total" value={summary.data ? formatUsd(summary.data.total.cost_usd) : '…'} />
				<Stat
					label="Requests"
					value={summary.data ? formatNumber(summary.data.total.requests) : '…'}
				/>
				<Stat
					label="Window (UTC)"
					value={
						summary.data ? `${shortDate(summary.data.from)} – ${shortDate(summary.data.to)}` : '…'
					}
				/>
				<Stat
					label="Updated"
					value={summary.data ? new Date(summary.data.updated_at).toLocaleTimeString() : '…'}
					hint="Results are cached for 10 minutes."
				/>
			</div>

			<Panel>
				<h3 className="costs-title">Daily cost by {GROUP_LABELS[groupBy].toLowerCase()}</h3>
				{daily.isLoading ? (
					<StatusBanner state="loading" title="Querying BigQuery">
						The first query of a window can take up to a minute.
					</StatusBanner>
				) : daily.data?.rows.length ? (
					<>
						<div className="costs-legend">
							{series.map(key => (
								<span key={key}>
									<i style={{ background: seriesColor(series, key) }} />
									{groupLabel(key)}
								</span>
							))}
						</div>
						<div className="costs-chart">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
									<CartesianGrid stroke="var(--line)" strokeDasharray="4 4" vertical={false} />
									<XAxis
										dataKey="dt"
										axisLine={false}
										tickLine={false}
										tickFormatter={value => shortDate(String(value))}
										tick={{ fill: 'var(--muted)', fontSize: 12 }}
									/>
									<YAxis
										axisLine={false}
										tickLine={false}
										width={64}
										tickFormatter={value => formatUsd(Number(value))}
										tick={{ fill: 'var(--muted)', fontSize: 12 }}
									/>
									<RechartsTooltip
										cursor={{ fill: 'var(--line)', opacity: 0.4 }}
										content={<ChartTooltip series={series} />}
									/>
									{series.map((key, index) => (
										<Bar
											key={key}
											dataKey={key}
											stackId="cost"
											fill={seriesColor(series, key)}
											stroke="var(--surface)"
											strokeWidth={2}
											maxBarSize={48}
											radius={index === series.length - 1 ? [4, 4, 0, 0] : 0}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							</ResponsiveContainer>
						</div>
					</>
				) : daily.data ? (
					<EmptyState
						title="No requests"
						description="Nothing matches this window and these filters."
					/>
				) : null}
			</Panel>

			<div className="costs-split">
				<Panel>
					<h3 className="costs-title">Totals by {GROUP_LABELS[groupBy].toLowerCase()}</h3>
					{summary.data ? (
						<div className="table-wrap">
							<table className="price-table costs-table">
								<thead>
									<tr>
										<th>{GROUP_LABELS[groupBy]}</th>
										<th className="numeric">Cost</th>
										<th className="numeric">Share</th>
										<th className="numeric">Requests</th>
										<th className="numeric">Unpriced</th>
										{filterable ? <th aria-label="Filter" /> : null}
									</tr>
								</thead>
								<tbody>
									{summary.data.groups.map(g => {
										const unpriced = g.by_source.unpriced?.requests ?? 0;
										const total = summary.data.total.cost_usd;
										return (
											<tr key={g.key}>
												<td>
													<span className="costs-key">
														<i style={{ background: seriesColor(series, g.key) }} />
														{groupLabel(g.key)}
													</span>
												</td>
												<td className="numeric">{formatUsd(g.cost_usd)}</td>
												<td className="numeric">
													{total ? `${((100 * g.cost_usd) / total).toFixed(1)}%` : '—'}
												</td>
												<td className="numeric">{formatNumber(g.requests)}</td>
												<td className="numeric">{unpriced ? formatNumber(unpriced) : ''}</td>
												{filterable ? (
													<td className="numeric">
														<button
															type="button"
															className="costs-filter-button"
															aria-label={`Filter on ${groupLabel(g.key)}`}
															title={`Only ${groupLabel(g.key)}`}
															onClick={() => setFilters(withFilter(filters, filterable, g.key))}
														>
															<Filter size={13} aria-hidden="true" />
														</button>
													</td>
												) : null}
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					) : null}
				</Panel>
				<Panel>
					<h3 className="costs-title">Price source</h3>
					<ul className="costs-sources">
						{PRICE_SOURCES.map(source => {
							const amount = summary.data?.sources.find(s => s.price_source === source);
							return (
								<li key={source}>
									<span className={`costs-source costs-source-${source}`}>{source}</span>
									<span className="costs-source-amount">
										{amount
											? `${formatUsd(amount.cost_usd)} · ${formatNumber(amount.requests)} req`
											: ''}
									</span>
									<small>{SOURCE_HELP[source]}</small>
								</li>
							);
						})}
					</ul>
				</Panel>
			</div>

			<Panel>
				<h3 className="costs-title">Latest requests</h3>
				{requests.isLoading ? (
					<StatusBanner state="loading" title="Querying BigQuery" />
				) : requests.error ? (
					<StatusBanner state="bad" title="Requests unavailable">
						{errorText(requests.error)}
					</StatusBanner>
				) : requests.data?.rows.length ? (
					<div className="table-wrap">
						<table className="price-table costs-table">
							<thead>
								<tr>
									<th>Time (UTC)</th>
									<th>Client</th>
									<th>Cost center</th>
									<th>User</th>
									<th>Model</th>
									<th>Upstream</th>
									<th className="numeric">In</th>
									<th className="numeric">Cached</th>
									<th className="numeric">Out</th>
									<th className="numeric">Cost</th>
									<th>Source</th>
									<th className="numeric">Status</th>
								</tr>
							</thead>
							<tbody>
								{requests.data.rows.map(r => (
									<tr key={r.span_id}>
										<td className="costs-mono">{r.ts.slice(5, 19).replace('T', ' ')}</td>
										<td>{r.client}</td>
										<td>{r.cost_center ?? ''}</td>
										<td className="costs-user">{r.user ?? ''}</td>
										<td>{r.model ?? ''}</td>
										<td>{r.upstream ?? ''}</td>
										<td className="numeric">{formatNumber(r.uncached_input_tokens)}</td>
										<td className="numeric">
											{formatNumber((r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0))}
										</td>
										<td className="numeric">{formatNumber(r.output_tokens)}</td>
										<td className="numeric">{formatUsd(r.cost_usd)}</td>
										<td>
											<span className={`costs-source costs-source-${r.price_source}`}>
												{r.price_source}
											</span>
										</td>
										<td className="numeric">{r.http_status ?? ''}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState
						title="No requests"
						description="Nothing matches this window and these filters."
					/>
				)}
			</Panel>
		</div>
	);
}

function parseFilters(text: string): CostFilters {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(raw).filter(
				([k, v]) => (COST_FILTERS as readonly string[]).includes(k) && typeof v === 'string'
			)
		) as CostFilters;
	} catch {
		return {};
	}
}

function errorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	try {
		const body = JSON.parse(message) as { error?: string };
		return body.error ?? message;
	} catch {
		return message;
	}
}

function Stat(props: { label: string; value: string; hint?: string }) {
	return (
		<div className="costs-stat" title={props.hint}>
			<span>{props.label}</span>
			<strong>{props.value}</strong>
		</div>
	);
}

function Seg(props: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
}) {
	return (
		<SegmentedControl
			aria-label={props.label}
			className="ai21-seg"
			value={props.value}
			onValueChange={value => {
				if (value) props.onChange(String(value));
			}}
		>
			<SegmentedControlIndicator />
			{props.options.map(option => (
				<SegmentedControlItem key={option.value} value={option.value}>
					{option.label}
				</SegmentedControlItem>
			))}
		</SegmentedControl>
	);
}

function ChartTooltip(props: {
	series: string[];
	active?: boolean;
	label?: string | number;
	payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>;
}) {
	if (!props.active || !props.payload?.length) return null;
	const values = props.payload
		.map(p => ({ key: String(p.dataKey), value: Number(p.value) || 0 }))
		.filter(p => p.value > 0)
		.sort((a, b) => b.value - a.value);
	const total = values.reduce((sum, v) => sum + v.value, 0);
	return (
		<div className="costs-tooltip">
			<strong>
				{shortDate(String(props.label))} · {formatUsd(total)}
			</strong>
			{values.map(v => (
				<div key={v.key}>
					<i style={{ background: seriesColor(props.series, v.key) }} />
					<span>{groupLabel(v.key)}</span>
					<b>{formatUsd(v.value)}</b>
				</div>
			))}
		</div>
	);
}
