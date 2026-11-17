// ai21 fork: the only pages our gateways show; every other path redirects to the first one.
export const AI21_PAGES = ['/llm/models', '/llm/playground', '/llm/api'] as const;

export function isAi21Page(pathname: string): boolean {
	const path = pathname.replace(/\/+$/, '');
	return AI21_PAGES.some(page => path === page || path.startsWith(`${page}/`));
}
