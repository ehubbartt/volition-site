import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(src: string | null | undefined): string | null {
	if (!src) return null;
	return marked.parse(src, { async: false }) as string;
}
