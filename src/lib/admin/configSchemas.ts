import { z } from 'zod';

// Shared validation for bot_config rows, used by the /admin/config save path so a
// malformed edit can't reach the bot (which parses these blobs live). Validation is
// permissive about UNKNOWN keys on purpose — we only assert the shape of fields we
// know, and we save the original JSON (not the parsed result), so forward-compatible
// fields the bot adds later are never stripped. A config_name with no schema here is
// saved as-is (raw JSON only), preserving today's behaviour for un-modelled configs.

// One command message = an embed template keyed by command slug in `command_messages`.
// Mirrors the shape the bot's templateRenderer consumes (see the editable-command-
// messages work). Description supports {{channel:KEY}} / {{role:KEY}} / {{emoji:KEY}}
// tokens — those are plain strings here; the bot resolves them.
const embedTemplateSchema = z.object({
	color: z.union([z.number(), z.string()]).optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	thumbnail: z.string().optional(),
	image: z.string().optional(),
	footer: z.string().optional(),
	timestamp: z.boolean().optional(),
	confirmText: z.string().optional()
});

export const commandMessagesSchema = z.record(z.string(), embedTemplateSchema);

// Registry: config_name -> schema. Extended as more config groups become structured
// (e.g. `form_definitions` lands with Slice 2's data-driven forms).
export const configSchemas: Record<string, z.ZodType> = {
	command_messages: commandMessagesSchema
};

// Validate a parsed config value for the given config_name. Returns a flat, human
// readable error string suitable for showing in the editor. Configs without a schema
// always pass (they're only constrained to be valid JSON by the caller).
export function validateConfigValue(
	config_name: string,
	value: unknown
): { ok: true } | { ok: false; error: string } {
	const schema = configSchemas[config_name];
	if (!schema) return { ok: true };

	const result = schema.safeParse(value);
	if (result.success) return { ok: true };

	const msg = result.error.issues
		.slice(0, 5)
		.map((i) => {
			const path = i.path.length ? i.path.join('.') : '(root)';
			return `${path}: ${i.message}`;
		})
		.join('; ');
	return { ok: false, error: `Invalid ${config_name}: ${msg}` };
}
