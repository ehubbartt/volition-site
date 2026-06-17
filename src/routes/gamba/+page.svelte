<script lang="ts">
  import type { PageData } from "./$types";
  import { tick, onMount } from "svelte";
  import { enhance } from "$app/forms";
  import type { SubmitFunction } from "@sveltejs/kit";
  import PackOpener from "$lib/cards/PackOpener.svelte";
  import PackDisplay3D from "$lib/cards/PackDisplay3D.svelte";
  import {
    RARITY_BY_KEY,
    DEFAULT_CARD_BACK,
    isRareRarity,
    type Card,
  } from "$lib/cards/rarity";
  import { SFX_CRATE_SPIN, SFX_TICK, SFX_TOCK } from "$lib/cards/sfx";
  import { isVideoUrl } from "$lib/cards/config";
  import { prefersReducedMotion, detectWebgl } from "$lib/cards/glCapabilities";
  import { DEFAULT_PACK_FRONT, discountedPrice } from "$lib/cards/packs";
  import { formatGP } from "$lib/gp";
  import { rsnToSlug } from "$lib/rsn";
  import { page } from "$app/stores";

  let { data }: { data: PageData } = $props();

  // Warn users whose settings make the 3D packs static or slow, and tell them what to
  // change. 'none' = no WebGL, 'software' = no GPU accel (the "loads super slow" case),
  // 'reduce' = Reduce motion on. Dismissible per-kind (so a different issue still shows).
  let perfNotice = $state<null | "none" | "software" | "reduce">(null);
  const PERF_DISMISS_KEY = "vs_gamba_perf_notice";
  onMount(() => {
    const gl = detectWebgl();
    const kind =
      gl.tier === "none"
        ? "none"
        : prefersReducedMotion()
          ? "reduce"
          : gl.tier === "software"
            ? "software"
            : null;
    if (!kind) return;
    try {
      if (localStorage.getItem(PERF_DISMISS_KEY) === kind) return;
    } catch {
      /* ignore */
    }
    perfNotice = kind;
  });
  function dismissPerf() {
    const k = perfNotice;
    perfNotice = null;
    try {
      if (k) localStorage.setItem(PERF_DISMISS_KEY, k);
    } catch {
      /* ignore */
    }
  }

  // ---- Free weekly pack claim (clan members, once per week) ----
  let weeklyBusy = $state(false);
  let weeklyError = $state<string | null>(null);
  const submitWeekly: SubmitFunction = () => {
    weeklyBusy = true;
    weeklyError = null;
    return async ({ result, update }) => {
      if (result.type === "failure") {
        weeklyError =
          (result.data?.weeklyError as string) ?? "Could not claim the pack.";
      }
      weeklyBusy = false;
      // Refresh claim status + inventory (the claimed pack now shows as owned).
      await update({ reset: false });
    };
  };

  // "Prefer 2D packs" — show flat pack images instead of the rotating 3D packs in
  // the store grid (saved per-browser). Lighter on weak devices, or just preference.
  let noAnim = $state(false);
  onMount(() => {
    try {
      noAnim = localStorage.getItem("vs_gamba_no_anim") === "1";
    } catch {
      /* ignore */
    }
  });
  $effect(() => {
    try {
      localStorage.setItem("vs_gamba_no_anim", noAnim ? "1" : "0");
    } catch {
      /* ignore */
    }
  });

  // Warm the browser cache for the store packs' art so opening one is instant (even
  // before it scrolls into view / before three loads it). Skip when there's no WebGL —
  // those users get static images only, so there's no opener art to prefetch.
  onMount(() => {
    if (detectWebgl().tier === "none") return;
    const urls = new Set<string>();
    for (const p of [...data.packs, ...data.teaserPacks]) {
      if (p.front_url) urls.add(p.front_url);
      if (p.back_url) urls.add(p.back_url);
    }
    for (const u of urls) {
      const img = new Image();
      img.src = u;
    }
  });

  function timeAgo(iso: string): string {
    const s = Math.max(
      0,
      Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
    );
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function fullTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function finishLabel(finish: string): string {
    return finish === "holo" ? "Holo" : finish === "reverse" ? "Reverse" : "";
  }

  let openerOpen = $state(false);
  let opened = $state<Card[]>([]);
  let openedPack = $state<{
    name: string;
    front_url: string | null;
    back_url: string | null;
  } | null>(null);
  let opening = $state<string | null>(null); // id of the pack currently opening
  let errorMsg = $state<string | null>(null);
  // The just-opened pack's server id — a rare pull is forwarded to the Discord drops
  // feed only once the player actually SWIPES TO that card (see announceCard).
  let lastOpenId: string | null = null;

  // Fire-and-forget: announce ONE rare card the moment the player reveals/swipes to it.
  // The server re-derives the card from its own log and claims that card row, so this
  // can't be forged and won't double-post if they swipe back to the same card.
  async function announceCard(card: {
    id: string;
    rarity: string;
    finish?: string | null;
  }) {
    if (!lastOpenId || !card || !isRareRarity(card.rarity)) return;
    try {
      const fd = new FormData();
      fd.set("open_id", lastOpenId);
      fd.set("card_id", card.id);
      fd.set("finish", card.finish ?? "normal");
      await fetch("?/announceDrops", {
        method: "POST",
        body: fd,
        headers: { "x-sveltekit-action": "true" },
      });
    } catch {
      // best-effort — a failed forward just means the drop isn't posted
    }
  }

  // The White Pack is the launch set — flag it as "1st edition" in the store.
  function isFirstEdition(name: string): boolean {
    return name.trim().toLowerCase() === "white pack";
  }

  function canOpen(pack: PageData["packs"][number]): boolean {
    return (
      opening === null &&
      pack.card_count > 0 &&
      data.vp_balance >= discountedPrice(pack.cost_vp, pack.discount_vp_pct)
    );
  }

  const submitOpen: SubmitFunction = ({ formData }) => {
    opening = formData.get("pack_id")?.toString() ?? null;
    errorMsg = null;
    return async ({ result, update }) => {
      if (result.type === "success" && result.data?.ok) {
        opened = result.data.opened as Card[];
        openedPack = result.data.pack as typeof openedPack;
        lastOpenId = (result.data.openId as string | null) ?? null;
        openerOpen = true;
      } else if (result.type === "failure") {
        errorMsg =
          (result.data?.error as string) ?? "Could not open that pack.";
      } else if (result.type === "error") {
        errorMsg = "Something went wrong opening that pack.";
      }
      opening = null;
      // Refresh VP/GP balances (and pack list) from the server without resetting UI.
      await update({ reset: false });
    };
  };

  // ---- Convert wallet items → GP balance ----
  let convertBusy = $state(false);
  let convertMsg = $state<string | null>(null);

  const submitConvert: SubmitFunction = () => {
    convertBusy = true;
    convertMsg = null;
    return async ({ result, update }) => {
      if (result.type === "success" && result.data?.convertOk) {
        const gained = Number(result.data.gained ?? 0);
        convertMsg = `Converted ${formatGP(gained)} into your balance.`;
      } else if (result.type === "failure") {
        convertMsg =
          (result.data?.convertError as string) ?? "Could not convert your wallet.";
      } else if (result.type === "error") {
        convertMsg = "Something went wrong converting your wallet.";
      }
      convertBusy = false;
      await update({ reset: false });
    };
  };

  // ---- Gamba crates ----
  type CrateReward = {
    kind: "vp" | "item" | "role";
    amount: number;
    itemName: string | null;
    label: string;
    title: string;
    image: string;
    colorHex: string;
    chance: number;
    isFree: boolean;
  };

  type StoreView = "packs" | "crates";
  // Honour a ?tab=crates deep link (the Discord loot-crate "Open on site" button) so
  // it lands on the Crates tab; default to Packs otherwise.
  let view = $state<StoreView>(
    $page.url.searchParams.get("tab") === "crates" ? "crates" : "packs",
  );
  let crateBusy = $state<null | "free" | "paid">(null);
  let crateReward = $state<CrateReward | null>(null);
  let crateError = $state<string | null>(null);

  // ---- Crate spin (CSGO-style reel that lands on the won reward) ----
  type ReelCell = { label: string; image: string | null; colorHex: string };
  const CELL_W = 96;
  const CELL_GAP = 10;
  const STRIDE = CELL_W + CELL_GAP;
  const STRIP_LEN = 64;
  const SPIN_MS = 4700; // matches the ~4.7s slot-machine sound so the reel lands as it ends

  // ---- Crate spin sound ----
  let crateAudio: HTMLAudioElement | null = null;
  let crateAudioPrimed = false;
  function crateVolume(): number {
    // Reuse the pack-opener's saved volume so the two stay consistent.
    try {
      const v = parseFloat(localStorage.getItem("vs_po_volume") ?? "1");
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
    } catch {
      return 1;
    }
  }
  function ensureCrateAudio(): HTMLAudioElement | null {
    if (typeof Audio === "undefined") return null;
    if (!crateAudio) {
      crateAudio = new Audio(SFX_CRATE_SPIN);
      crateAudio.preload = "auto";
      try {
        crateAudio.load();
      } catch {
        /* ignore */
      }
    }
    return crateAudio;
  }
  // Unlock audio within the open-button gesture (mobile autoplay): play+pause muted
  // synchronously. The spin itself starts after the action's network round-trip, so
  // without this the play() would be outside the gesture and get blocked.
  function primeCrateAudio() {
    if (crateAudioPrimed) return;
    crateAudioPrimed = true;
    const a = ensureCrateAudio();
    if (!a) return;
    try {
      a.muted = true;
      void a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      a.muted = false;
    } catch {
      a.muted = false;
    }
  }
  function playCrateSpin() {
    const a = ensureCrateAudio();
    if (!a) return;
    const vol = crateVolume();
    if (vol <= 0) return;
    try {
      a.muted = false;
      a.volume = vol;
      a.currentTime = 0;
      void a.play().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  function stopCrateSpin() {
    if (crateAudio) {
      try {
        crateAudio.pause();
        crateAudio.currentTime = 0;
      } catch {
        /* ignore */
      }
    }
  }

  // ---- Per-cell tick/tock (preferred): a click each time a reel cell crosses the
  // marker, alternating tick↔tock. Auto-syncs to the reel's deceleration. Each is
  // a small round-robin pool so rapid clicks at the start can overlap. Falls back
  // to the single slot-machine clip if the tick/tock files aren't present.
  type ClickPool = {
    available: () => boolean;
    play: (v: number) => void;
    prime: () => void;
    stop: () => void;
  };
  function makeClickPool(url: string, size = 5): ClickPool {
    if (typeof Audio === "undefined")
      return { available: () => false, play() {}, prime() {}, stop() {} };
    let errored = false;
    const pool: HTMLAudioElement[] = [];
    for (let i = 0; i < size; i++) {
      const a = new Audio(url);
      a.preload = "auto";
      a.addEventListener("error", () => (errored = true), { once: true });
      try {
        a.load();
      } catch {
        /* ignore */
      }
      pool.push(a);
    }
    let idx = 0;
    return {
      available: () => !errored,
      play: (v) => {
        const a = pool[idx];
        idx = (idx + 1) % size;
        try {
          a.muted = false;
          a.volume = v;
          a.currentTime = 0;
          void a.play().catch(() => {});
        } catch {
          /* ignore */
        }
      },
      prime: () => {
        for (const a of pool) {
          try {
            a.muted = true;
            void a.play().catch(() => {});
            a.pause();
            a.currentTime = 0;
            a.muted = false;
          } catch {
            a.muted = false;
          }
        }
      },
      stop: () => {
        for (const a of pool) {
          try {
            a.pause();
            a.currentTime = 0;
          } catch {
            /* ignore */
          }
        }
      },
    };
  }
  let tickPool: ClickPool | null = null;
  let tockPool: ClickPool | null = null;
  let tickRaf = 0;
  function ensureClicks() {
    if (!tickPool) tickPool = makeClickPool(SFX_TICK);
    if (!tockPool) tockPool = makeClickPool(SFX_TOCK);
  }
  function clicksAvailable(): boolean {
    ensureClicks();
    return !!(tickPool?.available() && tockPool?.available());
  }
  function startTickLoop() {
    const el = stripEl;
    const vol = crateVolume();
    if (!el || vol <= 0) return;
    ensureClicks();
    // The marker sits at the viewport's horizontal center; the strip point under
    // it is (half - translateX). A box's left edge is at a multiple of STRIDE, so
    // a tick fires exactly when the marker line crosses a box edge (not mid-box).
    const half = (el.parentElement?.clientWidth || el.clientWidth || 320) / 2;
    let lastEdge = Math.floor(half / STRIDE); // strip starts at translateX ≈ 0
    let toggle = false;
    let lastAt = 0;
    const loop = (now: number) => {
      if (!crateSpinning) return; // stops on land / close
      let tx = 0;
      try {
        const t = getComputedStyle(el).transform;
        if (t && t !== "none") tx = new DOMMatrix(t).m41;
      } catch {
        /* ignore */
      }
      const edge = Math.floor((half - tx) / STRIDE); // box edge currently under the marker
      if (edge > lastEdge) {
        lastEdge = edge;
        if (now - lastAt >= 28) {
          // cap to keep the fast start from machine-gunning
          lastAt = now;
          (toggle ? tockPool : tickPool)?.play(vol);
          toggle = !toggle;
        }
      }
      tickRaf = requestAnimationFrame(loop);
    };
    tickRaf = requestAnimationFrame(loop);
  }
  function stopTickLoop() {
    if (tickRaf) {
      cancelAnimationFrame(tickRaf);
      tickRaf = 0;
    }
    tickPool?.stop();
    tockPool?.stop();
  }

  $effect(() => {
    ensureCrateAudio(); // preload on mount so the spin sound is instant
    ensureClicks();
  });

  let crateStrip = $state<ReelCell[]>([]);
  let winIndex = $state(0);
  let crateSpinning = $state(false);
  let crateLanded = $state(false);
  let stripEl = $state<HTMLDivElement | undefined>();
  let spinTimer: ReturnType<typeof setTimeout> | null = null;
  let spinAnim: Animation | null = null;

  function rewardCell(r: CrateReward): ReelCell {
    return {
      label: r.kind === "item" ? (r.itemName ?? r.label) : r.label,
      image: r.image || null,
      colorHex: r.colorHex,
    };
  }
  function randomCell(): ReelCell {
    const pool = data.crate?.reel ?? [];
    if (!pool.length) return { label: "?", image: null, colorHex: "#9a8c78" };
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  async function startSpin(reward: CrateReward) {
    if (spinTimer) clearTimeout(spinTimer);
    if (spinAnim) {
      spinAnim.cancel();
      spinAnim = null;
    }
    stopCrateSpin();
    stopTickLoop();
    winIndex = STRIP_LEN - 8;
    crateStrip = Array.from({ length: STRIP_LEN }, (_, i) =>
      i === winIndex ? rewardCell(reward) : randomCell(),
    );
    crateReward = reward;
    crateLanded = false;
    crateSpinning = true;

    // Always guarantee the result shows, even if animation can't run.
    spinTimer = setTimeout(land, SPIN_MS + 1000);

    try {
      // Wait for the reel to mount + lay out so we can measure it.
      await tick();
      await nextFrame();
      const el = stripEl;
      if (!el) return; // safety timer will land

      const vw = el.parentElement?.clientWidth || el.clientWidth || 320;
      const jitter = (Math.random() * 2 - 1) * (CELL_W * 0.3);
      const target = vw / 2 - (winIndex * STRIDE + CELL_W / 2) + jitter;

      // Reduce-motion still gets a (shorter) spin — it's a deliberate,
      // self-contained reveal the user asked for, not ambient motion.
      const reduce =
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
        false;
      const dur = reduce ? 1500 : SPIN_MS;

      // Web Animations API — animates reliably without CSS-transition reflow tricks.
      if (typeof el.animate === "function") {
        // Sound, synced to the spin (skipped for the shortened reduce-motion
        // spin so it doesn't overrun): per-cell tick/tock if those clips exist,
        // else the single slot-machine clip.
        if (!reduce) {
          if (clicksAvailable()) startTickLoop();
          else playCrateSpin();
        }
        spinAnim = el.animate(
          [
            { transform: "translateX(0px)" },
            { transform: `translateX(${target}px)` },
          ],
          {
            duration: dur,
            easing: "cubic-bezier(0.05, 0.8, 0.15, 1)",
            fill: "forwards",
          },
        );
        spinAnim.onfinish = () => land();
      } else {
        el.style.transform = `translateX(${target}px)`;
        land();
      }
    } catch {
      land();
    }
  }

  function land() {
    if (spinTimer) {
      clearTimeout(spinTimer);
      spinTimer = null;
    }
    if (crateLanded) return;
    crateSpinning = false;
    crateLanded = true;
    stopTickLoop();
  }

  function closeReveal() {
    if (spinTimer) clearTimeout(spinTimer);
    spinTimer = null;
    if (spinAnim) {
      spinAnim.cancel();
      spinAnim = null;
    }
    stopCrateSpin();
    stopTickLoop();
    crateReward = null;
    crateSpinning = false;
    crateLanded = false;
    crateStrip = [];
  }

  function pct(n: number): string {
    return n < 1 ? n.toFixed(2) : n.toFixed(1);
  }

  // Live countdown to the next free crate (resets at midnight UTC, matching the
  // bot's last_loot_date day boundary).
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  function msUntilNextUtcMidnight(fromMs: number): number {
    const d = new Date(fromMs);
    return (
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - fromMs
    );
  }

  function formatCountdown(ms: number): string {
    if (ms <= 0) return "soon";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    // Zero-pad the trailing unit so the string keeps a constant length as it ticks
    // (e.g. "9m 03s" not "9m 3s") — otherwise the line reflows 1↔2 lines each second.
    const pad = (n: number) => String(n).padStart(2, "0");
    if (h > 0) return `${h}h ${pad(m)}m`;
    if (m > 0) return `${m}m ${pad(s)}s`;
    return `${pad(s)}s`;
  }

  let freeCountdown = $derived(formatCountdown(msUntilNextUtcMidnight(now)));
  let weeklyCountdown = $derived(
    data.weeklyPack
      ? formatCountdown(new Date(data.weeklyPack.resetAt).getTime() - now)
      : "",
  );

  function submitCrate(which: "free" | "paid"): SubmitFunction {
    return () => {
      crateBusy = which;
      crateError = null;
      // Unlock the spin sounds within this click gesture (mobile autoplay).
      primeCrateAudio();
      ensureClicks();
      tickPool?.prime();
      tockPool?.prime();
      return async ({ result, update }) => {
        if (result.type === "success" && result.data?.crateOk) {
          startSpin(result.data.reward as CrateReward);
        } else if (result.type === "failure") {
          crateError =
            (result.data?.crateError as string) ?? "Could not open the crate.";
        } else if (result.type === "error") {
          crateError = "Something went wrong opening the crate.";
        }
        crateBusy = null;
        // Refresh VP + free-claim availability without resetting the UI.
        await update({ reset: false });
      };
    };
  }
</script>

<svelte:head>
  <title>Gamba · Volition</title>
</svelte:head>

<section class="gamba">
  <header class="hero">
    <div class="hero-glow"></div>
    <div class="hero-text">
      <h1>Gamba</h1>
      <p>
        Spend VP to rip open a pack — every card you pull lands straight in your
        collection.
      </p>
      <a class="collection-link" href="/me?tab=collection"
        >View your collection →</a
      >
    </div>
    <div class="balances">
      <div class="vp" title="Volition Points">
        <span class="vp-amount">{data.vp_balance.toLocaleString()}</span>
        <span class="vp-label">VP</span>
      </div>
      {#if data.isAdmin}
        <div class="vp gp" title="Wallet balance">
          <span class="vp-amount">{formatGP(data.gold_balance)}</span>
          <span class="vp-label">Wallet</span>
        </div>
      {/if}
    </div>
  </header>

  {#if perfNotice}
    <div class="perf-notice" role="status">
      <div class="perf-text">
        {#if perfNotice === "none"}
          <strong>3D packs aren’t available in this browser</strong>, so they show as
          static images. Turn on <em>hardware acceleration</em> in your browser settings,
          or open the site in a normal browser (Chrome/Edge/Firefox/Safari) rather than an
          in-app browser.
        {:else if perfNotice === "reduce"}
          <strong>Pack animations are turned off</strong> because your device has
          <em>Reduce motion</em> enabled, so packs show as static images. Turn off
          “Reduce motion” in your system accessibility settings to see the 3D packs.
        {:else}
          <strong>3D packs are loading slowly</strong> — your browser looks like it’s
          rendering without a GPU. Turn on <em>hardware acceleration</em> in your browser
          settings (then reload) for smooth packs.
        {/if}
      </div>
      <button type="button" class="perf-dismiss" onclick={dismissPerf} aria-label="Dismiss"
        >✕</button
      >
    </div>
  {/if}

  <div class="view-tabs">
    <button
      type="button"
      class:active={view === "packs"}
      onclick={() => (view = "packs")}>Packs</button
    >
    <button
      type="button"
      class:active={view === "crates"}
      onclick={() => (view = "crates")}>Crates</button
    >
  </div>

  {#if view === "packs"}
    {#if errorMsg}
      <div class="error">{errorMsg}</div>
    {/if}

    {#if data.weeklyPack}
      <div class="weekly-pack">
        <img
          class="wp-art"
          src={data.weeklyPack.front_url || DEFAULT_PACK_FRONT}
          alt={data.weeklyPack.name}
        />
        <div class="wp-body">
          <h2>Free weekly pack</h2>
          <p class="muted">
            A free <strong>{data.weeklyPack.name}</strong> every week.
            {#if data.weeklyPack.claimedThisWeek}
              Next one in <span class="cd">{weeklyCountdown}</span>.
            {/if}
          </p>
          {#if !data.weeklyPack.isMember}
            <span class="muted small">Only Volition clan members can claim the weekly pack.</span>
          {:else}
            <form method="POST" action="?/claimWeeklyPack" use:enhance={submitWeekly}>
              <button
                type="submit"
                class="primary"
                disabled={!data.weeklyPack.claimable || weeklyBusy}
              >
                {#if weeklyBusy}
                  Claiming…
                {:else if data.weeklyPack.claimedThisWeek}
                  Claimed · {weeklyCountdown}
                {:else}
                  Claim free pack
                {/if}
              </button>
            </form>
          {/if}
          {#if weeklyError}<span class="warn small">{weeklyError}</span>{/if}
        </div>
      </div>
    {/if}

    <div class="pack-tools">
      <label class="anim-toggle" title="Show flat pack images instead of the rotating 3D packs">
        <input type="checkbox" bind:checked={noAnim} />
        <span>2D packs (no animation)</span>
      </label>
    </div>

    {#if data.isAdmin && data.walletGpValue > 0}
      <div class="convert-panel">
        <div class="convert-text">
          <strong>Convert wallet items</strong>
          <span class="muted small">
            You have {formatGP(data.walletGpValue)} of items in your wallet. Convert them to a
            spendable balance (still cashable in-game) to buy packs.
          </span>
          {#if convertMsg}<span class="convert-msg">{convertMsg}</span>{/if}
        </div>
        <form
          method="POST"
          action="?/convertWallet"
          use:enhance={submitConvert}
          onsubmit={(e) => {
            if (
              !confirm(
                `Convert all wallet items (${formatGP(data.walletGpValue)})? This settles those items — you won't be paid for them separately in-game.`,
              )
            )
              e.preventDefault();
          }}
        >
          <button type="submit" class="primary" disabled={convertBusy}>
            {convertBusy ? "Converting…" : `Convert ${formatGP(data.walletGpValue)}`}
          </button>
        </form>
      </div>
    {/if}

    <div class="store" class:no-rail={data.recentRares.length === 0}>
      <div class="main">
        {#if data.packs.length === 0 && data.teaserPacks.length === 0}
          <div class="empty">
            <p>No packs are available right now.</p>
            <p class="muted">Check back soon.</p>
          </div>
        {:else}
          <div class="pack-grid">
            {#each data.packs as pack (pack.id)}
              {@const vpDisc = pack.discount_vp_pct ?? 0}
              {@const vpCost = discountedPrice(pack.cost_vp, pack.discount_vp_pct)}
              {@const affordable = data.vp_balance >= vpCost}
              {@const owned = pack.owned ?? 0}
              {@const gpDisc = pack.discount_pct ?? 0}
              {@const gpBase = pack.cost_gp ?? 0}
              {@const gpCost = discountedPrice(pack.cost_gp, pack.discount_pct)}
              {@const gpAffordable = gpBase > 0 && data.gold_balance >= gpCost}
              <article
                class="pack"
                class:dim={(!affordable && owned === 0) ||
                  pack.card_count === 0}
              >
                <div class="pack-art">
                  {#if noAnim}
                    <img
                      class="pack-flat"
                      src={pack.front_url || DEFAULT_PACK_FRONT}
                      alt={pack.name}
                      loading="lazy"
                    />
                  {:else}
                    <PackDisplay3D
                      front={pack.front_url}
                      back={pack.back_url}
                      name={pack.name}
                    />
                  {/if}
                  <span class="pack-tag">{pack.cards_per_pack} per open</span>
                  {#if owned > 0}
                    <span class="owned-tag">{owned} in inventory</span>
                  {/if}
                </div>
                <div class="body">
                  <strong class="name">
                    {pack.name}
                    {#if isFirstEdition(pack.name)}
                      <span class="edition">1st edition</span>
                    {/if}
                  </strong>
                  {#if pack.description}
                    <p class="desc muted">{pack.description}</p>
                  {/if}
                  <span class="muted small"
                    >{pack.card_count} card{pack.card_count === 1 ? "" : "s"} in
                    set</span
                  >

                  {#if owned > 0}
                    <!-- Player owns one+ — offer a FREE open from inventory first. -->
                    <div class="pack-actions">
                      <form
                        method="POST"
                        action="?/openOwned"
                        use:enhance={submitOpen}
                      >
                        <input type="hidden" name="pack_id" value={pack.id} />
                        <button
                          type="submit"
                          class="primary"
                          disabled={opening !== null || pack.card_count === 0}
                        >
                          {#if opening === pack.id}
                            Opening…
                          {:else if pack.card_count === 0}
                            No cards yet
                          {:else}
                            Open from inventory
                          {/if}
                        </button>
                      </form>
                      <form
                        method="POST"
                        action="?/open"
                        use:enhance={submitOpen}
                      >
                        <input type="hidden" name="pack_id" value={pack.id} />
                        <button
                          type="submit"
                          class="buy-more"
                          disabled={!canOpen(pack)}
                        >
                          Buy another · {vpCost.toLocaleString()} VP{#if vpDisc > 0}
                            <span class="off">{vpDisc}% off</span>{/if}
                        </button>
                      </form>
                    </div>
                    {#if !affordable}
                      <span class="warn small">Not enough VP to buy more</span>
                    {/if}
                    {#if data.isAdmin && gpBase > 0 && pack.card_count > 0}
                      <form
                        method="POST"
                        action="?/openWithGp"
                        use:enhance={submitOpen}
                        class="open-form gp-form"
                      >
                        <input type="hidden" name="pack_id" value={pack.id} />
                        <button
                          type="submit"
                          class="gp-buy"
                          disabled={opening !== null || !gpAffordable}
                        >
                          {#if opening === pack.id}Opening…{:else}Buy with wallet · {formatGP(
                              gpCost,
                            )}{#if gpDisc > 0}<span class="off">{gpDisc}% off</span>{/if}{/if}
                        </button>
                      </form>
                    {/if}
                  {:else}
                    <form
                      method="POST"
                      action="?/open"
                      use:enhance={submitOpen}
                      class="open-form"
                    >
                      <input type="hidden" name="pack_id" value={pack.id} />
                      <button
                        type="submit"
                        class="primary"
                        disabled={!canOpen(pack)}
                      >
                        {#if opening === pack.id}
                          Opening…
                        {:else if pack.card_count === 0}
                          No cards yet
                        {:else}
                          Rip open · {vpCost.toLocaleString()} VP{#if vpDisc > 0}
                            <span class="off">{vpDisc}% off</span>{/if}
                        {/if}
                      </button>
                    </form>

                    {#if !affordable && pack.card_count > 0}
                      <span class="warn small">Not enough VP</span>
                    {/if}

                    {#if data.isAdmin && gpBase > 0 && pack.card_count > 0}
                      <form
                        method="POST"
                        action="?/openWithGp"
                        use:enhance={submitOpen}
                        class="open-form"
                      >
                        <input type="hidden" name="pack_id" value={pack.id} />
                        <button
                          type="submit"
                          class="gp-buy"
                          disabled={opening !== null || !gpAffordable}
                        >
                          {#if opening === pack.id}Opening…{:else}Buy with wallet · {formatGP(
                              gpCost,
                            )}{#if gpDisc > 0}<span class="off">{gpDisc}% off</span>{/if}{/if}
                        </button>
                      </form>
                      {#if !gpAffordable}
                        <span class="warn small">Not enough — convert your wallet above</span>
                      {/if}
                    {/if}
                  {/if}
                </div>
              </article>
            {/each}

            {#each data.teaserPacks as pack (pack.id)}
              <article class="pack teaser">
                <div class="pack-art">
                  {#if noAnim}
                    <img
                      class="pack-flat"
                      src={pack.front_url || DEFAULT_PACK_FRONT}
                      alt={pack.name}
                      loading="lazy"
                    />
                  {:else}
                    <PackDisplay3D
                      front={pack.front_url}
                      back={pack.back_url}
                      name={pack.name}
                    />
                  {/if}
                  <span class="lock-tag">🔒 Coming soon</span>
                </div>
                <div class="body">
                  <strong class="name">{pack.name}</strong>
                  <span class="muted small locked-note">Locked</span>
                </div>
              </article>
            {/each}
          </div>
        {/if}
      </div>

      {#if data.recentRares.length > 0}
        <aside class="rail">
          <h2 class="rail-title"><span class="live"></span> Live rare drops</h2>
          <div class="rail-list">
            {#each data.recentRares as pull (pull.id)}
              {@const meta = RARITY_BY_KEY[pull.rarity]}
              {@const fin = finishLabel(pull.finish)}
              <article class="drop" style="--rare-color:{meta.color}">
                <div class="drop-art">
                  {#if isVideoUrl(pull.frontUrl)}
                    <!-- svelte-ignore a11y_media_has_caption -->
                    <video class="front" src={pull.frontUrl} autoplay loop muted playsinline
                    ></video>
                  {:else}
                    <img
                      class="front"
                      src={pull.frontUrl || DEFAULT_CARD_BACK}
                      alt={pull.cardName}
                      loading="lazy"
                    />
                  {/if}
                  {#each pull.layers as ly}
                    <img class="layer" src={ly.url} alt="" loading="lazy" />
                  {/each}
                </div>
                <div class="drop-info">
                  <strong class="drop-name" title={pull.cardName}
                    >{pull.cardName}</strong
                  >
                  <span class="drop-rarity" style="color:{meta.color}">
                    {meta.label}{#if fin}
                      · {fin}{/if}
                  </span>
                  {#if pull.packName}
                    <span class="drop-sub" title={pull.packName}
                      >from {pull.packName}</span
                    >
                  {/if}
                  <span class="drop-sub">
                    by
                    {#if pull.rsn}
                      <a href="/u/{rsnToSlug(pull.rsn)}">{pull.by}</a>
                    {:else}
                      {pull.by}
                    {/if}
                  </span>
                  <span class="drop-time" title={fullTime(pull.pulledAt)}
                    >{timeAgo(pull.pulledAt)}</span
                  >
                </div>
              </article>
            {/each}
          </div>
        </aside>
      {/if}
    </div>
  {:else}
    <div class="store" class:no-rail={data.recentCrateDrops.length === 0}>
      <div class="main">
        {#if crateError}
          <div class="error">{crateError}</div>
        {/if}

        <div class="crate-wrap">
          <article class="crate">
            <img class="crate-icon" src="/loot-box.png" alt="Loot crate" />
            <div class="crate-body">
              <h2>Gamba Crate</h2>
              <p class="muted">
                Roll for VP, rare items, or glory — the same odds as the Discord
                crate.
              </p>
              <div class="crate-actions">
                <form
                  method="POST"
                  action="?/claimFreeCrate"
                  use:enhance={submitCrate("free")}
                >
                  <button
                    type="submit"
                    class="primary"
                    disabled={!data.crate.freeAvailable || crateBusy !== null}
                  >
                    {#if crateBusy === "free"}
                      Opening…
                    {:else if data.crate.freeAvailable}
                      Free daily crate
                    {:else}
                      Claimed · {freeCountdown}
                    {/if}
                  </button>
                </form>
                {#if data.crate.paidEnabled}
                  <form
                    method="POST"
                    action="?/openCrate"
                    use:enhance={submitCrate("paid")}
                  >
                    <button
                      type="submit"
                      class="primary"
                      disabled={crateBusy !== null ||
                        data.vp_balance < data.crate.spinCost}
                    >
                      {#if crateBusy === "paid"}
                        Opening…
                      {:else}
                        Open · {data.crate.spinCost} VP
                      {/if}
                    </button>
                  </form>
                {/if}
              </div>
              {#if !data.crate.freeAvailable}
                <span class="muted small"
                  >Daily crate already claimed — next free one in <span
                    class="cd">{freeCountdown}</span
                  >
                  (resets midnight UTC).</span
                >
              {/if}
              {#if !data.crate.paidEnabled}
                <span class="muted small">Paid crate opens are currently disabled.</span>
              {:else if data.vp_balance < data.crate.spinCost}
                <span class="warn small">Not enough VP for a paid open</span>
              {/if}
            </div>
          </article>

          <details class="odds">
            <summary>Drop rates</summary>
            <ul>
              {#each data.crate.odds as o}
                <li>
                  <span class="odds-label" style="color:{o.color}"
                    >{o.label}</span
                  >
                  <span class="muted">{pct(o.pct)}%</span>
                </li>
              {/each}
            </ul>
          </details>
        </div>
      </div>

      {#if data.recentCrateDrops.length > 0}
        <aside class="rail">
          <h2 class="rail-title"><span class="live"></span> Live rare drops</h2>
          <div class="rail-list">
            {#each data.recentCrateDrops as drop (drop.id)}
              <article class="drop" style="--rare-color:{drop.colorHex}">
                <div class="drop-art">
                  {#if drop.image}
                    <img class="front" src={drop.image} alt="" loading="lazy" />
                  {:else}
                    <div class="drop-noimg">
                      {drop.kind === "vp" ? "VP" : "?"}
                    </div>
                  {/if}
                </div>
                <div class="drop-info">
                  <strong class="drop-name" title={drop.label}
                    >{drop.label}</strong
                  >
                  <span class="drop-sub"
                    >{drop.isFree ? "free crate" : "paid crate"}</span
                  >
                  <span class="drop-sub">
                    by
                    {#if drop.rsn}
                      <a href="/u/{rsnToSlug(drop.rsn)}">{drop.by}</a>
                    {:else}
                      {drop.by}
                    {/if}
                  </span>
                  <span class="drop-time" title={fullTime(drop.at)}
                    >{timeAgo(drop.at)}</span
                  >
                </div>
              </article>
            {/each}
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</section>

{#if openerOpen && openedPack}
  <PackOpener
    pack={openedPack}
    cards={opened}
    onClose={() => (openerOpen = false)}
    onCardView={(c) => announceCard(c)}
  />
{/if}

{#if crateReward}
  <div class="reveal-wrap">
    <button class="reveal-backdrop" aria-label="Close" onclick={closeReveal}
    ></button>
    <div
      class="reveal"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      style="--c:{crateReward.colorHex}"
    >
      <div class="reel-viewport">
        <div class="reel-marker"></div>
        <div class="reel-strip" bind:this={stripEl}>
          {#each crateStrip as cell, i (i)}
            <div
              class="reel-cell"
              class:win={crateLanded && i === winIndex}
              style="--cc:{cell.colorHex}"
            >
              {#if cell.image}
                <img src={cell.image} alt="" loading="lazy" />
              {:else}
                <span class="reel-text">{cell.label}</span>
              {/if}
            </div>
          {/each}
        </div>
        <div class="reel-fade"></div>
      </div>

      {#if crateLanded}
        <div class="reveal-burst"></div>
        <h3 class="reveal-title">{crateReward.title}</h3>
        <p class="reveal-detail">
          {#if crateReward.kind === "vp"}
            {crateReward.amount > 0
              ? `+${crateReward.amount} VP`
              : "Nothing this time"}
          {:else if crateReward.kind === "item"}
            {crateReward.itemName}
          {:else}
            King Gamba — assigned in Discord shortly
          {/if}
        </p>
        <span class="reveal-chance"
          >{crateReward.label} · {pct(crateReward.chance)}%</span
        >
        <button type="button" class="primary reveal-close" onclick={closeReveal}
          >Nice</button
        >
      {:else}
        <p class="reveal-spinning">Opening…</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gamba {
    max-width: 1100px;
    margin: 0 auto;
  }

  .muted {
    color: var(--muted);
  }

  .small {
    font-size: 0.8rem;
  }

  /* ---- Hero ---- */
  .hero {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    padding: 1.6rem 1.75rem;
    margin-bottom: 1.5rem;
    background: linear-gradient(
      135deg,
      rgba(70, 54, 30, 0.95),
      rgba(34, 27, 20, 0.95)
    );
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }

  .hero-glow {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(
      120% 140% at 100% 0%,
      rgba(255, 152, 31, 0.22),
      transparent 55%
    );
  }

  .hero-text {
    position: relative;
    min-width: 0;
  }

  .hero h1 {
    margin: 0 0 0.3rem;
    font-size: 2.4rem;
    line-height: 1;
    color: var(--accent);
    text-shadow: var(--ts);
    letter-spacing: 0.5px;
  }

  .hero-text p {
    margin: 0;
    max-width: 38rem;
    color: var(--muted);
    font-size: 0.95rem;
  }

  .collection-link {
    display: inline-block;
    margin-top: 0.7rem;
    padding: 0.4rem 0.85rem;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 0.9rem;
    color: var(--accent);
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 999px;
    text-decoration: none;
    transition:
      background 0.15s,
      transform 0.1s;
  }

  .collection-link:hover {
    background: rgba(255, 152, 31, 0.22);
    transform: translateY(-1px);
  }

  .vp {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    padding: 0.55rem 1.2rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: 999px;
    text-shadow: var(--ts);
    flex: 0 0 auto;
    box-shadow: 0 0 1.2rem -0.3rem var(--accent);
  }

  .vp-amount {
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 1.6rem;
    color: var(--accent);
  }

  .vp-label {
    color: var(--accent);
    font-size: 0.85rem;
  }

  .balances {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    flex: 0 0 auto;
  }

  /* GP balance badge — gold variant of the VP badge. */
  .vp.gp {
    background: rgba(255, 215, 0, 0.1);
    border-color: #e9c349;
    box-shadow: 0 0 1.2rem -0.3rem #e9c349;
  }
  .vp.gp .vp-amount,
  .vp.gp .vp-label {
    color: #e9c349;
  }

  .convert-panel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
    padding: 0.8rem 1rem;
    background: rgba(255, 215, 0, 0.06);
    border: 1px solid rgba(233, 195, 73, 0.45);
    border-radius: var(--radius);
  }
  .convert-text {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 16rem;
  }
  .convert-text strong {
    color: #e9c349;
  }
  .convert-msg {
    color: #7fd18a;
    font-size: 0.85rem;
  }

  /* GP buy button — gold, distinct from the orange VP primary. */
  .gp-buy {
    width: 100%;
    border: 1px solid #e9c349;
    background: rgba(255, 215, 0, 0.1);
    color: #e9c349;
  }
  .gp-buy:hover:not(:disabled) {
    background: rgba(255, 215, 0, 0.2);
  }
  .gp-buy:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .gp-form {
    margin-top: 0.4rem;
  }

  .error {
    background: var(--danger-bg);
    border: 1px solid var(--danger);
    color: var(--danger);
    padding: 0.6rem 0.8rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  /* Capability/perf hint (no WebGL / no GPU / reduce-motion) */
  .perf-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    margin-bottom: 1.25rem;
    padding: 0.7rem 0.9rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .perf-text {
    min-width: 0;
  }

  .perf-text :global(em) {
    font-style: normal;
    color: var(--accent);
  }

  .perf-dismiss {
    flex: 0 0 auto;
    min-height: auto;
    padding: 0.1rem 0.45rem;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    line-height: 1;
  }

  .perf-dismiss:hover {
    color: var(--text);
    border-color: var(--border-strong);
  }

  /* ---- Store layout: packs + live-drops rail ---- */
  .store {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18rem;
    gap: 1.5rem;
    align-items: start;
  }

  .store.no-rail {
    grid-template-columns: 1fr;
  }

  /* min-width:0 lets these grid columns hold scrolling/overflowing content
	   (the pack grid, the drops strip) without blowing the page width out. */
  .main {
    min-width: 0;
  }

  .empty {
    padding: 3rem 1rem;
    text-align: center;
  }

  .empty p {
    margin: 0.25rem 0;
  }

  /* Free weekly pack claim banner (Packs tab) */
  .weekly-pack {
    display: flex;
    align-items: center;
    gap: 1.1rem;
    padding: 1.1rem 1.25rem;
    margin-bottom: 1.25rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }
  .wp-art {
    flex: 0 0 auto;
    width: 4.5rem;
    aspect-ratio: 5 / 7;
    object-fit: contain;
    border-radius: var(--radius);
  }
  .wp-body {
    min-width: 0;
  }
  .wp-body h2 {
    margin: 0 0 0.2rem;
    color: var(--accent);
    text-shadow: var(--ts);
    font-size: 1.1rem;
  }
  .wp-body p {
    margin: 0 0 0.6rem;
    font-size: 0.9rem;
  }
  .wp-body .primary {
    width: auto;
  }
  .wp-body .warn {
    display: block;
    margin-top: 0.4rem;
  }

  /* "Prefer 2D packs" toggle + the flat pack image it switches to */
  .pack-tools {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.75rem;
  }
  .anim-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.85rem;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .anim-toggle input {
    accent-color: var(--accent);
  }
  .pack-flat {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .pack-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 1.25rem;
  }

  .pack {
    display: flex;
    flex-direction: column;
    background: linear-gradient(
      180deg,
      rgba(58, 48, 36, 0.85),
      rgba(40, 32, 24, 0.85)
    );
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-card);
    overflow: hidden;
  }

  /* No hover lift/glow: the card itself isn't clickable — only the View cards and
	   Rip open buttons act. */

  .pack.dim {
    opacity: 0.6;
  }

  .pack-art {
    position: relative;
    width: 100%;
    aspect-ratio: 5 / 7;
    background: #120d08;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
  }

  .pack-tag {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 2;
    padding: 0.1rem 0.5rem;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid var(--accent);
    border-radius: 999px;
    font-size: 0.7rem;
    color: var(--accent);
    text-shadow: var(--ts);
  }

  .owned-tag {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    padding: 0.1rem 0.5rem;
    background: var(--accent);
    color: #1a1206;
    border-radius: 999px;
    font-size: 0.7rem;
    /* The site's fonts (rsbold AND the body rssmall) are PIXEL fonts — only crisp
       near their native ~16px size, so they blur at this small badge size. Use a
       real anti-aliased sans here so the label stays sharp. */
    font-family: ui-sans-serif, system-ui, Arial, sans-serif;
    font-weight: 600;
    /* Plain dark drop shadow for separation — the old accent glow bled colour
       around the edges and made it read as fuzzy. */
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  }

  /* Inline "% off" chip shown next to the discounted price in a buy button. */
  .off {
    margin-left: 0.4rem;
    padding: 0.02rem 0.32rem;
    border-radius: 999px;
    background: #d6362f;
    color: #fff;
    font-family: ui-sans-serif, system-ui, Arial, sans-serif;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* Locked "coming soon" teaser pack: art + name only, no actions. */
  .lock-tag {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 2;
    padding: 0.1rem 0.5rem;
    background: rgba(0, 0, 0, 0.72);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 0.7rem;
    color: var(--muted);
    font-family: ui-sans-serif, system-ui, Arial, sans-serif;
    font-weight: 600;
  }

  .pack.teaser {
    cursor: default;
  }

  .pack.teaser .locked-note {
    margin-top: auto;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-family: ui-sans-serif, system-ui, Arial, sans-serif;
  }

  /* Live countdown: keep it on one token (never split across lines) + equal-width
     digits so the surrounding sentence doesn't reflow as it ticks. */
  .cd {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.85rem;
    flex: 1;
  }

  .pack-actions {
    margin-top: auto;
    padding-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  /* Inventory-open + buy-another share one size (override .primary's rsbold/size). */
  .pack-actions button {
    width: 100%;
    font-size: 0.85rem;
    font-family: var(--font-body);
  }

  .pack-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .name {
    font-size: 1.1rem;
  }

  .edition {
    display: inline-block;
    margin-left: 0.4rem;
    padding: 0.08rem 0.45rem;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 0.62rem;
    letter-spacing: 1px;
    text-transform: uppercase;
    vertical-align: middle;
    color: var(--yellow);
    border: 1px solid var(--yellow);
    border-radius: 999px;
    text-shadow: none;
    white-space: nowrap;
  }

  .desc {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.35;
  }

  .open-form {
    margin-top: auto;
    padding-top: 0.5rem;
  }

  button.primary {
    width: 100%;
    border-color: var(--accent);
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
  }

  button.primary:hover:not(:disabled) {
    background: var(--accent-soft);
    box-shadow: 0 0 0.8rem -0.2rem var(--accent);
  }

  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .warn {
    color: var(--danger);
    text-align: center;
  }

  /* ---- Packs / Crates view tabs ---- */
  .view-tabs {
    display: inline-flex;
    gap: 0.25rem;
    margin-bottom: 1.25rem;
    padding: 0.25rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .view-tabs button {
    min-height: auto;
    padding: 0.4rem 1.1rem;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--muted);
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
  }

  .view-tabs button.active {
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  /* ---- Crate view ---- */
  .crate-wrap {
    max-width: 30rem;
    margin: 0 auto;
  }

  .crate {
    display: flex;
    gap: 1.1rem;
    align-items: center;
    padding: 1.25rem;
    background: linear-gradient(
      180deg,
      rgba(58, 48, 36, 0.85),
      rgba(40, 32, 24, 0.85)
    );
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-card);
  }

  .crate-icon {
    flex: 0 0 auto;
    width: 5rem;
    height: 5rem;
    object-fit: contain;
    padding: 0.4rem;
    background: var(--accent-soft);
    border: 1px solid var(--accent);
    border-radius: var(--radius);
    box-shadow: 0 0 1rem -0.2rem var(--accent);
  }

  .crate-body {
    min-width: 0;
  }

  .crate-body h2 {
    margin: 0 0 0.2rem;
    color: var(--accent);
    text-shadow: var(--ts);
  }

  .crate-body p {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
  }

  .crate-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .crate-actions form {
    flex: 1 1 8rem;
  }

  .crate-actions .primary {
    width: 100%;
  }

  .crate-body .small {
    display: block;
    margin-top: 0.5rem;
  }

  .odds {
    margin-top: 1rem;
    background: var(--surface-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.6rem 0.9rem;
  }

  .odds summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.9rem;
  }

  .odds ul {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .odds li {
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
  }

  .odds-label {
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
  }

  /* ---- Crate reveal modal ---- */
  .reveal-wrap {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: grid;
    /* minmax(0, 1fr) stops the wide reel strip from blowing out the grid track
		   (which otherwise pushes the centered modal off-screen). */
    grid-template-columns: minmax(0, 1fr);
    place-items: center;
    padding: 1rem;
  }

  .reveal-backdrop {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding: 0;
    border: none;
    border-radius: 0;
    background: rgba(0, 0, 0, 0.72);
    cursor: pointer;
  }

  .reveal {
    position: relative;
    z-index: 1;
    width: min(32rem, 100%);
    max-width: 32rem;
    min-width: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.6rem 1.5rem;
    text-align: center;
    background: linear-gradient(
      180deg,
      rgba(48, 40, 30, 0.98),
      rgba(30, 24, 18, 0.98)
    );
    border: 1px solid var(--c);
    border-radius: var(--radius-lg);
    box-shadow: 0 0 2.5rem -0.5rem var(--c);
    animation: reveal-pop 0.32s cubic-bezier(0.2, 1.3, 0.5, 1);
  }

  @keyframes reveal-pop {
    from {
      transform: scale(0.6);
      opacity: 0;
    }
    to {
      transform: scale(1);
      opacity: 1;
    }
  }

  .reveal-burst {
    position: absolute;
    top: 4.5rem;
    width: 12rem;
    height: 12rem;
    border-radius: 50%;
    background: radial-gradient(
      circle,
      color-mix(in srgb, var(--c) 55%, transparent),
      transparent 65%
    );
    pointer-events: none;
    animation: burst 0.6s ease-out forwards;
  }

  @keyframes burst {
    from {
      transform: scale(0.2);
      opacity: 0.9;
    }
    to {
      transform: scale(1.4);
      opacity: 0;
    }
  }

  /* ---- Crate spin reel ---- */
  .reel-viewport {
    position: relative;
    width: 100%;
    height: 116px;
    margin-bottom: 0.4rem;
    overflow: hidden;
    background: #0d0a07;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .reel-strip {
    display: flex;
    gap: 10px;
    align-items: center;
    height: 100%;
    will-change: transform;
  }

  .reel-cell {
    flex: 0 0 96px;
    width: 96px;
    height: 96px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--cc) 50%, #2a2018);
    background: linear-gradient(
      180deg,
      color-mix(in srgb, var(--cc) 28%, #2a2018),
      #14100a
    );
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.45);
    transition:
      transform 0.25s ease,
      box-shadow 0.25s ease;
  }

  .reel-cell img {
    width: 74%;
    height: 74%;
    object-fit: contain;
  }

  .reel-text {
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 0.78rem;
    text-align: center;
    line-height: 1.15;
    padding: 0 4px;
    color: var(--cc);
    text-shadow: var(--ts);
  }

  .reel-cell.win {
    border-color: var(--cc);
    box-shadow:
      0 0 14px var(--cc),
      inset 0 0 0 1px var(--cc);
    transform: scale(1.06);
  }

  .reel-marker {
    position: absolute;
    top: -2px;
    bottom: -2px;
    left: 50%;
    width: 2px;
    transform: translateX(-50%);
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
    z-index: 2;
  }

  .reel-marker::before,
  .reel-marker::after {
    content: "";
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
  }

  .reel-marker::before {
    top: -1px;
    border-top: 7px solid var(--accent);
  }

  .reel-marker::after {
    bottom: -1px;
    border-bottom: 7px solid var(--accent);
  }

  .reel-fade {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    background: linear-gradient(
      90deg,
      #0d0a07 0%,
      transparent 14%,
      transparent 86%,
      #0d0a07 100%
    );
  }

  .reveal-spinning {
    margin: 0;
    color: var(--muted);
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    letter-spacing: 1px;
  }

  .reveal-title {
    margin: 0;
    color: var(--c);
    text-shadow: var(--ts);
  }

  .reveal-detail {
    margin: 0;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 1.3rem;
  }

  .reveal-chance {
    font-size: 0.8rem;
    color: var(--muted);
  }

  .reveal-close {
    margin-top: 0.6rem;
    border-color: var(--accent);
  }

  /* ---- Live-drops rail ---- */
  .rail {
    position: sticky;
    top: 1rem;
    min-width: 0;
    background: linear-gradient(
      180deg,
      rgba(48, 40, 30, 0.7),
      rgba(34, 28, 22, 0.7)
    );
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 0.9rem;
  }

  .rail-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.85rem;
    font-size: 1.05rem;
    color: var(--accent);
    text-shadow: var(--ts);
  }

  .live {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: #ff4d4d;
    box-shadow: 0 0 0.5rem #ff4d4d;
    animation: pulse 1.6s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.4;
      transform: scale(0.7);
    }
  }

  .rail-list {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    max-height: calc(100vh - 9rem);
    overflow-y: auto;
  }

  .drop {
    display: flex;
    gap: 0.55rem;
    padding: 0.45rem;
    background: var(--surface-alt);
    border: 1px solid var(--rare-color);
    border-radius: var(--radius);
    box-shadow: 0 0 0.5rem -0.15rem var(--rare-color);
  }

  .drop-art {
    position: relative;
    flex: 0 0 3rem;
    align-self: center;
    line-height: 0;
  }

  /* The front image defines the box, so it sizes to the card's real proportions —
	   no fixed aspect-ratio means no letterbox bars and no cropping. */
  .drop-art .front {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 3px;
  }

  /* Depth layers stacked over the front (flat composite) — matches the collection. */
  .drop-art .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }

  /* Fallback tile for a drop with no art (e.g. a plain VP win). */
  .drop-noimg {
    width: 100%;
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    border-radius: 3px;
    background: color-mix(in srgb, var(--rare-color) 22%, #000a);
    color: var(--rare-color);
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    font-size: 0.78rem;
  }

  .drop-info {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.05rem;
    min-width: 0;
    flex: 1;
  }

  .drop-name {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .drop-rarity {
    font-size: 0.72rem;
    font-family: "rsbold", ui-sans-serif, Arial, sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .drop-sub {
    font-size: 0.7rem;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .drop-time {
    font-size: 0.68rem;
    color: var(--muted-soft, var(--muted));
  }

  /* ---- Mobile: stack, and move the live feed up as a horizontal strip of the
	   same compact rows (just scrolling sideways) ---- */
  @media (max-width: 860px) {
    .store {
      grid-template-columns: 1fr;
    }

    .rail {
      position: static;
      order: -1;
    }

    .rail-list {
      flex-direction: row;
      max-height: none;
      overflow-x: auto;
      overflow-y: visible;
      padding-bottom: 0.5rem;
      scroll-snap-type: x proximity;
    }

    .drop {
      flex: 0 0 14rem;
      scroll-snap-align: start;
    }
  }

  @media (max-width: 540px) {
    .hero {
      padding: 0.9rem 1rem;
      margin-bottom: 1rem;
    }

    .hero h1 {
      font-size: 1.5rem;
      margin-bottom: 0.15rem;
    }

    .hero-text p {
      font-size: 0.82rem;
    }

    .vp {
      padding: 0.4rem 0.9rem;
    }

    .vp-amount {
      font-size: 1.25rem;
    }

    .pack-grid {
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    .body {
      padding: 0.6rem;
      gap: 0.3rem;
    }

    .name {
      font-size: 0.95rem;
    }

    button.primary {
      font-size: 0.85rem;
      padding: 0.5rem 0.35rem;
    }
  }
</style>
