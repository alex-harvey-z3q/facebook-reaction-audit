import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = parseArgs(process.argv.slice(2));
const postUrl = args.post;
const reaction = args.reaction || "Haha";
const target = Number(args.target || 100);
const outDir = args.out || "results";

if (!postUrl) {
  console.error('Usage: npm run sample -- --post "<facebook post url>" [--reaction Haha] [--target 100]');
  process.exit(1);
}

await fs.mkdir(outDir, { recursive: true });

// Run visibly so the operator can log in, pass 2FA/checkpoints, and see what
// Facebook is showing. Headless mode is more likely to trip platform defences.
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 420, height: 820 } });
const page = await context.newPage();

console.log("Opening post. Log in manually if Facebook prompts you.");
await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
await waitForReactionButton(page, reaction);

console.log(`Opening ${reaction} reaction list.`);
await page.getByRole("button", { name: new RegExp(`${escapeRegExp(reaction)}:`, "i") }).first().click();
await page.waitForTimeout(2000);

const reactors = await collectReactors(page, target);
await fs.writeFile(path.join(outDir, "reactors.json"), JSON.stringify(reactors, null, 2));
console.log(`Collected ${reactors.length} distinct profiles.`);

const checks = [];
for (const [index, reactor] of reactors.entries()) {
  const check = await checkProfile(context, reactor);
  checks.push(check);
  console.log(`${index + 1}/${reactors.length}: ${check.name} -> ${check.classification}`);

  // Persist after every profile so a partial run is still useful if Facebook
  // rate-limits, shows a checkpoint, or the browser crashes mid-sample.
  await fs.writeFile(path.join(outDir, "profile-checks.json"), JSON.stringify(checks, null, 2));
}

const summary = summarize(checks);
await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await browser.close();

async function waitForReactionButton(page, reactionName) {
  const button = page.getByRole("button", { name: new RegExp(`${escapeRegExp(reactionName)}:`, "i") });
  for (let i = 0; i < 90; i += 1) {
    if (await button.count()) return;
    await page.waitForTimeout(1000);
  }
  throw new Error(`Could not find a ${reactionName} reaction button. Is the post visible and are you logged in?`);
}

async function collectReactors(page, targetCount) {
  const reactors = [];
  const seen = new Set();
  let staleRounds = 0;

  // Facebook's reaction dialog is virtualized/lazy-loaded: only the rows near
  // the viewport exist in the DOM. We repeatedly read visible rows, dedupe them,
  // then scroll the dialog to cause the next batch to render.
  while (reactors.length < targetCount && staleRounds < 20) {
    const before = reactors.length;
    const visible = await page.evaluate(() => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 90 && r.top < innerHeight && r.left < 420;
      };

      return Array.from(document.querySelectorAll("a"))
        .filter(isVisible)
        .map((a) => {
          const rect = a.getBoundingClientRect();
          return {
            name: (a.innerText || "").trim().replace(/\s+/g, " "),
            href: (a.href || "").split("?")[0],
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
          };
        })
        // The reaction dialog rows are profile links in a narrow left column.
        // These filters remove page chrome, group links, tab labels, and other
        // links visible behind the modal.
        .filter((x) =>
          x.name &&
          x.href.includes("facebook.com/") &&
          !x.href.includes("/groups/") &&
          !x.href.endsWith("facebook.com/") &&
          x.rect.x >= 60 &&
          x.rect.x <= 95 &&
          !/Facebook|About|Friends|Photos|Videos|Reels|Posts|Reviews|Timeline/.test(x.name)
        );
    });

    for (const profile of visible) {
      if (seen.has(profile.href)) continue;
      seen.add(profile.href);
      reactors.push({ name: profile.name, href: profile.href });
      if (reactors.length >= targetCount) break;
    }

    // Stop after repeated scrolls produce no new profiles. That usually means
    // Facebook has stopped loading more rows or the selector hit the wrong pane.
    staleRounds = reactors.length === before ? staleRounds + 1 : 0;
    await scrollReactionDialog(page);
    await page.waitForTimeout(350);
  }

  return reactors;
}

async function scrollReactionDialog(page) {
  await page.evaluate(() => {
    // The modal does not expose a stable selector, so find the scrollable
    // container by geometry: left side of the viewport, visible, and scrollable.
    const containers = Array.from(document.querySelectorAll("div"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.left < 30 && r.top >= 80 && r.bottom <= innerHeight && el.scrollHeight > el.clientHeight + 40;
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    if (containers[0]) containers[0].scrollBy(0, 520);
    else window.scrollBy(0, 520);
  });
}

async function checkProfile(context, reactor) {
  const page = await context.newPage();
  try {
    // Some profiles are slow, private, or checkpointed. A failed navigation is
    // allowed to continue so the page text can still be classified if it loaded.
    await page.goto(reactor.href, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const text = await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 3000));
    const result = classifyProfile(text);
    return { ...reactor, ...result };
  } finally {
    await page.close().catch(() => {});
  }
}

function classifyProfile(text) {
  // These are weak public signals, not proof of identity. A locked profile with
  // friends/location/photos is treated as ordinary because many real Facebook
  // users expose little public content.
  const signals = [
    "No posts available",
    "This content isn’t available",
    "Add friend",
    "Message",
    "Follow",
    "Lives in",
    "From",
    "Work",
    "Education",
    "locked her profile",
    "locked his profile",
    "locked their profile",
    "friends",
    "followers",
    "Photos See all photos"
  ].filter((signal) => text.includes(signal));

  const hasNormalSignals = /(friends|followers|Lives in|From|Work|Education|Photos See all photos|locked (her|his|their) profile)/.test(text);

  // Be conservative: only call an account suspicious when the public profile is
  // unavailable or essentially empty without other human-context signals.
  if (text.includes("This content isn’t available")) {
    return { classification: "suspicious", signals, reason: "profile unavailable" };
  }

  if (text.includes("No posts available") && !hasNormalSignals) {
    return { classification: "suspicious", signals, reason: "empty public profile with few normal signals" };
  }

  return { classification: "normal", signals, reason: "normal personal signals or private/locked profile with plausible context" };
}

function summarize(checks) {
  const counts = checks.reduce(
    (acc, check) => {
      acc.total += 1;
      acc[check.classification] = (acc[check.classification] || 0) + 1;
      return acc;
    },
    { total: 0, normal: 0, suspicious: 0, clear_bot_like: 0 }
  );

  return {
    ...counts,
    note: "Classifications are profile-signal judgments, not proof of automation."
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    parsed[key] = value;
  }
  return parsed;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
