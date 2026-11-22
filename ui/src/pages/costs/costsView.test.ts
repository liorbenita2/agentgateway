import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	chartRows,
	chartSeries,
	formatUsd,
	groupLabel,
	OTHER,
	seriesColor,
	shortDate,
	withFilter
} from '#pages/costs/costsView.ts';

test('the costliest seven groups stack by name, the rest fold into Other', () => {
	const groups = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
	const series = chartSeries({ groups });
	assert.deepEqual(series, ['a', 'b', 'c', 'd', 'e', 'f', 'g', OTHER]);
	assert.equal(seriesColor(series, 'a'), 'var(--cost-series-1)');
	assert.equal(seriesColor(series, 'g'), 'var(--cost-series-7)');
	assert.equal(seriesColor(series, OTHER), 'var(--cost-series-other)');
	const rows = chartRows({
		groups,
		dates: ['2026-11-21', '2026-11-22'],
		rows: [
			{ dt: '2026-11-22', key: 'a', cost_usd: 2, requests: 1 },
			{ dt: '2026-11-22', key: 'h', cost_usd: 1, requests: 1 },
			{ dt: '2026-11-22', key: 'i', cost_usd: 0.5, requests: 1 }
		]
	});
	assert.equal(rows.length, 2);
	assert.equal(rows[0].a, 0);
	assert.equal(rows[1].a, 2);
	assert.equal(rows[1][OTHER], 1.5);
});

test('few groups have no Other', () => {
	assert.deepEqual(chartSeries({ groups: ['ai21', 'deel'] }), ['ai21', 'deel']);
});

test('filters toggle', () => {
	const one = withFilter({}, 'client', 'deel');
	assert.deepEqual(one, { client: 'deel' });
	assert.deepEqual(withFilter(one, 'model', ''), { client: 'deel', model: '' });
	assert.deepEqual(withFilter(one, 'client', null), {});
});

test('formatting', () => {
	assert.equal(formatUsd(1234.5), '$1,234.50');
	assert.equal(formatUsd(0), '$0');
	assert.equal(formatUsd(0.00042), '$0.00042');
	assert.equal(formatUsd(null), '—');
	assert.equal(groupLabel(''), '(not set)');
	assert.equal(shortDate('2026-11-02'), '2 Nov');
});
