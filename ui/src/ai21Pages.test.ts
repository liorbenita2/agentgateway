import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAi21Page } from '#ai21Pages.ts';

test('only models, chat playground and API pages are shown', () => {
	for (const path of [
		'/llm/models',
		'/llm/models/',
		'/llm/playground',
		'/llm/api',
		'/llm/models/x'
	]) {
		assert.equal(isAi21Page(path), true, path);
	}
	for (const path of [
		'/',
		'/llm/costs',
		'/traffic/routes',
		'/settings/ui',
		'/llm/modelsx',
		'/raw-config'
	]) {
		assert.equal(isAi21Page(path), false, path);
	}
});
