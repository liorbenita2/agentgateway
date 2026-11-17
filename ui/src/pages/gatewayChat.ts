import type { DumpModel } from '@/gateway-admin';

// Matches requestableDumpModelNames: public concrete models and virtual models.
function requestable(model: DumpModel) {
	return !('concrete' in model.kind) || model.kind.concrete.visibility === 'public';
}

/** The models people can call: the iap listener's when there is one, else every caller listener's; no wildcards. */
export function gatewayChatModels(models: DumpModel[]) {
	const iap = models.filter(model => model.listenerKey.endsWith('.iap'));
	const source = iap.length ? iap : models.filter(model => !model.listenerKey.endsWith('.models'));
	const byName = new Map<string, DumpModel>();
	for (const model of source) {
		if (requestable(model) && !model.name.includes('*') && !byName.has(model.name)) {
			byName.set(model.name, model);
		}
	}
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function gatewayChatModelNames(models: DumpModel[]) {
	return gatewayChatModels(models).map(model => model.name);
}

export type ChatApi = 'completions' | 'responses' | 'messages';

export const CHAT_APIS: Array<{ value: ChatApi; label: string; path: string }> = [
	{ value: 'completions', label: 'Chat Completions', path: '/chat/completions' },
	{ value: 'responses', label: 'Responses', path: '/responses' },
	{ value: 'messages', label: 'Messages', path: '/messages' }
];

export type ChatTurn = { role: 'user' | 'assistant'; text: string; images?: string[] };

export type ChatSettings = {
	system: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	stop: string[];
};

export type ChatUsage = { input?: number; output?: number };

export type StreamState = { content: string; reasoning: string; usage: ChatUsage; model?: string };

export const newStreamState = (): StreamState => ({ content: '', reasoning: '', usage: {} });

function dataUrlParts(url: string) {
	const match = /^data:([^;,]+);base64,(.*)$/.exec(url);
	return match ? { mediaType: match[1], data: match[2] } : null;
}

/** The body for one turn of the conversation on the chosen API, streaming. */
export function buildChatRequest(
	api: ChatApi,
	model: string,
	turns: ChatTurn[],
	settings: ChatSettings
): { path: string; headers: Record<string, string>; body: Record<string, unknown> } {
	const path = CHAT_APIS.find(item => item.value === api)?.path ?? '/chat/completions';
	const system = settings.system.trim();
	const sampling = {
		...(settings.temperature != null ? { temperature: settings.temperature } : {}),
		...(settings.topP != null ? { top_p: settings.topP } : {})
	};
	if (api === 'messages') {
		return {
			path,
			headers: { 'anthropic-version': '2023-06-01' },
			body: {
				model,
				stream: true,
				max_tokens: settings.maxTokens ?? 4096,
				...(system ? { system } : {}),
				...sampling,
				...(settings.stop.length ? { stop_sequences: settings.stop } : {}),
				messages: turns.map(turn => ({
					role: turn.role,
					content: turn.images?.length
						? [
								...turn.images.flatMap(url => {
									const image = dataUrlParts(url);
									return image
										? [
												{
													type: 'image',
													source: { type: 'base64', media_type: image.mediaType, data: image.data }
												}
											]
										: [];
								}),
								...(turn.text ? [{ type: 'text', text: turn.text }] : [])
							]
						: turn.text
				}))
			}
		};
	}
	if (api === 'responses') {
		return {
			path,
			headers: {},
			body: {
				model,
				stream: true,
				...(system ? { instructions: system } : {}),
				...(settings.maxTokens != null ? { max_output_tokens: settings.maxTokens } : {}),
				...sampling,
				input: turns.map(turn =>
					turn.role === 'user' && turn.images?.length
						? {
								role: 'user',
								content: [
									...(turn.text ? [{ type: 'input_text', text: turn.text }] : []),
									...turn.images.map(url => ({ type: 'input_image', image_url: url }))
								]
							}
						: { role: turn.role, content: turn.text }
				)
			}
		};
	}
	return {
		path,
		headers: {},
		body: {
			model,
			stream: true,
			stream_options: { include_usage: true },
			...(settings.maxTokens != null ? { max_tokens: settings.maxTokens } : {}),
			...sampling,
			...(settings.stop.length ? { stop: settings.stop } : {}),
			messages: [
				...(system ? [{ role: 'system', content: system }] : []),
				...turns.map(turn =>
					turn.images?.length
						? {
								role: turn.role,
								content: [
									...(turn.text ? [{ type: 'text', text: turn.text }] : []),
									...turn.images.map(url => ({ type: 'image_url', image_url: { url } }))
								]
							}
						: { role: turn.role, content: turn.text }
				)
			]
		}
	};
}

export type SseEvent = { event?: string; data: string };

/** Splits buffered SSE text into complete events and the unfinished rest. */
export function splitSse(buffer: string): { events: SseEvent[]; rest: string } {
	const blocks = buffer.split(/\r?\n\r?\n/);
	const rest = blocks.pop() ?? '';
	const events: SseEvent[] = [];
	for (const block of blocks) {
		let event: string | undefined;
		const data: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith('event:')) event = line.slice(6).trim();
			else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
		}
		if (data.length) events.push({ event, data: data.join('\n') });
	}
	return { events, rest };
}

// biome-ignore lint/suspicious/noExplicitAny: SSE payloads of three APIs, read defensively
type Json = Record<string, any>;

function errorMessage(error: unknown) {
	if (typeof error === 'string') return error;
	const message = (error as Json | undefined)?.message;
	return typeof message === 'string' ? message : JSON.stringify(error);
}

/** Folds one SSE event of the chosen API into the state; returns true when the stream is done. */
export function applyStreamEvent(api: ChatApi, state: StreamState, sse: SseEvent): boolean {
	const payload = sse.data.trim();
	if (!payload) return false;
	if (payload === '[DONE]') return true;
	const event = JSON.parse(payload) as Json;
	const type: string = event.type ?? sse.event ?? '';
	if (event.error || type === 'error') throw new Error(errorMessage(event.error ?? event));
	if (api === 'messages') {
		if (type === 'message_start') {
			state.model = event.message?.model ?? state.model;
			state.usage.input = event.message?.usage?.input_tokens ?? state.usage.input;
		} else if (type === 'content_block_delta') {
			if (event.delta?.type === 'text_delta') state.content += event.delta.text ?? '';
			if (event.delta?.type === 'thinking_delta') state.reasoning += event.delta.thinking ?? '';
		} else if (type === 'message_delta') {
			state.usage.output = event.usage?.output_tokens ?? state.usage.output;
			if (event.usage?.input_tokens) state.usage.input = event.usage.input_tokens;
		} else if (type === 'message_stop') {
			return true;
		}
		return false;
	}
	if (api === 'responses') {
		if (type === 'response.output_text.delta') state.content += event.delta ?? '';
		else if (
			type === 'response.reasoning_summary_text.delta' ||
			type === 'response.reasoning_text.delta'
		) {
			state.reasoning += event.delta ?? '';
		} else if (type === 'response.failed' || type === 'response.incomplete') {
			const reason = event.response?.error ?? event.response?.incomplete_details;
			if (type === 'response.failed') throw new Error(errorMessage(reason ?? 'response failed'));
		}
		const response = event.response as Json | undefined;
		if (response?.model) state.model = response.model;
		if (response?.usage) {
			state.usage = { input: response.usage.input_tokens, output: response.usage.output_tokens };
		}
		return type === 'response.completed';
	}
	if (event.model) state.model = event.model;
	if (event.usage) {
		state.usage = { input: event.usage.prompt_tokens, output: event.usage.completion_tokens };
	}
	for (const choice of event.choices ?? []) {
		if (choice.delta?.content) state.content += choice.delta.content;
		if (choice.delta?.reasoning_content) state.reasoning += choice.delta.reasoning_content;
	}
	return false;
}

// Images become a placeholder so the snippet stays readable.
function snippetBody(body: Record<string, unknown>) {
	return JSON.stringify(
		body,
		function (this: Record<string, unknown>, key, value) {
			if (key === 'data' && this.type === 'base64') return '<base64>';
			return typeof value === 'string' && value.startsWith('data:')
				? 'data:image/...;base64,...'
				: value;
		},
		2
	);
}

/** curl and Python for the same call, through the tools host with an IAP token. */
export function chatCodeSnippets(api: ChatApi, baseUrl: string, body: Record<string, unknown>) {
	const path = CHAT_APIS.find(item => item.value === api)?.path ?? '/chat/completions';
	const project = /tools\.([a-z]+-[a-z0-9]+)\.ai21\.com/.exec(baseUrl)?.[1];
	const tokenCmd = `ai21 --yes iap-token --project ${project ? `${project}-main` : '<gcp-project>'}`;
	const json = snippetBody(body);
	const curl = [
		`IAP=$(${tokenCmd} | tail -1)`,
		`curl -N ${baseUrl}${path} \\`,
		'  -H "Proxy-Authorization: Bearer $IAP" \\',
		"  -H 'Content-Type: application/json' \\",
		...(api === 'messages' ? ["  -H 'anthropic-version: 2023-06-01' \\"] : []),
		`  -d '${json.replaceAll("'", "'\\''")}'`
	].join('\n');
	const { messages, input, model, stream, stream_options, ...rest } = body as Json;
	const kwargs = Object.entries(rest)
		.map(([key, value]) => `    ${key}=${JSON.stringify(value)},`)
		.join('\n');
	const pyJson = (value: unknown) =>
		snippetBody(value as Record<string, unknown>)
			.replaceAll('true', 'True')
			.replaceAll('false', 'False')
			.replaceAll('null', 'None');
	const header = [
		'import subprocess',
		'',
		`iap = subprocess.check_output(${JSON.stringify(tokenCmd.split(' '))}, text=True).strip().splitlines()[-1]`
	];
	const python =
		api === 'messages'
			? [
					'import anthropic',
					...header,
					'client = anthropic.Anthropic(',
					`    base_url=${JSON.stringify(baseUrl.replace(/\/v1$/, ''))},`,
					'    api_key="none",',
					'    default_headers={"Proxy-Authorization": f"Bearer {iap}"},',
					')',
					'with client.messages.stream(',
					`    model=${JSON.stringify(model)},`,
					kwargs,
					`    messages=${pyJson(messages)},`,
					') as stream:',
					'    for text in stream.text_stream:',
					'        print(text, end="", flush=True)'
				].join('\n')
			: [
					'from openai import OpenAI',
					...header,
					'client = OpenAI(',
					`    base_url=${JSON.stringify(baseUrl)},`,
					'    api_key="none",',
					'    default_headers={"Proxy-Authorization": f"Bearer {iap}"},',
					')',
					api === 'responses'
						? [
								'stream = client.responses.create(',
								`    model=${JSON.stringify(model)},`,
								kwargs,
								`    input=${pyJson(input)},`,
								'    stream=True,',
								')',
								'for event in stream:',
								'    if event.type == "response.output_text.delta":',
								'        print(event.delta, end="", flush=True)'
							].join('\n')
						: [
								'stream = client.chat.completions.create(',
								`    model=${JSON.stringify(model)},`,
								kwargs,
								`    messages=${pyJson(messages)},`,
								'    stream=True,',
								')',
								'for chunk in stream:',
								'    if chunk.choices and chunk.choices[0].delta.content:',
								'        print(chunk.choices[0].delta.content, end="", flush=True)'
							].join('\n')
				].join('\n');
	return { curl, python: python.replace(/\n\n+/g, '\n').replace(/^(import subprocess)$/m, '$1\n') };
}

const messagesSchema = {
	type: 'array',
	items: {
		type: 'object',
		required: ['role', 'content'],
		properties: {
			role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
			content: {
				oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }]
			}
		}
	}
};

/** OpenAPI 3.1 for the model APIs this gateway serves, with its routed names as the model enum. */
export function gatewayOpenApi(args: {
	serverUrl: string;
	models: string[];
	listingPath?: string;
}) {
	const model = {
		type: 'string',
		description: 'A routed model name. Names outside the list may still match a wildcard route.',
		...(args.models.length ? { examples: args.models, default: args.models[0] } : {})
	};
	const firstModel = args.models[0] ?? 'model-name';
	const json = (schema: object, example: object) => ({
		required: true,
		content: { 'application/json': { schema, example } }
	});
	const ok = (description: string) => ({
		description,
		content: { 'application/json': { schema: { type: 'object' } } }
	});
	const errors = {
		'400': { description: 'The provider refused the request' },
		'401': { description: 'No IAP identity (call through the tools host)' },
		'404': { description: 'No route for this model name' },
		'429': { description: 'Daily token cap or provider rate limit reached' }
	};
	const paths: Record<string, object> = {
		'/v1/chat/completions': {
			post: {
				tags: ['OpenAI'],
				summary: 'Chat Completions',
				operationId: 'chatCompletions',
				requestBody: json(
					{
						type: 'object',
						required: ['model', 'messages'],
						properties: {
							model,
							messages: messagesSchema,
							max_tokens: { type: 'integer' },
							temperature: { type: 'number' },
							stream: { type: 'boolean' },
							tools: { type: 'array', items: { type: 'object' } }
						}
					},
					{ model: firstModel, messages: [{ role: 'user', content: 'Say hi.' }], max_tokens: 1024 }
				),
				responses: { '200': ok('Chat completion, or an SSE stream when stream is true'), ...errors }
			}
		},
		'/v1/messages': {
			post: {
				tags: ['Anthropic'],
				summary: 'Messages',
				operationId: 'messages',
				requestBody: json(
					{
						type: 'object',
						required: ['model', 'messages', 'max_tokens'],
						properties: {
							model,
							messages: messagesSchema,
							max_tokens: { type: 'integer' },
							system: { type: 'string' },
							stream: { type: 'boolean' }
						}
					},
					{ model: firstModel, max_tokens: 1024, messages: [{ role: 'user', content: 'Say hi.' }] }
				),
				responses: { '200': ok('Message'), ...errors }
			}
		},
		'/v1/responses': {
			post: {
				tags: ['OpenAI'],
				summary: 'Responses',
				operationId: 'responses',
				requestBody: json(
					{
						type: 'object',
						required: ['model', 'input'],
						properties: {
							model,
							input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }] },
							max_output_tokens: { type: 'integer' },
							stream: { type: 'boolean' }
						}
					},
					{ model: firstModel, input: 'Say hi.', max_output_tokens: 1024 }
				),
				responses: { '200': ok('Response'), ...errors }
			}
		}
	};
	if (args.listingPath) {
		paths[args.listingPath] = {
			get: {
				tags: ['Models'],
				summary: 'Routed models',
				operationId: 'listModels',
				responses: { '200': ok('Every model name this gateway routes') }
			}
		};
	}
	return {
		openapi: '3.1.0',
		info: {
			title: 'AI21 agentgateway',
			version: '1',
			description:
				"Model APIs of this cluster's agentgateway. Through the tools host IAP names you, so no key is needed; the call is billed to the ai21 cost center with your email."
		},
		servers: [{ url: args.serverUrl }],
		paths
	};
}
