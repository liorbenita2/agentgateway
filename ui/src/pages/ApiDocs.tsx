import { useEffect, useMemo, useRef, useState } from 'react';

import { apiBase } from '@/api/base';
import { PageHeader, Panel, StatusBanner } from '@/components/Primitives';
import { useConfigDumpMode } from '@/hooks';
import { gatewayChatModelNames, gatewayOpenApi } from '@/pages/gatewayChat';
import '@/styles/ai21.css';

// models-gateway's listing path, which the chart serves when modelListing is on.
const LISTING_PATH = '/api/v1/endpoints';

export function ApiDocsPage() {
	const mode = useConfigDumpMode();
	const models = useMemo(() => gatewayChatModelNames(mode.data?.dump?.models ?? []), [mode.data]);
	const [hasListing, setHasListing] = useState<boolean | null>(null);
	const [error, setError] = useState<string | null>(null);
	const node = useRef<HTMLDivElement>(null);

	useEffect(() => {
		fetch(`${apiBase}${LISTING_PATH}`)
			.then(response => setHasListing(response.ok))
			.catch(() => setHasListing(false));
	}, []);

	useEffect(() => {
		if (mode.isLoading || hasListing === null || !node.current) return;
		const domNode = node.current;
		const spec = gatewayOpenApi({
			serverUrl: `${window.location.origin}${apiBase}`,
			models,
			listingPath: hasListing ? LISTING_PATH : undefined
		});
		let cancelled = false;
		Promise.all([
			import('swagger-ui-dist/swagger-ui-es-bundle.js'),
			import('swagger-ui-dist/swagger-ui.css')
		])
			.then(([module]) => {
				if (cancelled) return;
				module.default({
					domNode,
					spec,
					tryItOutEnabled: true,
					deepLinking: false,
					defaultModelsExpandDepth: -1,
					// Same origin: the browser sends the IAP cookie with Try it out.
					requestInterceptor: (request: { credentials?: string }) => {
						request.credentials = 'same-origin';
						return request;
					}
				});
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
		return () => {
			cancelled = true;
			domNode.replaceChildren();
		};
	}, [mode.isLoading, hasListing, models]);

	return (
		<div className="page-stack">
			<PageHeader
				title="API"
				description={`OpenAPI for this gateway's model APIs at ${apiBase}/v1. Try it out sends real calls through IAP, billed to ai21 with your email.`}
			/>
			{error ? (
				<StatusBanner state="bad" title="Swagger UI failed to load">
					{error}
				</StatusBanner>
			) : null}
			<Panel className="api-docs-panel">
				<div ref={node} />
			</Panel>
		</div>
	);
}
