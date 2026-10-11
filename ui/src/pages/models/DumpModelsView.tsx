import { useQuery } from '@tanstack/react-query';
import { Calculator, HelpCircle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { listRates } from '@/api/pricesApi';
import {
	Drawer,
	EmptyState,
	Field,
	Panel,
	SegmentedControl,
	StatusBanner,
	Tooltip,
	YamlBlock
} from '@/components/Primitives';
import { ProviderIcon } from '@/components/ProviderIcon';
import { useStickyQueryParam } from '@/drawerRouteState';
import type { DumpModel, StoresDump, VirtualModelRouting } from '@/gateway-admin';
import {
	API_ROUTES,
	type ApiRoute,
	baseRow,
	calculate,
	defaultParams,
	describeDefaults,
	fitParams,
	indexRates,
	longTier,
	PROVIDER_ICONS,
	PROVIDER_LABELS,
	type PricedModel,
	type PriceParams,
	paramOptions,
	perMillion,
	priceModels
} from '@/pages/models/pricing';
import { routeBackendLabel } from '@/pages/traffic/TrafficConfigDumpPanel';

const COLUMN_HELP: Record<string, string> = {
	input:
		'Uncached prompt tokens, $ per 1M. Standard tier, base context, global region; the playground prices the others.',
	output: 'Generated tokens, $ per 1M. Reasoning and thinking tokens are billed as output.',
	cacheRead:
		'Prompt tokens served from the provider cache, $ per 1M. Anthropic marks them with cache_control; OpenAI, Gemini and Together cache automatically.',
	write5m:
		'Tokens written to the cache with the default 5-minute TTL (Anthropic cache_control without ttl), $ per 1M.',
	write1h:
		'Writes with cache_control.ttl "1h", $ per 1M. agentgateway\'s own llm.cost prices these at the 5m rate; the invoice and our cost views use this one.',
	long: 'Prompt size above which the whole request is billed at the long-context rates (shown as the input multiplier). Our BigQuery cost rollup prices base context only.',
	routes:
		'API paths the gateway accepts for this model. Native means the provider speaks that API; the rest are translated by agentgateway.'
};

export function DumpModelsView(props: { dump: StoresDump }) {
	const [selectedKey, setSelectedKey] = useStickyQueryParam('model');
	const [route, setRoute] = useState<ApiRoute>('completions');
	const ratesQuery = useQuery({
		queryKey: ['prices'],
		queryFn: listRates,
		retry: false,
		staleTime: 5 * 60_000
	});
	const rateIndex = useMemo(
		() => (ratesQuery.data ? indexRates(ratesQuery.data.rates) : null),
		[ratesQuery.data]
	);
	const priced = useMemo(() => priceModels(props.dump, rateIndex), [props.dump, rateIndex]);
	const counts = useMemo(() => {
		const out = new Map<ApiRoute, number>();
		for (const model of priced) {
			for (const support of model.routes) {
				out.set(support.route, (out.get(support.route) ?? 0) + 1);
			}
		}
		return out;
	}, [priced]);
	const visible = priced
		.filter(model => model.routes.some(support => support.route === route))
		.sort(
			(a, b) => a.provider.localeCompare(b.provider) || a.model.name.localeCompare(b.model.name)
		);
	const selected = priced.find(model => model.model.key === selectedKey);
	const routeInfo = API_ROUTES.find(r => r.value === route);

	return (
		<>
			{ratesQuery.isError ? (
				<StatusBanner state="warn" title="Prices unavailable">
					config-service rates could not be loaded: {(ratesQuery.error as Error).message}
				</StatusBanner>
			) : null}
			<Panel>
				{!priced.length ? (
					<EmptyState
						title="No models"
						description="No models are present in the active gateway dump."
					/>
				) : (
					<>
						<div className="price-route-bar">
							<SegmentedControl
								ariaLabel="API route"
								value={route}
								onChange={setRoute}
								options={API_ROUTES.filter(r => counts.get(r.value)).map(r => ({
									value: r.value,
									label: `${r.label} (${counts.get(r.value)})`
								}))}
							/>
							<small>
								{routeInfo?.path}
								{ratesQuery.data
									? ` · prices from config-service, fetched ${new Date(ratesQuery.data.fetched_at).toLocaleString()}`
									: null}
							</small>
						</div>
						<div className="table-wrap">
							<table className="dump-models-table price-table">
								<thead>
									<tr>
										<th>Model</th>
										<th>Provider</th>
										<HeaderTip label="Route" help={COLUMN_HELP.routes} />
										<HeaderTip label="Input" help={COLUMN_HELP.input} numeric />
										<HeaderTip label="Output" help={COLUMN_HELP.output} numeric />
										<HeaderTip label="Cache read" help={COLUMN_HELP.cacheRead} numeric />
										<HeaderTip label="Write 5m" help={COLUMN_HELP.write5m} numeric />
										<HeaderTip label="Write 1h" help={COLUMN_HELP.write1h} numeric />
										<HeaderTip label="Long context" help={COLUMN_HELP.long} numeric />
										<th aria-label="Actions" />
									</tr>
								</thead>
								<tbody>
									{visible.map(model => (
										<ModelRow
											key={model.model.key}
											model={model}
											route={route}
											onOpen={() => setSelectedKey(model.model.key)}
										/>
									))}
								</tbody>
							</table>
						</div>
					</>
				)}
			</Panel>

			{selected ? (
				<Drawer
					title={selected.model.name}
					headerActions={<span className="badge">{PROVIDER_LABELS[selected.provider]}</span>}
					onClose={() => setSelectedKey(null)}
				>
					<div className="drawer-summary-list">
						<div>
							<span>Provider model</span>
							<strong>{selected.upstream}</strong>
						</div>
						<div>
							<span>Routes</span>
							<strong>
								{selected.routes
									.map(
										r =>
											`${API_ROUTES.find(a => a.value === r.route)?.label}${r.native ? '' : ' (translated)'}`
									)
									.join(', ') || '—'}
							</strong>
						</div>
						<div>
							<span>Target</span>
							<strong>{modelTarget(selected.model).summary}</strong>
						</div>
						<div>
							<span>Rate card</span>
							<strong>{selected.rates ? selected.rates.slug : '—'}</strong>
						</div>
					</div>
					<PricePlayground key={selected.model.key} model={selected} />
					<details className="price-yaml">
						<summary>Model YAML</summary>
						<YamlBlock value={selected.model} />
					</details>
				</Drawer>
			) : null}
		</>
	);
}

function HeaderTip(props: { label: string; help: string; numeric?: boolean }) {
	return (
		<th className={props.numeric ? 'numeric' : undefined}>
			<span className="price-th">
				{props.label}
				<Tooltip content={props.help} side="bottom">
					{/** biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the tooltip. */}
					<span className="help-icon" role="img" tabIndex={0} aria-label={props.help}>
						<HelpCircle size={13} aria-hidden="true" />
					</span>
				</Tooltip>
			</span>
		</th>
	);
}

function ModelRow(props: { model: PricedModel; route: ApiRoute; onOpen: () => void }) {
	const { model } = props;
	const support = model.routes.find(r => r.route === props.route);
	const rates = model.rates;
	const long = rates ? longTier(rates) : null;
	return (
		<tr>
			<td>
				<div className="resource-name-cell">
					<span className="price-th">
						<strong>{model.model.name}</strong>
						{rates ? <DefaultsTip model={model} /> : null}
					</span>
					{model.upstream !== model.model.name ? <small>{model.upstream}</small> : null}
				</div>
			</td>
			<td>
				<span className="price-provider">
					<ProviderIcon provider={PROVIDER_ICONS[model.provider]} />
					{PROVIDER_LABELS[model.provider]}
				</span>
			</td>
			<td>
				<span className={support?.native ? 'badge' : 'badge muted'}>
					{support?.native ? 'native' : 'translated'}
				</span>
			</td>
			{rates ? (
				<>
					<PriceCell value={perMillion(baseRow(rates, 'input'))} />
					<PriceCell value={perMillion(baseRow(rates, 'output'))} />
					<PriceCell value={perMillion(baseRow(rates, 'cache_read'))} />
					<PriceCell value={perMillion(baseRow(rates, 'cache_write_5m'))} />
					<PriceCell value={perMillion(baseRow(rates, 'cache_write_1h'))} />
					<td className="numeric">
						{long ? `>${formatTokens(long.threshold)} · ${trimNumber(long.inputFactor)}×` : '—'}
					</td>
				</>
			) : (
				<td colSpan={6} className="price-missing">
					{unpricedReason(model)}
				</td>
			)}
			<td className="row-actions">
				<Tooltip content="Price playground">
					<button
						className="icon-button"
						type="button"
						aria-label={`Price ${model.model.name}`}
						onClick={props.onOpen}
					>
						<Calculator size={16} />
					</button>
				</Tooltip>
			</td>
		</tr>
	);
}

function DefaultsTip(props: { model: PricedModel }) {
	const rates = props.model.rates;
	if (!rates) return null;
	const { defaults, adjustable } = describeDefaults(rates, props.model.provider);
	const label = `${PROVIDER_LABELS[props.model.provider]} · ${props.model.upstream}`;
	return (
		<Tooltip
			side="right"
			content={
				<div className="price-tip">
					<strong>{label}</strong>
					<span>Prices shown with</span>
					<ul>
						{defaults.map(line => (
							<li key={line}>{line}</li>
						))}
					</ul>
					{adjustable.length ? (
						<>
							<span>The playground can change</span>
							<ul>
								{adjustable.map(line => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</>
					) : null}
				</div>
			}
		>
			<button
				className="help-icon price-tip-button"
				type="button"
				aria-label={`Default price params for ${label}`}
			>
				<HelpCircle size={13} aria-hidden="true" />
			</button>
		</Tooltip>
	);
}

function PriceCell(props: { value: number | null }) {
	return <td className="numeric">{props.value === null ? '—' : `$${trimNumber(props.value)}`}</td>;
}

function unpricedReason(model: PricedModel) {
	if (model.provider === 'self-hosted') return 'Self-hosted on our GPUs: no per-token bill ($0).';
	if (model.provider === 'vercel') return 'Not on the rate card; billed by Vercel AI Gateway.';
	if (model.pattern) return 'Name pattern: priced per concrete model it matches.';
	if (!('concrete' in model.model.kind)) return 'Virtual model: priced by its targets.';
	return 'Not on the config-service rate card.';
}

function PricePlayground(props: { model: PricedModel }) {
	const { model } = props;
	const [params, setParams] = useState<PriceParams>(() => defaultParams(model.provider));
	const rates = model.rates;
	if (!rates) {
		return (
			<div className="price-playground">
				<span className="field-label">Price playground</span>
				<p className="price-missing">{unpricedReason(model)}</p>
			</div>
		);
	}
	const options = paramOptions(rates);
	const fitted = fitParams(rates, params);
	const result = calculate(rates, fitted);
	const set = <K extends keyof PriceParams>(key: K, value: PriceParams[K]) => {
		setParams(current => ({ ...current, [key]: value }));
	};

	return (
		<div className="price-playground">
			<span className="field-label price-th">
				Price playground
				<DefaultsTip model={model} />
			</span>
			<div className="price-params">
				<NumberField
					label="Input tokens"
					tooltip="Uncached prompt tokens."
					value={params.inputTokens}
					onChange={v => set('inputTokens', v)}
				/>
				{options.cacheRead ? (
					<NumberField
						label="Cache read tokens"
						tooltip="Prompt tokens served from cache. They count toward the long-context threshold."
						value={params.cacheReadTokens}
						onChange={v => set('cacheReadTokens', v)}
					/>
				) : null}
				{options.cacheWrite ? (
					<NumberField
						label="Cache write tokens"
						tooltip="Prompt tokens written to cache on this request. They count toward the long-context threshold."
						value={params.cacheWriteTokens}
						onChange={v => set('cacheWriteTokens', v)}
					/>
				) : null}
				<NumberField
					label="Output tokens"
					tooltip="Generated tokens, including reasoning/thinking."
					value={params.outputTokens}
					onChange={v => set('outputTokens', v)}
				/>
				{options.webSearch ? (
					<NumberField
						label="Web searches"
						tooltip="Server-side web search calls, billed per request on top of tokens."
						value={params.webSearches}
						onChange={v => set('webSearches', v)}
					/>
				) : null}
				{options.ttl1h ? (
					<Field
						label="Cache TTL"
						tooltip='cache_control.ttl on the request. "5m" is the default; "1h" costs more per written token but survives longer gaps between calls.'
					>
						<SegmentedControl
							ariaLabel="Cache TTL"
							value={fitted.ttl}
							onChange={v => set('ttl', v)}
							options={[
								{ value: '5m', label: '5 min' },
								{ value: '1h', label: '1 hour' }
							]}
						/>
					</Field>
				) : null}
				{options.serviceTiers.length > 1 ? (
					<Field
						label="Service tier"
						tooltip="service_tier on the request (OpenAI flex/priority, Gemini). Flex is cheaper and slower; priority costs more for lower latency."
					>
						<select
							value={fitted.serviceTier}
							disabled={fitted.batch}
							onChange={e => set('serviceTier', e.target.value)}
						>
							{options.serviceTiers.map(tier => (
								<option key={tier} value={tier}>
									{tier}
								</option>
							))}
						</select>
					</Field>
				) : null}
				{options.regions.length > 1 ? (
					<Field
						label="Region"
						tooltip="Where the provider serves the request. Regional endpoints (Vertex us/europe, Bedrock regions) can cost more than global."
					>
						<select value={fitted.region} onChange={e => set('region', e.target.value)}>
							{options.regions.map(region => (
								<option key={region} value={region}>
									{region}
								</option>
							))}
						</select>
					</Field>
				) : null}
				{options.batch ? (
					<Field
						label="Batch"
						tooltip="Batch API jobs: asynchronous, usually half price. Not used by gateway traffic."
					>
						<span className="price-check">
							<input
								type="checkbox"
								checked={fitted.batch}
								onChange={e => set('batch', e.target.checked)}
							/>
							Batch API job
						</span>
					</Field>
				) : null}
			</div>

			<div className="table-wrap">
				<table className="price-lines">
					<thead>
						<tr>
							<th>Line</th>
							<th className="numeric">Quantity</th>
							<th className="numeric">Rate</th>
							<th className="numeric">Cost</th>
						</tr>
					</thead>
					<tbody>
						{result.lines.map(line => (
							<tr key={line.label}>
								<td>
									{line.label}
									{line.note ? <small> · {line.note}</small> : null}
								</td>
								<td className="numeric">{line.quantity.toLocaleString()}</td>
								<td className="numeric">
									{line.rate === null
										? '—'
										: line.unit === 'token'
											? `$${trimNumber(line.rate)}/1M`
											: `$${trimNumber(line.rate)}/${line.unit}`}
								</td>
								<td className="numeric">{formatUsd(line.cost)}</td>
							</tr>
						))}
					</tbody>
					<tfoot>
						<tr className="price-total">
							<td className="price-total-cell">
								Total · {result.promptTokens.toLocaleString()} prompt tokens, {result.contextTier}{' '}
								context
							</td>
							<td className="price-total-cell" />
							<td className="price-total-cell" />
							<td className="numeric price-total-cell">
								<strong>{formatUsd(result.total)}</strong>
							</td>
						</tr>
					</tfoot>
				</table>
			</div>

			{result.divergences.length || result.warnings.length ? (
				<div className="price-notes">
					<span className="field-label">Where our numbers differ from the invoice</span>
					<ul>
						{result.divergences.map(d => (
							<li key={d.title}>
								<strong>{d.title}</strong> · {d.source}: {d.delta > 0 ? '+' : ''}
								{formatUsd(d.delta)} vs the invoice. {d.detail}
							</li>
						))}
						{result.warnings.map(w => (
							<li key={w}>{w}</li>
						))}
					</ul>
				</div>
			) : null}

			<div className="price-actions">
				<button
					className="button"
					type="button"
					onClick={() => setParams(defaultParams(model.provider))}
				>
					Back to defaults
				</button>
			</div>
		</div>
	);
}

function NumberField(props: {
	label: string;
	tooltip: string;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<Field label={props.label} tooltip={props.tooltip}>
			<input
				type="number"
				min={0}
				step={1000}
				value={props.value}
				onChange={e => props.onChange(Math.max(0, Number(e.target.value) || 0))}
			/>
		</Field>
	);
}

function trimNumber(value: number) {
	return Number(value.toPrecision(6)).toString();
}

function formatTokens(value: number) {
	return value >= 1000 ? `${trimNumber(value / 1000)}k` : String(value);
}

function formatUsd(value: number) {
	const abs = Math.abs(value);
	const digits = abs === 0 || abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
	return `${value < 0 ? '-' : ''}$${abs.toFixed(digits)}`;
}

function modelTarget(model: DumpModel): { summary: string; detail?: string } {
	if ('concrete' in model.kind) {
		return { summary: routeBackendLabel(model.kind.concrete.backend) };
	}
	return virtualRoutingTarget(model.kind.virtual.routing);
}

function virtualRoutingTarget(routing: VirtualModelRouting): { summary: string; detail?: string } {
	if ('weighted' in routing) {
		const count = routing.weighted.length;
		return { summary: `${count} weighted ${count === 1 ? 'target' : 'targets'}` };
	}
	if ('conditional' in routing) {
		const rules = routing.conditional.filter(target => target.when?.trim()).length;
		return { summary: `${rules} ${rules === 1 ? 'rule' : 'rules'}` };
	}
	return { summary: 'Failover' };
}
