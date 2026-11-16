import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DumpModel } from '#gateway-admin.d.ts';
import {
	applyStreamEvent,
	buildChatRequest,
	type ChatApi,
	type ChatTurn,
	chatCodeSnippets,
	gatewayChatModelNames,
	gatewayOpenApi,
	newStreamState,
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

test('splits SSE into complete events with their names and keeps the unfinished rest', () => {
	const { events, rest } = splitSse(
		'event: message_start\ndata: {"a":1}\n\n: ping\n\ndata: [DONE]\n\ndata: {"b"'
	);
	assert.deepEqual(events, [
		{ event: 'message_start', data: '{"a":1}' },
		{ event: undefined, data: '[DONE]' }
	]);
	assert.equal(rest, 'data: {"b"');
});

const feed = (api: ChatApi, events: unknown[]) => {
	const state = newStreamState();
	let done = false;
	for (const event of events)
		done = applyStreamEvent(api, state, { data: JSON.stringify(event) }) || done;
	return { state, done };
};

test('chat completions: content, reasoning, model, usage; [DONE] ends it', () => {
	const { state } = feed('completions', [
		{ model: 'm', choices: [{ delta: { reasoning_content: 'think' } }] },
		{ choices: [{ delta: { content: 'Hi' } }] },
		{ choices: [{ delta: { content: ' there' } }] },
		{ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }
	]);
	assert.deepEqual(state, {
		content: 'Hi there',
		reasoning: 'think',
		model: 'm',
		usage: { input: 3, output: 2 }
	});
	assert.equal(applyStreamEvent('completions', state, { data: '[DONE]' }), true);
});

test('responses: text and reasoning deltas, usage on response.completed', () => {
	const { state, done } = feed('responses', [
		{ type: 'response.created', response: { model: 'gpt-x' } },
		{ type: 'response.reasoning_summary_text.delta', delta: 'plan' },
		{ type: 'response.output_text.delta', delta: 'Hel' },
		{ type: 'response.output_text.delta', delta: 'lo' },
		{
			type: 'response.completed',
			response: { model: 'gpt-x', usage: { input_tokens: 5, output_tokens: 7 } }
		}
	]);
	assert.equal(done, true);
	assert.deepEqual(state, {
		content: 'Hello',
		reasoning: 'plan',
		model: 'gpt-x',
		usage: { input: 5, output: 7 }
	});
});

test('messages: text and thinking deltas, usage from start and delta, done on message_stop', () => {
	const { state, done } = feed('messages', [
		{ type: 'message_start', message: { model: 'claude', usage: { input_tokens: 9 } } },
		{ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
		{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Yo' } },
		{ type: 'message_delta', usage: { output_tokens: 4 } },
		{ type: 'message_stop' }
	]);
	assert.equal(done, true);
	assert.deepEqual(state, {
		content: 'Yo',
		reasoning: 'hmm',
		model: 'claude',
		usage: { input: 9, output: 4 }
	});
});

test('an error event throws its message on every API', () => {
	for (const api of ['completions', 'responses', 'messages'] as const) {
		assert.throws(
			() =>
				applyStreamEvent(api, newStreamState(), {
					data: '{"type":"error","error":{"message":"cap reached"}}'
				}),
			/cap reached/
		);
	}
	assert.throws(
		() =>
			applyStreamEvent('responses', newStreamState(), {
				data: '{"type":"response.failed","response":{"error":{"message":"bad"}}}'
			}),
		/bad/
	);
});

const image = 'data:image/png;base64,AAAA';
const turns: ChatTurn[] = [
	{ role: 'user', text: 'what is this', images: [image] },
	{ role: 'assistant', text: 'a cat' },
	{ role: 'user', text: 'sure?' }
];
const settings = { system: 'be brief', maxTokens: 100, temperature: 0.5, stop: ['END'] };

test('chat completions body: system first, image_url parts, stop, usage in the stream', () => {
	const { path, body } = buildChatRequest('completions', 'm', turns, settings);
	assert.equal(path, '/chat/completions');
	assert.deepEqual(body, {
		model: 'm',
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 100,
		temperature: 0.5,
		stop: ['END'],
		messages: [
			{ role: 'system', content: 'be brief' },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'what is this' },
					{ type: 'image_url', image_url: { url: image } }
				]
			},
			{ role: 'assistant', content: 'a cat' },
			{ role: 'user', content: 'sure?' }
		]
	});
});

test('responses body: instructions, max_output_tokens, input_image parts, no stop', () => {
	const { path, body } = buildChatRequest('responses', 'm', turns, settings);
	assert.equal(path, '/responses');
	assert.deepEqual(body, {
		model: 'm',
		stream: true,
		instructions: 'be brief',
		max_output_tokens: 100,
		temperature: 0.5,
		input: [
			{
				role: 'user',
				content: [
					{ type: 'input_text', text: 'what is this' },
					{ type: 'input_image', image_url: image }
				]
			},
			{ role: 'assistant', content: 'a cat' },
			{ role: 'user', content: 'sure?' }
		]
	});
});

test('messages body: base64 image blocks, stop_sequences, anthropic-version header', () => {
	const { path, headers, body } = buildChatRequest('messages', 'm', turns, {
		...settings,
		maxTokens: undefined
	});
	assert.equal(path, '/messages');
	assert.deepEqual(headers, { 'anthropic-version': '2023-06-01' });
	assert.deepEqual(body, {
		model: 'm',
		stream: true,
		max_tokens: 4096,
		system: 'be brief',
		temperature: 0.5,
		stop_sequences: ['END'],
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
					{ type: 'text', text: 'what is this' }
				]
			},
			{ role: 'assistant', content: 'a cat' },
			{ role: 'user', content: 'sure?' }
		]
	});
});

test('code snippets call the route with the IAP token and hide image data', () => {
	const { body } = buildChatRequest('messages', 'm', turns, settings);
	const { curl, python } = chatCodeSnippets(
		'messages',
		'https://tools.algo-dev.ai21.com/agentgateway/v1',
		body
	);
	assert.match(curl, /--project algo-dev-main/);
	assert.match(curl, /agentgateway\/v1\/messages/);
	assert.match(curl, /anthropic-version: 2023-06-01/);
	assert.doesNotMatch(curl, /AAAA/);
	assert.match(python, /base_url="https:\/\/tools\.algo-dev\.ai21\.com\/agentgateway"/);
	assert.match(python, /client\.messages\.stream\(/);
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
