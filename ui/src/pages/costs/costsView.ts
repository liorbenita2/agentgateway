// Self-contained (no app imports) so node --test runs it; shapes match api/gatewayCostsApi.ts.
type CostFilter = 'client' | 'cost_center' | 'model' | 'upstream';
type CostFilters = Partial<Record<CostFilter, string>>;
interface CostDaily {
	dates: string[];
	groups: string[];
	rows: Array<{ dt: string; key: string; cost_usd: number; requests: number }>;
}

// Categorical slots, light and dark (styles/ai21.css --cost-series-N); past the last, groups fold into Other.
export const SERIES_SLOTS = 7;
export const OTHER = 'Other';

export type ChartRow = { dt: string } & Record<string, number | string>;

// Keys the chart stacks: the costliest groups in the window, then Other for the rest.
export function chartSeries(daily: Pick<CostDaily, 'groups'>): string[] {
	const top = daily.groups.slice(0, SERIES_SLOTS);
	return daily.groups.length > SERIES_SLOTS ? [...top, OTHER] : top;
}

// One row per date in the window (empty days included) with USD per stacked key.
export function chartRows(daily: Pick<CostDaily, 'dates' | 'groups' | 'rows'>): ChartRow[] {
	const series = chartSeries(daily);
	const shown = new Set(series);
	const byDate = new Map<string, ChartRow>(
		daily.dates.map(dt => [dt, { dt, ...Object.fromEntries(series.map(s => [s, 0])) }])
	);
	for (const row of daily.rows) {
		const out = byDate.get(row.dt);
		if (!out) continue;
		const key = shown.has(row.key) ? row.key : OTHER;
		out[key] = (out[key] as number) + row.cost_usd;
	}
	return [...byDate.values()];
}

export function seriesColor(series: string[], key: string): string {
	const index = series.indexOf(key);
	return key === OTHER || index < 0 || index >= SERIES_SLOTS
		? 'var(--cost-series-other)'
		: `var(--cost-series-${index + 1})`;
}

export function groupLabel(key: string): string {
	return key === '' ? '(not set)' : key;
}

export function withFilter(
	filters: CostFilters,
	name: CostFilter,
	value: string | null
): CostFilters {
	return Object.fromEntries([
		...Object.entries(filters).filter(([k]) => k !== name),
		...(value === null ? [] : [[name, value]])
	]) as CostFilters;
}

export function formatUsd(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	if (value === 0) return '$0';
	if (Math.abs(value) < 0.01) return `$${value.toPrecision(2)}`;
	return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(iso: string): string {
	const [, month, day] = iso.split('-');
	return `${Number(day)} ${MONTHS[Number(month) - 1]}`;
}
