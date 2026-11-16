import type { DumpModel } from '@/gateway-admin';

// Matches requestableDumpModelNames: public concrete models and virtual models.
function requestable(model: DumpModel) {
	return !('concrete' in model.kind) || model.kind.concrete.visibility === 'public';
}

/** Names people can pick: the iap listener's models when there is one, else every listener's; no wildcards. */
export function gatewayChatModelNames(models: DumpModel[]) {
	const iap = models.filter(model => model.listenerKey.endsWith('.iap'));
	const source = iap.length ? iap : models.filter(model => !model.listenerKey.endsWith('.models'));
	const names = new Set(
		source.filter(model => requestable(model) && !model.name.includes('*')).map(model => model.name)
	);
	return [...names].sort((left, right) => left.localeCompare(right));
}

export type ChatUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
};

export type StreamState = { content: string; reasoning: string; usage?: ChatUsage; model?: string };

/** Folds one SSE `data:` payload of a chat completions stream into the state; returns true on [DONE]. */
export function applyStreamEvent(state: StreamState, data: string): boolean {
	const payload = data.trim();
	if (!payload) return false;
	if (payload === '[DONE]') return true;
	const event = JSON.parse(payload) as {
		model?: string;
		usage?: ChatUsage | null;
		error?: { message?: string };
		choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null } }>;
	};
	if (event.error) throw new Error(event.error.message ?? JSON.stringify(event.error));
	if (event.model) state.model = event.model;
	if (event.usage) state.usage = event.usage;
	for (const choice of event.choices ?? []) {
		if (choice.delta?.content) state.content += choice.delta.content;
		if (choice.delta?.reasoning_content) state.reasoning += choice.delta.reasoning_content;
	}
	return false;
}

/** Splits buffered SSE text into complete `data:` payloads and the unfinished rest. */
export function splitSse(buffer: string): { events: string[]; rest: string } {
	const blocks = buffer.split(/\r?\n\r?\n/);
	const rest = blocks.pop() ?? '';
	const events = blocks.flatMap(block =>
		block
			.split(/\r?\n/)
			.filter(line => line.startsWith('data:'))
			.map(line => line.slice(5).trimStart())
	);
	return { events, rest };
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
