import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DumpModel } from '#gateway-admin.d.ts';
import {
	applyStreamEvent,
	gatewayChatModelNames,
	gatewayOpenApi,
	type StreamState,
	splitSse
} from '#pages/gatewayChat.ts';

function model(name: string, listener: string, visibility = 'public'): DumpModel {
	return {
		name,
		listenerKey: `infra/ai21-agentgateway.${listener}`,
		key: name,
		routerKey: 'r',
		kind: { concrete: { visibility } }
	} as unknown as DumpModel;
}

test('picks the iap listener models, drops wildcards, internal names and duplicates', () => {
	const names = gatewayChatModelNames([
		model('gpt-5', 'iap'),
		model('claude-*', 'iap'),
		model('hidden', 'iap', 'internal'),
		model('gpt-5', 'iap'),
		model('a-model', 'iap'),
		model('only-on-http', 'http'),
		model('vllm-x', 'models')
	]);
	assert.deepEqual(names, ['a-model', 'gpt-5']);
});

test('falls back to caller listeners, never the models listener', () => {
	assert.deepEqual(gatewayChatModelNames([model('b', 'http'), model('vllm-x', 'models')]), ['b']);
});

test('splits SSE into complete data payloads and keeps the unfinished rest', () => {
	const { events, rest } = splitSse('data: {"a":1}\n\n: ping\n\ndata: [DONE]\n\ndata: {"b"');
	assert.deepEqual(events, ['{"a":1}', '[DONE]']);
	assert.equal(rest, 'data: {"b"');
});

test('folds content, reasoning, model and usage; stops on [DONE]', () => {
	const state: StreamState = { content: '', reasoning: '' };
	applyStreamEvent(state, '{"model":"m","choices":[{"delta":{"reasoning_content":"think"}}]}');
	applyStreamEvent(state, '{"choices":[{"delta":{"content":"Hi"}}]}');
	applyStreamEvent(state, '{"choices":[{"delta":{"content":" there"}}]}');
	applyStreamEvent(state, '{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}');
	assert.equal(applyStreamEvent(state, '[DONE]'), true);
	assert.deepEqual(state, {
		content: 'Hi there',
		reasoning: 'think',
		model: 'm',
		usage: { prompt_tokens: 3, completion_tokens: 2 }
	});
});

test('an error event in the stream throws its message', () => {
	assert.throws(
		() => applyStreamEvent({ content: '', reasoning: '' }, '{"error":{"message":"cap reached"}}'),
		/cap reached/
	);
});

test('OpenAPI lists the model APIs with routed names, and the listing only when served', () => {
	const spec = gatewayOpenApi({ serverUrl: 'https://tools.x/agentgateway', models: ['a', 'b'] });
	assert.deepEqual(Object.keys(spec.paths), [
		'/v1/chat/completions',
		'/v1/messages',
		'/v1/responses'
	]);
	assert.deepEqual(spec.servers, [{ url: 'https://tools.x/agentgateway' }]);
	const body = JSON.stringify(spec.paths['/v1/chat/completions']);
	assert.match(body, /"examples":\["a","b"\]/);
	const withListing = gatewayOpenApi({
		serverUrl: '',
		models: [],
		listingPath: '/api/v1/endpoints'
	});
	assert.ok('/api/v1/endpoints' in withListing.paths);
});
