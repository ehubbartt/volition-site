import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(src: string | null | undefined): string | null {
	if (!src) return null;
	return marked.parse(src, { async: false }) as string;
}

export function markdownPreview(src: string | null | undefined, maxLen = 160): string {
	if (!src) return '';
	const text = src
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/(\*\*|__)([^*_]+?)\1/g, '$2')
		.replace(/([*_])([^*_\n]+?)\1/g, '$2')
		.replace(/(^|\s)#{1,6}\s+/g, '$1')
		.replace(/(^|\s)>\s+/g, '$1')
		.replace(/(^|\s)[-*+]\s+/g, '$1')
		.replace(/(^|\s)\d+\.\s+/g, '$1')
		.replace(/^[-*_]{3,}\s*$/gm, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen).trimEnd() + '…';
}
