import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DumpModel } from '#gateway-admin.d.ts';
import { uniqueModels } from '#pages/models/dumpModels.ts';

function model(name: string, listener: string): DumpModel {
	return {
		name,
		listenerKey: `infra/ai21-agentgateway.${listener}`,
		key: `infra/ai21-agentgateway-${name}.${listener}`,
		routerKey: '',
		kind: {
			concrete: {
				name,
				visibility: 'public',
				backend: { weight: 1, backend: `infra/ai21-agentgateway-${name}/backend.${listener}` },
				policies: { llm: { transformations: { model: `"${name}-upstream"` } } }
			}
		}
	} as unknown as DumpModel;
}

const MODELS = [
	model('claude-fable-5', 'iap'),
	model('claude-fable-5', 'http'),
	model('iap-only', 'iap'),
	model('vllm-x', 'models'),
	model('vllm-x', 'http')
];

test('the iap listener repeats port 80 models; each name is listed once, from port 80', () => {
	const listed = uniqueModels(MODELS);
	assert.deepEqual(
		listed.map(m => [m.name, m.listenerKey.split('.').pop()]),
		[
			['claude-fable-5', 'http'],
			['vllm-x', 'http'],
			['iap-only', 'iap'],
			['vllm-x', 'models']
		]
	);
});
