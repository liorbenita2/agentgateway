import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxItemIndicator,
	ComboboxList,
	ComboboxTrigger,
	ComboboxValue
} from '@ui-sdk/react/combobox';
import {
	Drawer,
	DrawerBackdrop,
	DrawerClose,
	DrawerContent,
	DrawerDescription,
	DrawerTitle
} from '@ui-sdk/react/drawer';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import {
	SegmentedControl,
	SegmentedControlIndicator,
	SegmentedControlItem
} from '@ui-sdk/react/segmented-control';
import {
	Slider,
	SliderControl,
	SliderIndicator,
	SliderThumb,
	SliderTrack
} from '@ui-sdk/react/slider';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui-sdk/react/tooltip';
import DOMPurify from 'dompurify';
import {
	ArrowUp,
	Bot,
	Brain,
	Check,
	ChevronDown,
	Code2,
	Copy,
	ImagePlus,
	Plus,
	Search,
	SlidersHorizontal,
	Square,
	Trash2,
	X
} from 'lucide-react';
import { marked } from 'marked';
import { type ComponentProps, type ReactNode, useMemo, useRef, useState } from 'react';

import { apiBase } from '@/api/base';
import { ProviderIcon } from '@/components/ProviderIcon';
import '@/styles/ai21.css';
import type { StoresDump } from '@/gateway-admin';
import {
	applyStreamEvent,
	buildChatRequest,
	CHAT_APIS,
	type ChatApi,
	type ChatSettings,
	type ChatTurn,
	type ChatUsage,
	chatCodeSnippets,
	gatewayChatModels,
	newStreamState,
	splitSse
} from '@/pages/gatewayChat';
import {
	PROVIDER_ICONS,
	PROVIDER_LABELS,
	type PriceProvider,
	priceModels
} from '@/pages/models/pricing';

// The tools host sends <apiBase>/v1/* to the gateway's iap listener (IAP names the caller, no key needed).
export const gatewayModelsBase = `${apiBase}/v1`;

const MAX_PANELS = 3;

type ModelOption = { name: string; provider: PriceProvider; upstream: string; apis: ChatApi[] };

type Turn = ChatTurn & { reasoning?: string; usage?: ChatUsage; model?: string; ms?: number };

type Panel = {
	id: number;
	model: string;
	api: ChatApi;
	settings: ChatSettings;
	turns: Turn[];
	loading: boolean;
	error: string | null;
};

const defaultSettings = (): ChatSettings => ({ system: '', maxTokens: 4096, stop: [] });

function useModelOptions(dump: StoresDump | null): ModelOption[] {
	return useMemo(() => {
		if (!dump) return [];
		const names = new Set(gatewayChatModels(dump.models).map(model => model.name));
		const options = new Map<string, ModelOption>();
		for (const priced of priceModels(dump, null)) {
			if (!names.has(priced.model.name) || options.has(priced.model.name)) continue;
			const apis = priced.routes
				.map(route => route.route)
				.filter((route): route is ChatApi => route !== 'native');
			options.set(priced.model.name, {
				name: priced.model.name,
				provider: priced.provider,
				upstream: priced.upstream,
				apis: apis.length ? apis : ['completions']
			});
		}
		return [...options.values()].sort(
			(a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name)
		);
	}, [dump]);
}

export function GatewayPlayground(props: { dump: StoresDump | null }) {
	const models = useModelOptions(props.dump);
	const nextId = useRef(1);
	const aborts = useRef(new Map<number, AbortController>());
	const [panels, setPanels] = useState<Panel[]>(() => [newPanel(0, '')]);
	const [prompt, setPrompt] = useState('');
	const [images, setImages] = useState<string[]>([]);
	const fileInput = useRef<HTMLInputElement>(null);

	const firstModel = models.find(model => model.name === storedModel()) ?? models[0];
	// Panels start empty until the dump loads; give them the first model then.
	const resolve = (panel: Panel) =>
		panel.model || !firstModel
			? panel
			: { ...panel, model: firstModel.name, api: firstModel.apis[0] };
	const resolved = panels.map(resolve);
	const loading = resolved.some(panel => panel.loading);

	function newPanel(id: number, model: string, api: ChatApi = 'completions'): Panel {
		return { id, model, api, settings: defaultSettings(), turns: [], loading: false, error: null };
	}

	function update(id: number, change: (panel: Panel) => Panel) {
		setPanels(current => current.map(panel => (panel.id === id ? change(resolve(panel)) : panel)));
	}

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

	async function run(panel: Panel, history: Turn[]) {
		const controller = new AbortController();
		aborts.current.set(panel.id, controller);
		const started = performance.now();
		const state = newStreamState();
		const show = (patch: Partial<Panel> = {}) =>
			setPanels(current =>
				current.map(item =>
					item.id === panel.id
						? {
								...item,
								...patch,
								turns: [
									...history,
									{
										role: 'assistant',
										text: state.content,
										reasoning: state.reasoning,
										usage: { ...state.usage },
										model: state.model,
										ms: Math.round(performance.now() - started)
									}
								]
							}
						: item
				)
			);
		try {
			const request = buildChatRequest(panel.api, panel.model, history, panel.settings);
			const response = await fetch(`${gatewayModelsBase}${request.path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...request.headers },
				signal: controller.signal,
				body: JSON.stringify(request.body)
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
				for (const event of events) done = applyStreamEvent(panel.api, state, event) || done;
				show();
			}
			show({ loading: false });
		} catch (err) {
			const error = controller.signal.aborted
				? null
				: err instanceof Error
					? err.message
					: String(err);
			if (state.content || state.reasoning) show({ loading: false, error });
			else
				setPanels(current =>
					current.map(item => (item.id === panel.id ? { ...item, loading: false, error } : item))
				);
		} finally {
			aborts.current.delete(panel.id);
		}
	}

	function send() {
		const text = prompt.trim();
		if ((!text && images.length === 0) || loading) return;
		const userTurn: Turn = { role: 'user', text, images };
		const targets = resolved.filter(panel => panel.model);
		const histories = new Map(targets.map(panel => [panel.id, [...panel.turns, userTurn]]));
		setPanels(
			resolved.map(panel =>
				histories.has(panel.id)
					? { ...panel, turns: histories.get(panel.id) ?? [], loading: true, error: null }
					: panel
			)
		);
		setPrompt('');
		setImages([]);
		for (const panel of targets) void run(panel, histories.get(panel.id) ?? []);
	}

	return (
		<div className="gwchat">
			<div className="gwchat-title">
				<h2>Chat</h2>
				<p>
					Test models through this gateway: Chat Completions, Responses or Messages, whichever each
					model serves.
				</p>
			</div>
			<div
				className="gwchat-panels"
				style={{ gridTemplateColumns: `repeat(${resolved.length}, minmax(0, 1fr))` }}
			>
				{resolved.map((panel, index) => (
					<ChatPanel
						key={panel.id}
						panel={panel}
						models={models}
						canAdd={index === resolved.length - 1 && resolved.length < MAX_PANELS}
						canRemove={resolved.length > 1}
						onChange={change => update(panel.id, change)}
						onAdd={() => {
							const id = nextId.current++;
							setPanels([...resolved, newPanel(id, panel.model, panel.api)]);
						}}
						onRemove={() => {
							aborts.current.get(panel.id)?.abort();
							setPanels(resolved.filter(item => item.id !== panel.id));
						}}
					/>
				))}
			</div>
			<div className="gwchat-composer">
				{images.length ? (
					<div className="gwchat-attachments">
						{images.map((url, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: removal is by position
							<div className="gwchat-attachment" key={index}>
								<img src={url} alt="" />
								<button
									type="button"
									aria-label="Remove image"
									onClick={() => setImages(current => current.filter((_, i) => i !== index))}
								>
									<X size={12} />
								</button>
							</div>
						))}
					</div>
				) : null}
				<textarea
					rows={2}
					value={prompt}
					onChange={event => setPrompt(event.target.value)}
					onPaste={event => {
						if (event.clipboardData.files.length) void addImages(event.clipboardData.files);
					}}
					onKeyDown={event => {
						if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							send();
						}
					}}
					placeholder={
						resolved.length > 1
							? `Message ${resolved.length} models...`
							: 'What would you like to know?'
					}
				/>
				<div className="gwchat-composer-footer">
					<IconButton label="Add images" onClick={() => fileInput.current?.click()}>
						<ImagePlus size={16} />
					</IconButton>
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
					<span className="gwchat-hint">
						Calls {gatewayModelsBase} as you (IAP), billed to ai21
					</span>
					{loading ? (
						<button
							type="button"
							className="gwchat-send"
							title="Stop"
							onClick={() => {
								for (const controller of aborts.current.values()) controller.abort();
							}}
						>
							<Square size={14} />
						</button>
					) : (
						<button
							type="button"
							className="gwchat-send"
							title="Send"
							disabled={!prompt.trim() && images.length === 0}
							onClick={send}
						>
							<ArrowUp size={16} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function storedModel() {
	return localStorage.getItem('gatewayPlaygroundModel') ?? '';
}

// One icon button with a tooltip; `render` lets it also be another part's trigger.
function IconButton(
	props: { label: string; children: ReactNode } & Omit<
		ComponentProps<typeof TooltipTrigger>,
		'children'
	>
) {
	const { label, children, render, ...rest } = props;
	return (
		<Tooltip delay={300}>
			<TooltipTrigger data-variant="ghost" aria-label={label} render={render} {...rest}>
				{children}
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function ModelPicker(props: {
	value: string;
	models: ModelOption[];
	onChange: (name: string) => void;
}) {
	const [button, setButton] = useState<HTMLButtonElement | null>(null);
	const [query, setQuery] = useState('');
	const current = props.models.find(item => item.name === props.value);
	return (
		<Combobox
			value={props.value || null}
			onValueChange={value => {
				if (typeof value === 'string' && value) props.onChange(value);
			}}
			query={query}
			onQueryChange={setQuery}
			onOpenChange={open => open && setQuery('')}
			onOpenChangeComplete={open => !open && button?.focus()}
			autoHighlight="always"
		>
			<ComboboxTrigger ref={setButton} className="gwchat-model" aria-label="Model">
				{current ? <ProviderIcon provider={PROVIDER_ICONS[current.provider]} /> : null}
				<span className="gwchat-model-name">
					<ComboboxValue>{() => props.value || 'No models'}</ComboboxValue>
				</span>
				<ChevronDown size={14} aria-hidden="true" />
			</ComboboxTrigger>
			<ComboboxContent anchor={button} className="gwchat-model-popup" align="start">
				<div className="gwchat-model-search">
					<Search size={14} aria-hidden="true" />
					<ComboboxInput autoFocus aria-label="Search models" placeholder="Search models..." />
				</div>
				<ComboboxEmpty>No models match.</ComboboxEmpty>
				<ComboboxList>
					{props.models.map(item => (
						<ComboboxItem
							key={item.name}
							value={item.name}
							label={item.name}
							keywords={[item.upstream, PROVIDER_LABELS[item.provider]]}
						>
							<ProviderIcon provider={PROVIDER_ICONS[item.provider]} />
							<span className="gwchat-model-option">
								<strong>{item.name}</strong>
								<small>
									{PROVIDER_LABELS[item.provider]}
									{item.upstream !== item.name ? ` · ${item.upstream}` : ''}
								</small>
							</span>
							<ComboboxItemIndicator>
								<Check size={14} aria-hidden="true" />
							</ComboboxItemIndicator>
						</ComboboxItem>
					))}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

function ChatPanel(props: {
	panel: Panel;
	models: ModelOption[];
	canAdd: boolean;
	canRemove: boolean;
	onChange: (change: (panel: Panel) => Panel) => void;
	onAdd: () => void;
	onRemove: () => void;
}) {
	const { panel, models } = props;
	const model = models.find(item => item.name === panel.model);
	const [codeOpen, setCodeOpen] = useState(false);
	const setSettings = (patch: Partial<ChatSettings>) =>
		props.onChange(current => ({ ...current, settings: { ...current.settings, ...patch } }));

	return (
		<section className="gwchat-panel">
			<header className="gwchat-panel-header">
				<ModelPicker
					value={panel.model}
					models={models}
					onChange={name => {
						localStorage.setItem('gatewayPlaygroundModel', name);
						const next = models.find(item => item.name === name);
						props.onChange(current => ({
							...current,
							model: name,
							api: next?.apis.includes(current.api) ? current.api : (next?.apis[0] ?? 'completions')
						}));
					}}
				/>
				<SegmentedControl
					aria-label="API"
					className="gwchat-apis"
					value={panel.api}
					disabled={panel.loading}
					onValueChange={value => {
						if (value) props.onChange(current => ({ ...current, api: value as ChatApi }));
					}}
				>
					<SegmentedControlIndicator />
					{CHAT_APIS.map(api => {
						const supported = model?.apis.includes(api.value) ?? api.value === 'completions';
						return (
							<SegmentedControlItem
								key={api.value}
								value={api.value}
								disabled={!supported}
								title={
									supported
										? `POST /v1${api.path}`
										: `${panel.model} is not served on /v1${api.path}`
								}
							>
								{api.label}
							</SegmentedControlItem>
						);
					})}
				</SegmentedControl>
				<div className="gwchat-panel-actions">
					<IconButton label="Code" onClick={() => setCodeOpen(true)}>
						<Code2 size={16} />
					</IconButton>
					<Popover>
						<IconButton label="Model settings" render={<PopoverTrigger />}>
							<SlidersHorizontal size={16} />
						</IconButton>
						<PopoverContent side="bottom" align="end" className="gwchat-settings">
							<SettingsForm api={panel.api} settings={panel.settings} onChange={setSettings} />
						</PopoverContent>
					</Popover>
					<IconButton
						label="Clear conversation"
						disabled={panel.loading || panel.turns.length === 0}
						onClick={() => props.onChange(current => ({ ...current, turns: [], error: null }))}
					>
						<Trash2 size={16} />
					</IconButton>
					{props.canAdd ? (
						<IconButton label="Compare with another model" onClick={props.onAdd}>
							<Plus size={16} />
						</IconButton>
					) : null}
					{props.canRemove ? (
						<IconButton label="Close" onClick={props.onRemove}>
							<X size={16} />
						</IconButton>
					) : null}
				</div>
			</header>
			<div className="gwchat-messages">
				{panel.turns.length === 0 ? (
					<div className="gwchat-empty">
						<span className="gwchat-empty-icon">
							{model ? (
								<ProviderIcon provider={PROVIDER_ICONS[model.provider]} />
							) : (
								<Bot size={22} />
							)}
						</span>
						<span>{panel.model || 'Pick a model'}</span>
						<small>{CHAT_APIS.find(api => api.value === panel.api)?.label}</small>
					</div>
				) : null}
				{panel.turns.map((turn, index) => (
					<TurnView
						// biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only
						key={index}
						turn={turn}
						streaming={panel.loading && index === panel.turns.length - 1}
					/>
				))}
				{panel.loading && panel.turns.at(-1)?.role === 'user' ? (
					<div className="gwchat-turn assistant">
						<div className="gwchat-typing">
							<span />
							<span />
							<span />
						</div>
					</div>
				) : null}
				{panel.error ? <div className="gwchat-error">{panel.error}</div> : null}
			</div>
			<CodeDrawer panel={panel} open={codeOpen} onOpenChange={setCodeOpen} />
		</section>
	);
}

function SettingsForm(props: {
	api: ChatApi;
	settings: ChatSettings;
	onChange: (patch: Partial<ChatSettings>) => void;
}) {
	const { settings } = props;
	const [stop, setStop] = useState('');
	return (
		<>
			<PopoverTitle>Model settings</PopoverTitle>
			<label className="gwchat-field">
				<span>System prompt</span>
				<textarea
					rows={3}
					value={settings.system}
					placeholder="You are a helpful assistant."
					onChange={event => props.onChange({ system: event.target.value })}
				/>
			</label>
			<NumberSetting
				label="Max output tokens"
				value={settings.maxTokens}
				min={1}
				max={65536}
				step={1}
				onChange={maxTokens => props.onChange({ maxTokens })}
			/>
			<NumberSetting
				label="Temperature"
				value={settings.temperature}
				min={0}
				max={2}
				step={0.01}
				onChange={temperature => props.onChange({ temperature })}
			/>
			<NumberSetting
				label="Top P"
				value={settings.topP}
				min={0}
				max={1}
				step={0.01}
				onChange={topP => props.onChange({ topP })}
			/>
			{props.api !== 'responses' ? (
				<label className="gwchat-field">
					<span>Stop sequences</span>
					<div className="gwchat-chips">
						{settings.stop.map(item => (
							<span className="gwchat-chip" key={item}>
								{item}
								<button
									type="button"
									aria-label={`Remove ${item}`}
									onClick={() => props.onChange({ stop: settings.stop.filter(s => s !== item) })}
								>
									<X size={10} />
								</button>
							</span>
						))}
						<input
							value={stop}
							placeholder="Type and press Enter"
							onChange={event => setStop(event.target.value)}
							onKeyDown={event => {
								if (event.key === 'Enter' && stop && !settings.stop.includes(stop)) {
									event.preventDefault();
									props.onChange({ stop: [...settings.stop, stop] });
									setStop('');
								}
							}}
						/>
					</div>
				</label>
			) : null}
			<small className="gwchat-settings-note">Empty means the provider default.</small>
		</>
	);
}

function NumberSetting(props: {
	label: string;
	value: number | undefined;
	min: number;
	max: number;
	step: number;
	onChange: (value: number | undefined) => void;
}) {
	return (
		<div className="gwchat-number">
			<span>
				{props.label}
				<input
					inputMode="decimal"
					aria-label={props.label}
					value={props.value ?? ''}
					placeholder="default"
					onChange={event => {
						const raw = event.target.value.trim();
						props.onChange(raw === '' || Number.isNaN(Number(raw)) ? undefined : Number(raw));
					}}
				/>
			</span>
			<Slider
				min={props.min}
				max={props.max}
				step={props.step}
				value={props.value ?? props.min}
				onValueChange={value => props.onChange(Array.isArray(value) ? value[0] : value)}
			>
				<SliderControl>
					<SliderTrack>
						<SliderIndicator />
						<SliderThumb aria-label={props.label} />
					</SliderTrack>
				</SliderControl>
			</Slider>
		</div>
	);
}

function CodeDrawer(props: { panel: Panel; open: boolean; onOpenChange: (open: boolean) => void }) {
	const { panel } = props;
	const turns: ChatTurn[] = [
		...panel.turns.map(({ role, text, images }) => ({ role, text, images })),
		...(panel.turns.at(-1)?.role === 'user' ? [] : [{ role: 'user' as const, text: 'Say hi.' }])
	];
	const { body } = buildChatRequest(panel.api, panel.model, turns, panel.settings);
	const snippets = chatCodeSnippets(
		panel.api,
		`${window.location.origin}${gatewayModelsBase}`,
		body
	);
	const api = CHAT_APIS.find(item => item.value === panel.api);
	return (
		<Drawer side="right" open={props.open} onOpenChange={props.onOpenChange}>
			<DrawerBackdrop />
			<DrawerContent className="gwchat-code-drawer">
				<header>
					<div>
						<DrawerTitle>{panel.model}</DrawerTitle>
						<DrawerDescription>
							{api?.label} · POST {gatewayModelsBase}
							{api?.path}
						</DrawerDescription>
					</div>
					<DrawerClose data-variant="ghost" aria-label="Close">
						<X size={16} />
					</DrawerClose>
				</header>
				<Tabs defaultValue="curl">
					<TabsList aria-label="Language">
						<TabsTab value="curl">curl</TabsTab>
						<TabsTab value="python">Python</TabsTab>
					</TabsList>
					<TabsPanel value="curl">
						<CodeBlock code={snippets.curl} />
					</TabsPanel>
					<TabsPanel value="python">
						<CodeBlock code={snippets.python} />
					</TabsPanel>
				</Tabs>
			</DrawerContent>
		</Drawer>
	);
}

function CodeBlock(props: { code: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<div className="gwchat-code">
			<IconButton
				label={copied ? 'Copied' : 'Copy'}
				onClick={() => {
					void navigator.clipboard.writeText(props.code);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</IconButton>
			<pre>{props.code}</pre>
		</div>
	);
}

function Markdown(props: { text: string }) {
	const html = useMemo(
		() => DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true, breaks: true })),
		[props.text]
	);
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify
	return <div className="gwchat-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function TurnView(props: { turn: Turn; streaming: boolean }) {
	const { turn } = props;
	const [copied, setCopied] = useState(false);
	if (turn.role === 'user') {
		return (
			<div className="gwchat-turn user">
				<div className="gwchat-user-bubble">
					{turn.images?.map((url, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: images of one turn never reorder
						<img key={index} src={url} alt="" />
					))}
					{turn.text}
				</div>
			</div>
		);
	}
	const meta = [
		turn.model,
		turn.usage?.input != null ? `${turn.usage.input} in` : null,
		turn.usage?.output != null ? `${turn.usage.output} out` : null,
		turn.ms != null ? `${(turn.ms / 1000).toFixed(1)}s` : null
	].filter(Boolean);
	return (
		<div className="gwchat-turn assistant">
			{turn.reasoning ? (
				<Collapsible
					className="gwchat-reasoning"
					open={props.streaming && !turn.text ? true : undefined}
				>
					<CollapsibleTrigger>
						<Brain size={14} />
						{props.streaming && !turn.text ? 'Thinking...' : 'Reasoning'}
						<ChevronDown size={14} className="gwchat-reasoning-chevron" />
					</CollapsibleTrigger>
					<CollapsiblePanel>{turn.reasoning}</CollapsiblePanel>
				</Collapsible>
			) : null}
			<Markdown text={turn.text} />
			{!props.streaming ? (
				<div className="gwchat-turn-meta">
					<IconButton
						label={copied ? 'Copied' : 'Copy'}
						onClick={() => {
							void navigator.clipboard.writeText(turn.text);
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						}}
					>
						{copied ? <Check size={13} /> : <Copy size={13} />}
					</IconButton>
					<span>{meta.join(' · ')}</span>
				</div>
			) : null}
		</div>
	);
}
