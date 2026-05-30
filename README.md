# Facebook Reaction Audit

Small local tool for sampling Facebook post reactions and classifying profiles as
normal, suspicious, or clear-bot-like based on visible public profile signals.

This does not prove whether an account is automated. It is a practical sampling
aid for checking whether a reaction list obviously contains bot-like accounts.

## Setup

```sh
cd /tmp/facebook-reaction-audit
npm install
```

## Run

```sh
npm run sample -- \
  --post "https://www.facebook.com/jim4rankin/posts/pfbid0GbvhPek9tKnGU9bVfymoc75aPD6bQapowvGa1qbe6DERbfX8Ugps93ZpK9okr2B3l" \
  --reaction "Haha" \
  --target 100
```

The script opens a visible browser. Log in to Facebook manually if prompted.
After the post loads, the script opens the reaction list, samples visible
profiles, visits each sampled profile, and writes results to `results/`.

## Output

The sampler writes:

- `results/reactors.json`: sampled names and profile URLs
- `results/profile-checks.json`: per-profile classification and signals
- `results/summary.json`: totals

You can re-summarize later with:

```sh
npm run summarize -- results/profile-checks.json
```

## Classification

`normal`: profile has plausible human signals such as friends/followers,
location, work, education, photos, older posts, or a locked profile with a
realistic friend count.

`suspicious`: profile is unavailable, nearly empty, or lacks normal public
signals. This is not proof of bot activity.

`clear_bot_like`: reserved for very strong obvious patterns. The current rubric
is intentionally conservative and rarely emits this.

