import { Bot, ImagePlus, Loader2, Send, Square, User, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

import { apiBase } from '@/api/base';
import {
	Dropdown,
	Field,
	FieldGroup,
	PageHeader,
	Panel,
	StatusBanner
} from '@/components/Primitives';
import type { StoresDump } from '@/gateway-admin';
import { useStoredStringState } from '@/hooks';
import {
	applyStreamEvent,
	type ChatUsage,
	gatewayChatModelNames,
	type StreamState,
	splitSse
} from '@/pages/gatewayChat';

type ContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

type Turn = {
	role: 'user' | 'assistant';
	text: string;
	images?: string[];
	reasoning?: string;
	usage?: ChatUsage;
	model?: string;
	ms?: number;
};

// The tools host sends <apiBase>/v1/* to the gateway's iap listener (IAP names the caller, no key needed).
export const gatewayModelsBase = `${apiBase}/v1`;

export function GatewayPlayground(props: { dump: StoresDump | null }) {
	const models = useMemo(() => gatewayChatModelNames(props.dump?.models ?? []), [props.dump]);
	const [storedModel, setModel] = useStoredStringState('gatewayPlaygroundModel', '');
	const model = models.includes(storedModel) ? storedModel : (models[0] ?? '');
	const [system, setSystem] = useState('');
	const [temperature, setTemperature] = useState('');
	const [maxTokens, setMaxTokens] = useState('4096');
	const [prompt, setPrompt] = useState('');
	const [images, setImages] = useState<string[]>([]);
	const [turns, setTurns] = useState<Turn[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const abort = useRef<AbortController | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);

	async function addImages(files: FileList | null) {
		const urls = await Promise.all(
			[...(files ?? [])]
				.filter(file => file.type.startsWith('image/'))
				.map(
					file =>
						new Promise<string>((resolve, reject) => {
							const reader = new FileReader();
							reader.onload = () => resolve(String(reader.result));
							reader.onerror = () => reject(reader.error);
							reader.readAsDataURL(file);
						})
				)
		);
		setImages(current => [...current, ...urls]);
	}

	async function send() {
		const text = prompt.trim();
		if (!model || (!text && images.length === 0) || loading) return;
		const userTurn: Turn = { role: 'user', text, images };
		const history = [...turns, userTurn];
		setTurns(history);
		setPrompt('');
		setImages([]);
		setError(null);
		setLoading(true);
		const controller = new AbortController();
		abort.current = controller;
		const started = performance.now();
		const state: StreamState = { content: '', reasoning: '' };
		const show = () =>
			setTurns([
				...history,
				{
					role: 'assistant',
					text: state.content,
					reasoning: state.reasoning,
					usage: state.usage,
					model: state.model,
					ms: Math.round(performance.now() - started)
				}
			]);
		try {
			const response = await fetch(`${gatewayModelsBase}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: controller.signal,
				body: JSON.stringify({
					model,
					stream: true,
					stream_options: { include_usage: true },
					...(maxTokens.trim() ? { max_tokens: Number(maxTokens) } : {}),
					...(temperature.trim() ? { temperature: Number(temperature) } : {}),
					messages: [
						...(system.trim() ? [{ role: 'system', content: system.trim() }] : []),
						...history.map(toOpenAi)
					]
				})
			});
			if (!response.ok || !response.body) {
				throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let done = false;
			while (!done) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value, { stream: true });
				const { events, rest } = splitSse(buffer);
				buffer = rest;
				for (const event of events) done = applyStreamEvent(state, event) || done;
				show();
			}
			show();
		} catch (err) {
			if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
			if (state.content || state.reasoning) show();
		} finally {
			setLoading(false);
			abort.current = null;
		}
	}

	return (
		<div className="page-stack">
			<PageHeader
				title="Chat Playground"
				description={`Chat with any model this gateway routes. Calls go to ${gatewayModelsBase}/chat/completions; IAP names you, so no key is needed.`}
			/>
			{models.length === 0 ? (
				<StatusBanner state="warn" title="No routed models found in the config dump" />
			) : null}
			{error ? (
				<StatusBanner state="bad" title="Request failed">
					{error}
				</StatusBanner>
			) : null}
			<section className="playground-shell">
				<Panel className="playground-config-panel">
					<div className="section-heading">
						<h3>Configuration</h3>
					</div>
					<div className="playground-setup-bar">
						<div className="playground-control-row">
							<FieldGroup label="Model">
								<Dropdown
									ariaLabel="Model"
									value={model}
									placeholder="No models"
									searchable
									options={models.map(name => ({ value: name, label: name, searchText: name }))}
									onChange={setModel}
								/>
							</FieldGroup>
							<div aria-hidden="true" />
						</div>
						<div className="playground-control-row">
							<Field label="Max tokens">
								<input
									inputMode="numeric"
									value={maxTokens}
									onChange={event => setMaxTokens(event.target.value.replace(/\D/g, ''))}
								/>
							</Field>
							<Field label="Temperature" hint="Empty uses the provider default.">
								<input
									inputMode="decimal"
									value={temperature}
									onChange={event => setTemperature(event.target.value)}
								/>
							</Field>
						</div>
					</div>
					<Field label="System prompt">
						<textarea rows={3} value={system} onChange={event => setSystem(event.target.value)} />
					</Field>
				</Panel>
				<Panel className="playground-chat-panel">
					<div className="mini-chat">
						{turns.length === 0 ? <div className="chat-empty">No messages yet.</div> : null}
						{turns.map((turn, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
							<TurnView turn={turn} key={index} />
						))}
						{loading && turns.at(-1)?.role === 'user' ? (
							<div className="chat-message assistant pending">
								<div className="chat-avatar">
									<Bot size={16} />
								</div>
								<div className="chat-bubble">
									<Loader2 className="spin" size={15} />
									Waiting for the first token
								</div>
							</div>
						) : null}
					</div>
					{images.length ? (
						<div className="button-row">
							{images.map((url, index) => (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: removal is by position
									key={index}
									type="button"
									className="button"
									title="Remove image"
									onClick={() => setImages(current => current.filter((_, i) => i !== index))}
								>
									<img src={url} alt="" style={{ height: 32 }} />
									<X size={14} />
								</button>
							))}
						</div>
					) : null}
					<Field label="User message">
						<textarea
							rows={5}
							value={prompt}
							onChange={event => setPrompt(event.target.value)}
							onPaste={event => {
								if (event.clipboardData.files.length) void addImages(event.clipboardData.files);
							}}
							onKeyDown={event => {
								if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
									event.preventDefault();
									void send();
								}
							}}
							placeholder="Ask something. Paste or attach images for vision models."
						/>
					</Field>
					<div className="button-row">
						{loading ? (
							<button className="button" type="button" onClick={() => abort.current?.abort()}>
								<Square size={16} />
								Stop
							</button>
						) : (
							<button
								className="button primary"
								type="button"
								disabled={!model || (!prompt.trim() && images.length === 0)}
								onClick={() => void send()}
							>
								<Send size={16} />
								Send
							</button>
						)}
						<button className="button" type="button" onClick={() => fileInput.current?.click()}>
							<ImagePlus size={16} />
							Image
						</button>
						<input
							ref={fileInput}
							type="file"
							accept="image/*"
							multiple
							hidden
							onChange={event => {
								void addImages(event.target.files);
								event.target.value = '';
							}}
						/>
						<button
							className="button"
							type="button"
							disabled={loading || turns.length === 0}
							onClick={() => {
								setTurns([]);
								setError(null);
							}}
						>
							Clear
						</button>
					</div>
				</Panel>
			</section>
		</div>
	);
}

function toOpenAi(turn: Turn) {
	if (!turn.images?.length) return { role: turn.role, content: turn.text };
	const parts: ContentPart[] = [
		...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
		...turn.images.map(url => ({ type: 'image_url' as const, image_url: { url } }))
	];
	return { role: turn.role, content: parts };
}

function TurnView(props: { turn: Turn }) {
	const { turn } = props;
	const Icon = turn.role === 'assistant' ? Bot : User;
	const meta = [
		turn.model,
		turn.usage?.prompt_tokens != null ? `${turn.usage.prompt_tokens} in` : null,
		turn.usage?.completion_tokens != null ? `${turn.usage.completion_tokens} out` : null,
		turn.ms != null ? `${(turn.ms / 1000).toFixed(1)}s` : null
	].filter(Boolean);
	return (
		<div className={`chat-message ${turn.role}`}>
			<div className="chat-avatar">
				<Icon size={16} />
			</div>
			<div className="chat-bubble">
				{turn.reasoning ? (
					<details className="message-inspector">
						<summary>Reasoning</summary>
						<div style={{ whiteSpace: 'pre-wrap' }}>{turn.reasoning}</div>
					</details>
				) : null}
				{turn.images?.map((url, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: images of one turn never reorder
					<img key={index} src={url} alt="" style={{ maxHeight: 160, display: 'block' }} />
				))}
				<div style={{ whiteSpace: 'pre-wrap' }}>{turn.text}</div>
				{meta.length ? <small>{meta.join(' · ')}</small> : null}
			</div>
		</div>
	);
}
