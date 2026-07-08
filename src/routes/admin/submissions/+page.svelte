<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll, goto } from "$app/navigation";
  import AccountIcon from "$lib/AccountIcon.svelte";
  import Lightbox from "$lib/Lightbox.svelte";
  import EventsTasksTabs from "$lib/admin/EventsTasksTabs.svelte";
  import { swrResource } from "$lib/swrResource.svelte";
  import type { PageData } from "./$types";

  let { data: pageData }: { data: PageData } = $props();

  // Streamed payload (see +page.ts): revisits render the last-seen queue
  // instantly; first visits fill in as the fetch lands. Shadowed under the old
  // `data` name so every reference keeps working.
  const EMPTY_SUBMISSIONS: NonNullable<PageData["submissions"]["cached"]> = {
    view: "pending",
    test: false,
    items: [],
    events: [],
    stats: { pending: 0, approved: 0, rejected: 0 },
    reviewed: null,
    search: "",
  };
  const subRes = swrResource(() => pageData.submissions, EMPTY_SUBMISSIONS);
  const data = $derived(subRes.value);

  let selectedEvent = $state("all");
  // Client-side filter over the pending queue (it loads ALL pending rows, so no server
  // round-trip is needed — unlike the reviewed history). Matches player / team / event / task.
  let pendingSearch = $state("");
  let currentIndex = $state(0);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let lastAction = $state<null | {
    kind: "approve" | "reject" | "skip";
    rsn: string;
  }>(null);
  let lightboxSrc = $state<string | null>(null);
  // Optional reason the admin can attach when rejecting (saved to review_note,
  // shown in the reviewed-history view). Cleared after each decision.
  let rejectNote = $state("");
  // Event submissions require the admin to confirm both checks before approving
  // (task submissions don't). Reset per card.
  let womConfirmed = $state(false);
  let logConfirmed = $state(false);

  // Reviewed-history view filters (client-side over the loaded history).
  let reviewedStatus = $state<"all" | "approved" | "rejected">("all");
  let reviewedEvent = $state("all");
  // Reviewed-history SERVER-SIDE search (?q=) — reaches submissions older than the loaded
  // recent window (the status/event chips above only filter what's already loaded).
  let searchInput = $state("");
  // Seed + keep the box in step with the loaded ?q=. The payload object is
  // replaced on every background refetch, so guard on the value: user typing is
  // only overwritten when the loaded ?q= itself changes (i.e. on navigation).
  let seededSearch: string | null = null;
  $effect(() => {
    const s = data.search ?? "";
    if (s !== seededSearch) {
      seededSearch = s;
      searchInput = s;
    }
  });
  function reviewedUrl(q: string): string {
    const params = new URLSearchParams();
    params.set("view", "reviewed");
    if (q) params.set("q", q);
    if (data.test) params.set("test", "1");
    return `?${params.toString()}`;
  }
  function runSearch() {
    goto(reviewedUrl(searchInput.trim()), { keepFocus: true });
  }
  function clearSearch() {
    searchInput = "";
    goto(reviewedUrl(""), { keepFocus: true });
  }
  // Re-review (un-approve / re-approve) state for the history list.
  let revBusy = $state<string | null>(null);
  let revError = $state<string | null>(null);

  const SOURCE_LABEL: Record<string, string> = {
    generic: "Submission",
    bingo: "Bingo",
    team: "Team",
  };

  const filtered = $derived.by(() => {
    const term = pendingSearch.trim().toLowerCase();
    return data.items.filter((i) => {
      if (selectedEvent !== "all" && i.event.id !== selectedEvent) return false;
      if (!term) return true;
      const hay = [
        i.submitter.rsn,
        i.submitter.discord_username,
        i.team?.name,
        i.event.name,
        i.task.label,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(term);
    });
  });
  const current = $derived(filtered[currentIndex] ?? null);
  const remaining = $derived(filtered.length - currentIndex);
  const canApprove = $derived(
    current?.kind !== "event" || (womConfirmed && logConfirmed),
  );

  const reviewedItems = $derived(data.reviewed?.items ?? []);
  const reviewedEvents = $derived(data.reviewed?.events ?? []);
  const approvedCount = $derived(
    reviewedItems.filter((i) => i.status === "approved").length,
  );
  const rejectedCount = $derived(
    reviewedItems.filter((i) => i.status === "rejected").length,
  );
  const filteredReviewed = $derived(
    reviewedItems.filter(
      (i) =>
        (reviewedStatus === "all" || i.status === reviewedStatus) &&
        (reviewedEvent === "all" || i.event.id === reviewedEvent),
    ),
  );

  function selectEvent(id: string) {
    selectedEvent = id;
    currentIndex = 0;
  }

  function nextCard() {
    currentIndex += 1;
  }

  // Skip = move past this submission without deciding (it stays pending; reappears on
  // reload). Resets the per-card confirm state, like a decision does.
  function skipCard() {
    if (busy || !current) return;
    rejectNote = "";
    womConfirmed = false;
    logConfirmed = false;
    lastAction = {
      kind: "skip",
      rsn: current.submitter.rsn ?? current.submitter.discord_username ?? "",
    };
    nextCard();
  }

  function onKey(e: KeyboardEvent) {
    if (busy || !current) return;
    // Don't hijack arrow keys while the admin is typing a rejection reason.
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) return;
    if (e.key === "ArrowRight") document.getElementById("approve-btn")?.click();
    else if (e.key === "ArrowLeft")
      document.getElementById("reject-btn")?.click();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      skipCard();
    }
  }

  function fmt(iso: string) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
</script>

<svelte:head>
  <title>Review submissions · Volition</title>
</svelte:head>

<svelte:window onkeydown={onKey} />

<EventsTasksTabs />

<nav class="view-tabs">
  <a
    href="?view=pending{data.test ? '&test=1' : ''}"
    class="view-tab"
    class:active={data.view === "pending"}
  >
    Pending queue ({data.stats.pending})
  </a>
  <a
    href="?view=reviewed{data.test ? '&test=1' : ''}"
    class="view-tab"
    class:active={data.view === "reviewed"}
  >
    Reviewed history
  </a>
</nav>

<nav class="live-test">
  <a href="?view={data.view}" class="lt-tab" class:active={!data.test}>Live</a>
  <a
    href="?view={data.view}&test=1"
    class="lt-tab test"
    class:active={data.test}>🧪 Test</a
  >
</nav>

{#if !subRes.ready}
  <p class="muted">Loading…</p>
{/if}

{#if data.test}
  <p class="test-banner">
    Showing <strong>test submissions</strong> only (admin preview runs). These
    are hidden from the live queue.
    <a href="?view={data.view}">Switch to live →</a>
  </p>
{/if}

<section class="hero">
  <p class="muted">
    {#if data.view === "reviewed"}
      Approved &amp; rejected proofs — most recent first.
    {:else}
      Pending image proofs across every event.
    {/if}
  </p>

  <div class="stats">
    <div class="stat">
      <span class="label">Pending</span>
      <strong>{data.view === "pending" ? remaining : data.stats.pending}</strong
      >
    </div>
    <div class="stat">
      <span class="label">Approved</span>
      <strong>{data.stats.approved}</strong>
    </div>
    <div class="stat">
      <span class="label">Rejected</span>
      <strong>{data.stats.rejected}</strong>
    </div>
  </div>

  {#if data.view === "pending"}
    <div class="pending-search">
      <input
        type="search"
        placeholder="Filter the queue by player, team, event, or task…"
        bind:value={pendingSearch}
        oninput={() => (currentIndex = 0)}
        aria-label="Filter pending queue"
      />
      {#if pendingSearch}
        <button
          type="button"
          class="clear-btn"
          onclick={() => {
            pendingSearch = "";
            currentIndex = 0;
          }}>Clear</button
        >
      {/if}
      {#if pendingSearch}<span class="match-count muted"
          >{filtered.length} match{filtered.length === 1 ? "" : "es"}</span
        >{/if}
    </div>
  {/if}

  {#if data.view === "pending" && data.events.length > 1}
    <div class="filter">
      <button
        type="button"
        class="chip"
        class:active={selectedEvent === "all"}
        onclick={() => selectEvent("all")}
      >
        All events ({data.items.length})
      </button>
      {#each data.events as ev (ev.id)}
        <button
          type="button"
          class="chip"
          class:active={selectedEvent === ev.id}
          onclick={() => selectEvent(ev.id)}
        >
          {ev.name} ({data.items.filter((i) => i.event.id === ev.id).length})
        </button>
      {/each}
    </div>
  {/if}
</section>

{#if data.view === "reviewed"}
  <section class="reviewed">
    <form
      class="rev-search"
      onsubmit={(e) => {
        e.preventDefault();
        runSearch();
      }}
    >
      <input
        type="search"
        placeholder="Search by player, team, tile, or event…"
        bind:value={searchInput}
        aria-label="Search reviewed submissions"
      />
      <button type="submit" class="primary">Search</button>
      {#if data.search}<button type="button" onclick={clearSearch}>Clear</button
        >{/if}
    </form>
    <p class="rev-hint muted">
      {#if data.reviewed?.searched}
        Showing all reviewed matches for “{data.search}”.
      {:else}
        Showing the most recent reviewed submissions — search above to find
        older ones.
      {/if}
    </p>

    <div class="filter">
      <button
        type="button"
        class="chip"
        class:active={reviewedStatus === "all"}
        onclick={() => (reviewedStatus = "all")}
      >
        All ({reviewedItems.length})
      </button>
      <button
        type="button"
        class="chip"
        class:active={reviewedStatus === "approved"}
        onclick={() => (reviewedStatus = "approved")}
      >
        Approved ({approvedCount})
      </button>
      <button
        type="button"
        class="chip"
        class:active={reviewedStatus === "rejected"}
        onclick={() => (reviewedStatus = "rejected")}
      >
        Rejected ({rejectedCount})
      </button>
    </div>

    {#if reviewedEvents.length > 1}
      <div class="filter">
        <button
          type="button"
          class="chip"
          class:active={reviewedEvent === "all"}
          onclick={() => (reviewedEvent = "all")}
        >
          All events
        </button>
        {#each reviewedEvents as ev (ev.id)}
          <button
            type="button"
            class="chip"
            class:active={reviewedEvent === ev.id}
            onclick={() => (reviewedEvent = ev.id)}
          >
            {ev.name}
          </button>
        {/each}
      </div>
    {/if}

    {#if filteredReviewed.length === 0}
      <article class="card done">
        <h2>Nothing here yet</h2>
        <p class="muted">No reviewed submissions match this filter.</p>
      </article>
    {:else}
      <ul class="rev-list">
        {#each filteredReviewed as item (item.ids.join(","))}
          <li class="rev-card">
            <header class="rev-head">
              <div class="who">
                <AccountIcon type={item.submitter.account_type} size={24} />
                <div class="who-text">
                  <strong class="rsn"
                    >{item.submitter.rsn ??
                      item.submitter.discord_username}</strong
                  >
                  <span class="muted who-sub">
                    {item.submitter.discord_username}
                    {#if item.submitter.clan_label}· {item.submitter
                        .clan_label}{/if}
                    {#if item.team}· team {item.team.name ?? "Unnamed"}{/if}
                  </span>
                </div>
              </div>
              <span
                class="status-badge"
                class:approved={item.status === "approved"}
                class:rejected={item.status === "rejected"}
              >
                {item.status === "approved" ? "✓ Approved" : "✗ Rejected"}
              </span>
            </header>

            <div class="rev-tile">
              <span class="src-pill"
                >{SOURCE_LABEL[item.source] ?? item.source}</span
              >
              <span class="event-name muted">{item.event.name}</span>
              <span class="rev-task">{item.task.label}</span>
            </div>

            {#if item.proofUrls.length}
              <div class="rev-proofs">
                {#each item.proofUrls as url, idx (url)}
                  <button
                    type="button"
                    class="proof-thumb"
                    onclick={() => (lightboxSrc = url)}
                    aria-label={`View proof ${idx + 1}`}
                  >
                    <img src={url} alt={`Proof ${idx + 1}`} />
                  </button>
                {/each}
              </div>
            {:else}
              <p class="meta muted">No proof images.</p>
            {/if}

            <footer class="rev-foot muted">
              <span>Submitted {fmt(item.submittedAt)}</span>
              {#if item.reviewedAt}<span>· Reviewed {fmt(item.reviewedAt)}</span
                >{/if}
              {#if item.reviewer}<span
                  >· {item.status === "approved" ? "approved" : "rejected"} by {item.reviewer}</span
                >{/if}
              {#if item.reviewNote}<span class="note"
                  >· “{item.reviewNote}”</span
                >{/if}
            </footer>

            <div class="rev-actions">
              {#if item.status === "approved"}
                <form
                  method="POST"
                  action="?/revoke"
                  use:enhance={({ cancel }) => {
                    if (
                      !confirm(
                        "Un-approve this submission and reclaim its rewards (VP always; pack if still unopened)? The player is notified on Discord.",
                      )
                    ) {
                      cancel();
                      return;
                    }
                    revBusy = item.ids.join(",");
                    revError = null;
                    return async ({ result }) => {
                      revBusy = null;
                      if (result.type === "success") await invalidateAll();
                      else if (result.type === "failure")
                        revError =
                          (result.data as { error?: string } | undefined)
                            ?.error ?? "Un-approve failed";
                      else if (result.type === "error")
                        revError = "Something went wrong";
                    };
                  }}
                >
                  <input type="hidden" name="source" value={item.source} />
                  <input type="hidden" name="ids" value={item.ids.join(",")} />
                  <input
                    class="rev-note-input"
                    name="note"
                    placeholder="Reason (optional — shown to the player)"
                  />
                  <button
                    type="submit"
                    class="rev-btn undo"
                    disabled={revBusy !== null}>Un-approve & reclaim</button
                  >
                </form>
              {:else}
                <form
                  method="POST"
                  action="?/decide"
                  use:enhance={() => {
                    revBusy = item.ids.join(",");
                    revError = null;
                    return async ({ result }) => {
                      revBusy = null;
                      if (result.type === "success") await invalidateAll();
                      else if (result.type === "failure")
                        revError =
                          (result.data as { error?: string } | undefined)
                            ?.error ?? "Re-approve failed";
                      else if (result.type === "error")
                        revError = "Something went wrong";
                    };
                  }}
                >
                  <input type="hidden" name="source" value={item.source} />
                  <input type="hidden" name="ids" value={item.ids.join(",")} />
                  <input type="hidden" name="decision" value="approve" />
                  <button
                    type="submit"
                    class="rev-btn redo"
                    disabled={revBusy !== null}>Re-approve</button
                  >
                </form>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if revError}<p class="error">{revError}</p>{/if}
      <p class="cap-hint muted">
        Showing the most recent reviewed submissions.
      </p>
    {/if}
  </section>
{:else if current}
  <article class="card">
    <header class="card-head">
      <div class="who">
        <AccountIcon type={current.submitter.account_type} size={28} />
        <div class="who-text">
          <strong class="rsn"
            >{current.submitter.rsn ??
              current.submitter.discord_username}</strong
          >
          <span class="muted who-sub">
            {current.submitter.discord_username}
            {#if current.submitter.clan_label}· {current.submitter
                .clan_label}{/if}
            {#if current.team}· team {current.team.name ?? "Unnamed"}{/if}
          </span>
        </div>
      </div>
      <div class="progress muted">{currentIndex + 1} of {filtered.length}</div>
    </header>

    <section class="tile-block">
      <div class="tile-line">
        <span class="src-pill"
          >{SOURCE_LABEL[current.source] ?? current.source}</span
        >
        <span class="event-name muted">{current.event.name}</span>
      </div>
      <h2 class="task-name">{current.task.label}</h2>
      {#if current.required != null}
        <div class="tile-prog">
          <span class="prog-count"
            >{current.approvedSoFar ?? 0}/{current.required} approved</span
          >
          <span
            class="claim-badge"
            title="How many of the tile's required total this proof claims"
          >
            this proof claims {current.quantity}
          </span>
          {#if (current.approvedSoFar ?? 0) + current.quantity >= current.required}
            <span class="will-complete">· approving completes this tile</span>
          {/if}
        </div>
      {:else if current.quantity > current.count}
        <span
          class="claim-badge"
          title="The submitter says this proof covers this many of the tile's required total"
        >
          claims {current.quantity}
        </span>
      {/if}
      {#if current.task.detail_html}
        <div class="details">
          <h3>How to complete</h3>
          <div class="details-body">{@html current.task.detail_html}</div>
        </div>
      {/if}
    </section>

    <section class="proofs">
      <h3>
        {current.proofUrls.length} proof{current.proofUrls.length === 1
          ? ""
          : "s"}
      </h3>
      <div class="sub-images">
        {#each current.proofUrls as url, idx (url)}
          <button
            type="button"
            class="proof-button"
            onclick={() => (lightboxSrc = url)}
            aria-label={`View proof ${idx + 1}`}
          >
            <img src={url} alt={`Submitted proof ${idx + 1}`} />
          </button>
        {/each}
      </div>
      <p class="meta muted">Submitted {fmt(current.submittedAt)}</p>
    </section>

    {#if error}<p class="error">{error}</p>{/if}

    {#if current.kind === "event"}
      <fieldset class="approve-checks">
        <legend>Before approving</legend>
        <label class="check">
          <input type="checkbox" bind:checked={womConfirmed} />
          <span>Has WOM codeword</span>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={logConfirmed} />
          <span>Visible Drop/Collection Log</span>
        </label>
      </fieldset>
    {/if}

    <label class="note-field">
      <span class="note-label"
        >Rejection reason <span class="muted"
          >(optional — shown to the player)</span
        ></span
      >
      <textarea
        bind:value={rejectNote}
        rows="2"
        maxlength="500"
        placeholder="e.g. Screenshot doesn't show the drop — please reupload with the loot visible."
      ></textarea>
    </label>

    <div class="actions">
      <form
        method="POST"
        action="?/decide"
        use:enhance={() => {
          busy = true;
          return async ({ result }) => {
            busy = false;
            if (result.type === "success") {
              lastAction = {
                kind: "reject",
                rsn:
                  current?.submitter.rsn ??
                  current?.submitter.discord_username ??
                  "",
              };
              rejectNote = "";
              womConfirmed = false;
              logConfirmed = false;
              nextCard();
            } else if (result.type === "failure") {
              error =
                (result.data as { error?: string } | undefined)?.error ??
                "Reject failed";
            } else if (result.type === "error") {
              error = result.error?.message ?? "Something went wrong";
            }
          };
        }}
      >
        <input type="hidden" name="source" value={current.source} />
        <input type="hidden" name="ids" value={current.ids.join(",")} />
        <input type="hidden" name="decision" value="reject" />
        <input type="hidden" name="note" value={rejectNote} />
        <button
          id="reject-btn"
          type="submit"
          class="reject"
          disabled={busy}
          title="Reject (←)"
        >
          <span class="big-icon">✗</span>
          <span class="label-text">Reject</span>
        </button>
      </form>

      <button
        id="skip-btn"
        type="button"
        class="skip"
        onclick={skipCard}
        disabled={busy}
        title="Skip — decide later (↓)"
      >
        <span class="big-icon">↷</span>
        <span class="label-text">Skip</span>
      </button>

      <form
        method="POST"
        action="?/decide"
        use:enhance={() => {
          busy = true;
          return async ({ result }) => {
            busy = false;
            if (result.type === "success") {
              lastAction = {
                kind: "approve",
                rsn:
                  current?.submitter.rsn ??
                  current?.submitter.discord_username ??
                  "",
              };
              rejectNote = "";
              womConfirmed = false;
              logConfirmed = false;
              nextCard();
            } else if (result.type === "failure") {
              error =
                (result.data as { error?: string } | undefined)?.error ??
                "Approve failed";
            } else if (result.type === "error") {
              error = result.error?.message ?? "Something went wrong";
            }
          };
        }}
      >
        <input type="hidden" name="source" value={current.source} />
        <input type="hidden" name="ids" value={current.ids.join(",")} />
        <input type="hidden" name="decision" value="approve" />
        <button
          id="approve-btn"
          type="submit"
          class="approve"
          disabled={busy || !canApprove}
          title={canApprove ? "Approve (→)" : "Check both boxes to approve"}
        >
          <span class="big-icon">✓</span>
          <span class="label-text">Approve</span>
        </button>
      </form>
    </div>

    {#if lastAction}
      <p class="last-action muted">
        Last: {lastAction.kind === "approve"
          ? "approved"
          : lastAction.kind === "skip"
            ? "skipped"
            : "rejected"}
        <strong>{lastAction.rsn}</strong>
      </p>
    {/if}
  </article>
{:else}
  <article class="card done">
    {#if pendingSearch.trim()}
      <h2>No matches</h2>
      <p class="muted">
        No pending submissions match “{pendingSearch.trim()}”{selectedEvent !==
        "all"
          ? " for this event"
          : ""}.
      </p>
      <button
        type="button"
        class="primary"
        onclick={() => {
          pendingSearch = "";
          currentIndex = 0;
        }}
      >
        Clear search
      </button>
    {:else}
      <h2>🎉 All caught up</h2>
      <p class="muted">
        No pending submissions{selectedEvent !== "all" ? " for this event" : ""}
        right now.
      </p>
      <button
        type="button"
        class="primary"
        onclick={() => {
          currentIndex = 0;
          invalidateAll();
        }}
      >
        Check for new submissions
      </button>
    {/if}
  </article>
{/if}

{#if lightboxSrc}
  <Lightbox
    src={lightboxSrc}
    alt="Submitted proof"
    onclose={() => (lightboxSrc = null)}
  />
{/if}

<style>
  .view-tabs {
    display: flex;
    gap: 0.4rem;
    margin: 0.5rem 0 1rem;
    flex-wrap: wrap;
  }

  .view-tab {
    padding: 0.4rem 0.9rem;
    font-family: var(--font-heading);
    font-size: 0.85rem;
    letter-spacing: 0.5px;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--muted);
    text-decoration: none;
  }

  .view-tab:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .view-tab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .live-test {
    display: flex;
    gap: 0.3rem;
    margin: 0 0 1rem;
  }

  .lt-tab {
    padding: 0.25rem 0.7rem;
    font-size: 0.78rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-alt);
    color: var(--muted);
    text-decoration: none;
  }

  .lt-tab:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .lt-tab.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .test-banner {
    margin: 0 0 1rem;
    padding: 0.5rem 0.8rem;
    font-size: 0.85rem;
    background: rgba(255, 152, 31, 0.12);
    border: 1px dashed var(--accent);
    border-radius: var(--radius);
    color: var(--accent);
  }

  .test-banner a {
    color: var(--accent);
  }

  .hero {
    margin-bottom: 1.25rem;
  }

  .muted {
    color: var(--muted);
  }

  .stats {
    display: flex;
    gap: 1rem;
    margin: 0.75rem 0 0.6rem;
    flex-wrap: wrap;
  }

  .stat {
    padding: 0.4rem 0.85rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 5rem;
  }

  .stat .label {
    font-family: var(--font-heading);
    font-size: 0.7rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--muted);
  }

  .stat strong {
    font-family: var(--font-heading);
    color: var(--yellow);
    font-size: 1.1rem;
  }

  .filter {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.25rem 0 0.5rem;
  }

  .chip {
    padding: 0.3rem 0.7rem;
    font-size: 0.82rem;
    min-height: 0;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--muted);
  }

  .chip:hover {
    border-color: var(--accent);
    color: var(--text);
  }

  .chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .kbd-hint {
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
  }

  kbd {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    font-family: var(--font-heading);
    font-size: 0.78rem;
    color: var(--accent);
  }

  .card {
    max-width: 38rem;
    margin: 0 auto;
    padding: 1.25rem;
    background: linear-gradient(
      180deg,
      rgba(58, 48, 36, 0.92),
      rgba(40, 32, 24, 0.92)
    );
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
  }

  .card.done {
    text-align: center;
    padding: 2rem;
  }

  .card.done h2 {
    margin: 0 0 0.5rem;
  }

  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 0.85rem;
    flex-wrap: wrap;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .who-text {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .rsn {
    font-family: var(--font-heading);
    color: var(--yellow);
    text-shadow: var(--ts);
    font-size: 1.05rem;
  }

  .who-sub {
    font-size: 0.8rem;
  }

  .progress {
    font-family: var(--font-heading);
    font-size: 0.85rem;
    color: var(--muted);
  }

  .tile-block {
    padding: 0.75rem 0.85rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 0.85rem;
  }

  .tile-line {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.3rem;
  }

  .src-pill {
    padding: 0.1rem 0.55rem;
    border-radius: 3px;
    font-family: var(--font-heading);
    font-size: 0.72rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    background: var(--accent);
    color: #1a1208;
    text-shadow: none;
  }

  .event-name {
    font-family: var(--font-heading);
    font-size: 0.78rem;
    letter-spacing: 1px;
    text-transform: uppercase;
  }

  .task-name {
    margin: 0;
    font-size: 1.2rem;
    color: var(--accent);
  }

  .claim-badge {
    display: inline-block;
    margin-left: 0.4rem;
    vertical-align: middle;
    font-family: var(--font-body);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(255, 152, 31, 0.18);
    border: 1px solid var(--accent);
    color: var(--accent);
    padding: 0.05rem 0.45rem;
    border-radius: 3px;
  }

  .tile-prog {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.3rem 0 0;
  }
  .tile-prog .claim-badge {
    margin-left: 0;
  }
  .prog-count {
    font-family: var(--font-heading);
    color: var(--yellow);
    font-size: 0.9rem;
  }
  .will-complete {
    color: var(--success);
    font-size: 0.85rem;
  }

  .details {
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--border);
  }

  .details h3 {
    margin: 0 0 0.3rem;
    font-size: 0.78rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--muted);
  }

  .details-body :global(p) {
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }

  .details-body :global(:last-child) {
    margin-bottom: 0;
  }

  .details-body :global(ul),
  .details-body :global(ol) {
    margin: 0.25rem 0 0.5rem;
    padding-left: 1.15rem;
  }

  .proofs {
    margin-bottom: 1rem;
  }

  .proofs h3 {
    margin: 0 0 0.5rem;
    font-size: 0.95rem;
    color: var(--accent);
  }

  .sub-images {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .proof-button {
    display: block;
    border-radius: 3px;
    overflow: hidden;
    flex: 1 1 14rem;
    max-width: 100%;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
    min-height: 0;
  }

  .proof-button:hover {
    outline: 1px solid var(--accent);
  }

  .proof-button img {
    display: block;
    width: 100%;
    max-height: 28rem;
    object-fit: contain;
    background: #000;
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .meta {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
  }

  .error {
    margin: 0.5rem 0;
    padding: 0.5rem 0.7rem;
    background: var(--danger-bg);
    border: 1px solid var(--danger);
    color: var(--danger);
    border-radius: 3px;
    font-size: 0.85rem;
  }

  .approve-checks {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0.25rem 0 0.6rem;
    padding: 0.6rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-alt);
  }

  .approve-checks legend {
    font-family: var(--font-heading);
    font-size: 0.72rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--muted);
    padding: 0 0.4rem;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.92rem;
    cursor: pointer;
  }

  /* Fully custom checkbox (appearance:none) so it inherits NONE of the global input
	   styling (padding/border/min-height) — that over-constrained native box re-resolves a
	   sub-pixel on check/focus and jiggled the row. Same fix as BoardAckModal; fixed 1.05rem
	   box, green check to keep the "approve" intent. */
  .check input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    box-sizing: border-box;
    width: 1.05rem;
    height: 1.05rem;
    min-height: 0;
    margin: 0;
    padding: 0;
    flex: 0 0 auto;
    display: grid;
    place-content: center;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 0.12s,
      background 0.12s;
  }

  .check input[type="checkbox"]::before {
    content: "";
    width: 0.58rem;
    height: 0.58rem;
    transform: scale(0);
    transition: transform 0.1s ease;
    background: var(--success);
    clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
  }

  .check input[type="checkbox"]:checked {
    border-color: var(--success);
  }

  .check input[type="checkbox"]:checked::before {
    transform: scale(1);
  }

  .check input[type="checkbox"]:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(127, 209, 138, 0.35);
  }

  .note-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.25rem 0 0.6rem;
  }

  .note-label {
    font-family: var(--font-heading);
    font-size: 0.78rem;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--text);
  }

  .note-label .muted {
    text-transform: none;
    letter-spacing: 0;
    font-family: inherit;
    font-size: 0.85em;
  }

  .note-field textarea {
    width: 100%;
    resize: vertical;
    padding: 0.5rem 0.6rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    font-size: 0.9rem;
  }

  .note-field textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .actions {
    display: grid;
    grid-template-columns: 1fr 0.7fr 1fr;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .actions form {
    display: contents;
  }

  .actions button {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1rem 0.75rem;
    font-family: var(--font-heading);
    font-size: 1rem;
    letter-spacing: 1px;
    border-radius: var(--radius);
    min-height: 5rem;
    text-shadow: none;
    transition:
      transform 0.1s,
      background 0.15s,
      border-color 0.15s,
      box-shadow 0.15s;
  }

  .actions button:active:not(:disabled) {
    transform: scale(0.97);
  }

  .actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .big-icon {
    font-size: 2.2rem;
    line-height: 1;
  }

  .label-text {
    font-size: 0.85rem;
    letter-spacing: 2px;
  }

  .reject {
    background: var(--danger-bg);
    border-color: var(--danger);
    color: var(--danger);
  }

  .reject:hover:not(:disabled) {
    background: rgba(255, 0, 0, 0.2);
    box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.4);
  }

  .approve {
    background: var(--success-bg);
    border-color: var(--success);
    color: var(--success);
  }

  .approve:hover:not(:disabled) {
    background: rgba(13, 193, 13, 0.25);
    box-shadow: 0 0 0 1px rgba(13, 193, 13, 0.5);
  }

  .skip {
    background: var(--surface-alt);
    border-color: var(--border);
    color: var(--muted);
  }

  .skip:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--text);
  }

  .last-action {
    margin: 0.7rem 0 0;
    text-align: center;
    font-size: 0.8rem;
  }

  button.primary {
    border-color: var(--accent);
  }

  button.primary:hover {
    background: var(--accent-soft);
  }

  /* --- Reviewed history --- */
  .reviewed {
    max-width: 46rem;
    margin: 0 auto;
  }

  .rev-search {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .rev-search input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.45rem 0.7rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font: inherit;
  }

  .rev-search input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .rev-search button.primary {
    border-color: var(--accent);
  }

  .rev-search button.primary:hover {
    background: var(--accent-soft);
  }

  .rev-hint {
    margin: 0 0 0.6rem;
    font-size: 0.82rem;
  }

  .pending-search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    max-width: 38rem;
    margin: 0 auto 0.6rem;
  }

  .pending-search input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.45rem 0.7rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font: inherit;
  }

  .pending-search input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .pending-search .clear-btn {
    font-size: 0.82rem;
    padding: 0.3rem 0.6rem;
    min-height: 0;
  }

  .match-count {
    font-size: 0.82rem;
    white-space: nowrap;
  }

  .rev-list {
    list-style: none;
    margin: 0.75rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .rev-card {
    padding: 0.85rem 1rem;
    background: linear-gradient(
      180deg,
      rgba(58, 48, 36, 0.85),
      rgba(40, 32, 24, 0.85)
    );
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
  }

  .rev-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 0.6rem;
    flex-wrap: wrap;
  }

  .status-badge {
    font-family: var(--font-heading);
    font-size: 0.72rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    padding: 0.2rem 0.55rem;
    border-radius: 3px;
    white-space: nowrap;
    border: 1px solid transparent;
  }

  .status-badge.approved {
    color: var(--success);
    border-color: var(--success);
    background: var(--success-bg);
  }

  .status-badge.rejected {
    color: var(--danger);
    border-color: var(--danger);
    background: var(--danger-bg);
  }

  .rev-tile {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.55rem;
  }

  .rev-task {
    font-family: var(--font-heading);
    color: var(--accent);
    font-size: 1rem;
  }

  .rev-proofs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .proof-thumb {
    display: block;
    width: 5.5rem;
    height: 5.5rem;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 3px;
    overflow: hidden;
    background: #000;
    cursor: pointer;
    min-height: 0;
  }

  .proof-thumb:hover {
    outline: 1px solid var(--accent);
  }

  .proof-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .rev-foot {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.6rem 0 0;
    font-size: 0.78rem;
  }

  .rev-foot .note {
    color: var(--text);
    font-style: italic;
  }

  .rev-actions {
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px dashed var(--border);
  }

  .rev-actions form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
  }

  .rev-note-input {
    flex: 1 1 14rem;
    min-width: 0;
    padding: 0.35rem 0.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }

  .rev-note-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .rev-btn {
    min-height: 0;
    padding: 0.4rem 0.7rem;
    font-size: 0.82rem;
    font-family: var(--font-heading);
    border-radius: 3px;
    white-space: nowrap;
  }

  .rev-btn.undo {
    background: var(--danger-bg);
    border: 1px solid var(--danger);
    color: var(--danger);
  }

  .rev-btn.undo:hover:not(:disabled) {
    background: rgba(255, 0, 0, 0.2);
  }

  .rev-btn.redo {
    background: var(--success-bg);
    border: 1px solid var(--success);
    color: var(--success);
  }

  .rev-btn.redo:hover:not(:disabled) {
    background: rgba(13, 193, 13, 0.25);
  }

  .rev-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .cap-hint {
    text-align: center;
    font-size: 0.78rem;
    margin: 0.9rem 0 0;
  }

  @media (max-width: 540px) {
    .card {
      padding: 1rem;
    }

    .actions button {
      min-height: 4.5rem;
      padding: 0.75rem 0.5rem;
    }

    .big-icon {
      font-size: 1.8rem;
    }

    .proof-button img {
      max-height: 22rem;
    }
  }
</style>
