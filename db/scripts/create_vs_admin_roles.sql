-- vs_admin_roles: DB-backed grants of website admin access.
--
-- Owners (super admins) stay rooted in the SUPER_ADMIN_DISCORD_IDS env var and are
-- NOT representable here on purpose: a grant in this table can only ever add the
-- 'admin' or 'card_tester' role, so a compromised admin account can never escalate
-- itself (or anyone else) to owner. The owner UI at /admin/admins writes this table;
-- the site merges these rows with the env allow-lists when resolving permissions.
--
-- Apply manually against the shared Supabase project (this repo has no migration
-- runner — same convention as db/functions and db/scripts).

create table if not exists vs_admin_roles (
	id          uuid primary key default gen_random_uuid(),
	discord_id  text not null,
	role        text not null check (role in ('admin', 'card_tester')),
	granted_by  text not null,              -- discord_id of the super admin who granted it
	note        text,                        -- optional free-text reason / who this is
	created_at  timestamptz not null default now(),
	unique (discord_id, role)
);

-- Fast lookup by role for the per-request cache refresh.
create index if not exists vs_admin_roles_role_idx on vs_admin_roles (role);
