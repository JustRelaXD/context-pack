# ContextPack

**It learns what you take on different outings, and warns you before you leave.**

Everyone has left the house and realised at the gate that the charger is still on the desk. The
usual answer is a checklist app, which just moves the problem: now you also have to maintain the
checklist.

ContextPack is the other approach. You say where you're going in your own words — *"college for a
lab"*, *"I'm going to a hackathon"* — and it answers with what you historically take, how confident
it is, and **why**, quoting your own logged trips. Confirm or skip each item and it learns. It also
learns the exceptions, so *"I don't need my laptop today"* is recorded as an exception rather than
overridden.

You never type a list. On a trip it has never seen, the app proposes items itself — *Lab coat,
Safety goggles, Calculator* for a lab — and each one you tap becomes a real item with real counts
behind it from then on. Those proposals carry no probability, because nothing has been observed
about them yet.

The product thesis, in one line:

> Don't make people maintain checklists. Learn their routines, recognise the context, predict what
> they might need, explain why, and learn from their corrections.

---

## The honest-claims rule

This is the part we actually care about, because a prediction app that overstates itself is
worthless the first time it's wrong.

| Claim | How it's enforced |
|---|---|
| "You confirmed your charger on 14 of your last 16 college trips" | Every number in a sentence comes from `ItemEvidence`, filled from the database. A Groq rewrite is **discarded** if it contains any number we did not supply (`numbersIntroduced`). |
| `confirmed` / `detected` / `inferred` are different things | `ConfirmationSource` is on every stored decision. Only an explicit "packed" counts as fact; everything else is `inferred`. Nothing in this app claims to detect physical objects. |
| The engine never reaches 100% | Global rates shrink toward a neutral prior, and the UI caps the display at 99%. Even 30 perfect trips yields ~99.8%, never certainty. |
| "You took" vs "you confirmed" | Statistics are only ever phrased as confirmations, because that is all we have. |
| Unanswered predictions teach nothing | Rows the app creates for you are written as `unanswered` + `inferred` and are excluded from the predictor's statistics. |
| A past prediction is not rewritten | The probability shown at trip time is stored on the row and never updated. The live estimate appears beside it, so history can always be audited. |
| A proposed item is not a prediction | Suggestions carry no probability, are stored nowhere, and teach the engine nothing until you tap one. The source is on screen: *proposed by AI* vs *common for this kind of trip*. |

---

## How it works

```
 "college for a lab"
        │
        ▼
  ┌───────────────┐    Jev (System One) reads the situation:
  │ context layer │    destination=college, purpose=lab, tags=[academic,lab]
  └───────────────┘    …falls back to keyword parsing if unavailable
        │
        ▼
  ┌───────────────┐    pure TypeScript, deterministic:
  │    engine     │    hierarchical Laplace smoothing over 4 evidence scopes,
  └───────────────┘    weather conditioning, exception damping, co-occurrence
        │
        ▼
  ┌───────────────┐    Groq rephrases the engine's own sentence.
  │  phrasing     │    Any invented number → discarded, template kept.
  └───────────────┘
        │
        ▼
  Charger 97% · ID card 99% · Umbrella 61%   →  Packed / Not needed / Why?
        │
        ▼
   stored  →  tomorrow's predictions are different because of today's answers
```

### The four evidence scopes

The heart of the learning model is one question: *how similar is a past trip to this one?*

| Scope | Weight | Meaning |
|---|---|---|
| `exact` | 1.0 | same destination, same purpose (or matching tags) |
| `destination` | 0.35 | same place, different reason |
| `sibling` | 0.5 | **different** place, same kind of outing |
| `global` | 0.15 | unrelated — only ever a weak prior |

`sibling` deliberately outweighs `destination`. The same *kind of outing* at a new place tells you
more about what someone carries than the same building for a different reason — which is how an
unheard-of hackathon predicts your project-night habits (laptop, charger, extension board) better
than your campus sports trips do. That is analogous-context prediction, and it falls out of the
weights rather than being a special case.

### Proposing items without inventing evidence

The catalog is closed so the engine can never predict something a person did not choose — but that
also means an app with no history has nothing useful to say, and a real person carries things we
never thought of. The suggestion list resolves that tension in three steps:

1. **Groq proposes** — the one job that genuinely needs a generative model, because Jev cannot
   write the string "lab coat".
2. **Jev scores** each candidate with a `score` rubric (*unlikely / plausible / likely for this
   outing*), and anything below *plausible* is dropped. One request scores the whole batch.
3. **The user adopts** — tapping a suggestion creates the item and marks it packed.

What makes this safe is what a suggestion does *not* do: it carries no probability (there are no
observations behind it, so a percentage would be fabricated), it is not stored on the trip, and it
teaches the engine nothing until the user taps it. The UI labels the source — *proposed by AI* for a
model-written list, *common for this kind of trip* for the rule-based table — and shows Jev's
verdict as words (*usually taken*), never as a number that could be mistaken for a real prediction.

Measured on the live keys, that produces things history alone never could:

| You type | Proposed |
|---|---|
| `college for a lab` | Lab coat, Safety goggles, Lab notebook, Pen, Calculator |
| `heading to the gym` | Gym bag, Towel, Gym shoes, Workout clothes, Gym membership card |
| `going to a new flat` | Backpack, Phone, Wallet, Notebook, Water bottle |

Anyone not on this screen is filtered out before it is shown, so the list never repeats the
predictions above it.

### Weather is a real condition, not a sentence

When a trip has a known weather state and at least two trips in that same state are on record, the
estimate is **conditioned** on it: the all-weather rate becomes the prior, the weather-matched trips
become the evidence. So an umbrella goes from *not shown at all* on a dry day to ~61% in the rain,
with the reason quoting only the rainy subset. A single wet afternoon cannot move anything, and a
trip with **no** weather recorded is treated as unknown, never as "clear".

### Exceptions, not corrections

- A same-day "not needed" suppresses today's alert and is recorded as evidence.
- *"I don't need this from now on"* becomes a `recurring` rule that **damps** the prediction rather
  than deleting it, so it can still surface when the situation changes.
- Defaulting to "today only" is deliberate: silently turning "not today" into "never" is the most
  annoying thing a system like this can do.

---

## Who does what

| Layer | Owner | Why |
|---|---|---|
| Item likelihoods | **code** | Rules that must not be hallucinated |
| Context extraction | **Jev** (`choice`, `noul`) | A closed-label decision, 70–500ms, no strings to parse |
| Exception parsing | **Jev** | Judgement over a fixed vocabulary |
| Item proposals | **Groq** generates, **Jev** scores (`score`) | Writing names needs a generative model; judging them does not. Jev returns typed decisions and cannot write prose, so Groq names and Jev ranks |
| Sentence phrasing | **Groq** | Jev cannot write prose either |
| Everything else | **code** | Deterministic, unit-tested, offline-capable |

**Every AI layer is optional.** With no keys at all the app runs end to end on the rule-based
parser and templated sentences — `CONTEXTPACK_AGENT=heuristic` forces exactly that, and it is what
the test suite uses. A rate limit degrades the wording, never the app.

---

## Run it

Requires Node 20+. No AWS account, no credit card, no cloud spend.

```bash
npm install
npm run seed          # ~56 days of believable history so the learning is visible
npm run demo          # build the UI and serve everything on http://localhost:4000
```

Or for development, in two terminals:

```bash
npm run dev:server    # API on :4000
npm run dev:web       # UI on :5173, proxying /api
```

Optional keys (everything works without them):

```bash
cp .env.example .env  # TYPESAFE_API_KEY=..., GROQ_API_KEY=...
npm run doctor        # validates keys, models and adapters without spending a generation
```

`npm run doctor` is worth running before a demo: it caught two real problems during the build — a
Groq model that no longer existed on the account, and an environment variable exported with a
typo'd name. It now also reports whether the suggester is really generating (*"6 proposed, 6 scored
by jev"*) or silently degraded to the rule-based table.

### Tests

```bash
npm test        # 113 tests
npm run typecheck
```

`service.test.ts` is the demo script asserted numerically: the learning curve, the weather lift, the
analogous-context match, the exception flow, and the honesty guarantees (unanswered predictions
never become evidence, a stored probability is never rewritten). `predict.test.ts` pins the engine's
edge cases, including that a single wet afternoon cannot move a prediction. `App.test.tsx` renders
the real screens against mocked API responses — it is what caught a crash where a missing field took
the whole app down — and asserts that 0.999 renders as **99%**, never 100%.

---

## Suggested 3-minute demo

1. **Cold start.** Say *"college for a lab"*. Everything is a 50/50 guess and the app says so:
   *"This is a guess, not a memory."* Underneath, the agent proposes things history cannot know
   yet — *Lab coat, Safety goggles, Lab notebook* — with no percentages on them.
2. **Learn.** Confirm a few items. The next trip is already different. Tapping a proposed item
   adopts it, and from then on it is predicted from real counts like everything else.
3. **Recalled.** Run the seed for the full picture: **99% ID card, 84% laptop, 75% lab kit** with
   *"you confirmed your ID card on 31 of your last 31 clear college trips"*.
4. **Weather.** The same trip in rain picks up the umbrella, quoting only the rainy subset —
   *"you confirmed your umbrella on 3 of your last 4 rainy college trips"*. On a dry day it isn't
   shown at all.
5. **Analogy.** *"I'm going to a hackathon"* — never logged, yet it suggests laptop, charger and
   extension board from your project nights, marked as a suggestion rather than an alert.
6. **Exception.** *"I don't need my laptop today"* → recorded, alert suppressed immediately, and the
   row shows both *what we said then* and *what we think now*.
7. **Audit.** The **Learned** tab shows the raw counts behind every prediction, and lets you forget
   an exception.

---

## Architecture

```
apps/web      React + Vite, mobile-first, no UI framework
apps/server   Node + Express: API, trip lifecycle, AI adapters, Open-Meteo
packages/shared  domain model, the prediction engine, pattern aggregation, the API contract
data/store.json  local persistence (gitignored)
```

Storage sits behind one `Store` interface with three adapters (`json`, `memory`, `dynamodb`). The
`json` adapter serialises writes and writes via temp-file + rename, so an interrupted write can't
corrupt the store. The API contract lives in `shared`, so a server field change breaks the build
rather than silently rendering `undefined`.

### Deploying to Vercel

The repo ships with `vercel.json` and `scripts/deploy-build.mjs`, so a Git-connected project needs
three settings from you and nothing else:

| Setting | Value | Why |
|---|---|---|
| **Framework Preset** | `Other` | The *Express* preset looks for a conventional single-file Express entry, whereas this is a monorepo whose server binds a port, loads a `.env` and flushes a file store — none of which exists in a serverless invocation. `vercel.json` pins `framework: null`, so `Other` agrees with the repo instead of fighting it. |
| **Root Directory** | empty (`./`) | `vercel.json` lives at the root. Point this at a workspace and Vercel never reads it, so none of the commands below apply. |
| **Production Branch** | `main` | See the note below. |

`api/index.ts` is the deployment target: one function that Express routes internally. It
deliberately does **not** import `server/src/index.ts` — that file calls `app.listen()` and exports
nothing, which is what produces `FUNCTION_INVOCATION_FAILED` on every path, including `/api/health`.

The build is a script rather than the platform's default pipeline, because the default pipeline
cannot ship this repo's imports. It writes Vercel's **Build Output API** by hand:

- **The function is one bundled file with no runtime imports** (esbuild, ~4 MB). The platform
transpiled `apps/server/src/*.ts` but left `@contextpack/shared` as an external import pointing at
TypeScript source, then shipped without it, so the deploy died on a missing
`node_modules/@contextpack/shared/src/index.ts`. Bundling removes the whole class of problem: nothing
to resolve at invocation, and no dependency tree to walk on a cold start. Verified by copying the
function into an empty directory with no `node_modules` anywhere above it and driving it over HTTP.
- **The function normalises its own path.** A rewrite may hand a function the destination path
(`/health`) instead of the original (`/api/health`), which would 404 every route. The entry adds the
prefix when it is missing, so the deploy is correct either way — and a test pins both shapes.
- **`installCommand` is `npm ci --include=dev`.** `--include=dev` because `NODE_ENV=production` makes
npm omit devDependencies, which is why a plain `npm install` died with `sh: 1: vite: not found`.
`npm ci` because node_modules should be decided by the lockfile rather than by ambient config: one
build arrived resolving `vite` but not the plugin declared next to it in the same `package.json`,
which no install command explains. The build command runs the install again itself, so the build
reconstructs the inputs it was promised instead of trusting the step before it.
- **The build does not use `@vitejs/plugin-react`.** It provides Fast Refresh, which is a dev-server
feature; `jsx: react-jsx` means esbuild — bundled with Vite — already compiles the JSX, so the dev
server imports it and the build never resolves it. That plugin was the second failure, and removing
the import removed it: deleting the package from an installed tree still produces a byte-identical
bundle.

Two non-obvious build details, both of which failed in that container before they were understood.

**`installCommand` must include `--include=dev`, and it uses `npm ci` rather than `npm install`.**
Vercel sets `NODE_ENV=production` for the build, and npm treats that as "omit devDependencies" — so a
plain `npm install` installs no build tooling at all and the build dies with `sh: 1: vite: not
found`. Locally this never shows up, because your shell has no `NODE_ENV` set. `npm ci` adds a second
property we need: node_modules is built from the lockfile exactly, so the installed tree cannot come
out *partial*. It did once — a build arrived where `vite` resolved but `@vitejs/plugin-react` did
not, which is not a tree any single install command predicts, and `npm ci` is the install whose
result is decided by the lockfile instead of by ambient config.

**The build does not use `@vitejs/plugin-react`, and must not depend on it.** That is what failed
next, with `Cannot find package '@vitejs/plugin-react'` while loading `vite.config.ts`. The plugin
provides React Fast Refresh, which is a dev-server feature; `jsx: react-jsx` in tsconfig means
esbuild — bundled with Vite — already compiles the JSX. So `vite.config.ts` imports it only when
serving, and the tests deliberately drop it too, which means they exercise the same transform that
ships. Verified by deleting the plugin from an installed tree and building: the build succeeds and
emits a byte-identical bundle, so this removes a dependency rather than changing the output.

Two consequences of running serverless, both stated rather than hidden:

| Constraint | What happens |
|---|---|
| The filesystem is read-only apart from `/tmp` | `CONTEXTPACK_STORE=json` cannot work, so the adapter defaults to `memory` when it sees `VERCEL`. `/api/diagnostics` reports `durable: false` and the UI header shows `store: memory (resets)`. |
| Nothing persists between invocations | A deployed instance starts with no history, so a visitor sees the cold-start view: honest 50/50 guesses rather than a fake track record. Worse, taps can fail: a follow-up request may land on an instance that never saw the trip. Fixed by the DynamoDB adapter below — run `npm run setup:aws`. |

The branch note: this repo has both `main` and `master`, and they are **different commits**. `master`
is the original first commit, from before `vercel.json`, `api/index.ts` and the deploy build existed,
so a project that deploys from it builds code this section does not describe and fails for reasons
found nowhere in these notes. Deploy from `main`. GitHub refuses to let a plain `git push` delete
`master` while it is the repository's default branch, which is why it is still there.

Set `TYPESAFE_API_KEY` and `GROQ_API_KEY` in the project's environment variables if you want the
model-backed path in the deployment; without them it runs on the rule-based parser and templated
sentences, which is still fully functional.

#### Making the deployment durable

A serverless platform runs more than one instance and they do not share memory, so with the default
`memory` adapter a trip created on one instance does not exist on the next request. The symptom is
instructive: `POST /api/trips/<id>/feedback` answers `400 {"error":"Unknown trip."}`, your taps stop
being recorded, and nothing is ever learned — the app cannot get smarter on a URL where it forgets
everything between requests.

So the deployed app needs durable storage, and DynamoDB is the adapter for it:

```bash
CONTEXTPACK_TABLE=contextpack AWS_REGION=<your region> npm run setup:aws
```

That one command creates the table if it is missing (on-demand billing, so there is no capacity to
pay for while idle), runs a real round trip through the **adapter** — including the property that
matters, that a *second* store instance reads what the first one wrote — and prints the
least-privilege IAM policy plus the variables to paste into Vercel. It writes under a dedicated
`setup-check` user and deletes what it wrote, so running it against a table that already holds a
history cannot damage it.

Then set `CONTEXTPACK_STORE=dynamodb`, `CONTEXTPACK_TABLE`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` in Vercel and redeploy.

On cost, since it decides whether this is worth doing: DynamoDB's always-free tier covers 25 GB of
storage and 25 read/write capacity units per month and, unlike most AWS free tiers, **it does not
expire**. This app is single-user: about 110 KB of data and a handful of requests per interaction.
There is nothing to activate and no bill at this scale — but note that creating any AWS account
requires a payment method on file, and hackathon credits are not needed here.

Two limits worth knowing rather than discovering: the adapter stores a user's history as **one
item**, because every prediction reads all of it (see the comments in
`apps/server/src/store/dynamodb.ts`), and a DynamoDB item is capped at 400 KB — so it fits one
person's history comfortably and is not the layout for many users. It also applies a 350 KB guard
and reports the size in kilobytes rather than passing AWS's rejection through.

**What is verified, and what is not.** The adapter's behaviour is tested against a fake document
client (12 tests: key layout, consistent reads, the conditional write that stops two instances
clobbering each other, ordering, isolation between users, the size guard, reset). The bundled
function was run with `CONTEXTPACK_STORE=dynamodb` and reached real DynamoDB, failing only on dummy
credentials. What has never run is the live table against real credentials — that is what
`npm run setup:aws` exists to do on your machine, because no AWS credential exists in the
environment this was built in.

### The deploy path (what is and isn't done)

Built locally, deployable as-is to a single process — which is honest about what it is:

| Piece | Local (built) | AWS (next) |
|---|---|---|
| UI | Vite build, served by the API | Amplify Hosting or the same process on App Runner |
| API | Express on :4000 | API Gateway + Lambda |
| Store | `json` adapter | `CONTEXTPACK_STORE=dynamodb` — same interface, third adapter, already written |
| Context + exceptions | Jev | unchanged |
| Item proposals | Groq generates, Jev ranks | either half swaps behind `ItemSuggester` |
| Phrasing | Groq | swap to Bedrock (same `ReasonPhraser` interface) |

We deliberately did **not** wire up EventBridge, Step Functions, Cognito or OpenSearch. None of them
are load-bearing for a CRUD app with one stats query, and a hackathon weekend spent on wiring them
would have bought nothing the demo can show. `dynamodb` is wired, because a deployment genuinely
cannot work without durable storage; the rest stay out until something needs them.

---

## Known limits

- **The engine only predicts items you have confirmed.** The catalog is closed at 20 items and the
  agent can only *propose* from outside it — nothing becomes predictable until you adopt it, and
  adopted items are ordinary user items from then on. So "the model suggested it" can never become
  "the app claims you took it".
- **Suggestion quality depends on the provider.** With no Groq key, proposals come from a hand-written
  table of common items by kind of outing: useful, but the same advice for everyone going to a gym.
  With a key, they are tailored and Jev-ranked; a rate limit degrades to the table without telling you,
  which is why the doctor reports which path actually ran.
- **Predictions are for items, not actions.** "Leave 10 minutes earlier" was in the brief and is not
  built.
- **One user.** No auth, no accounts; anything multi-user needs Cognito and a partition key.
- **The engine is deliberately not ML.** It's weighted hierarchical smoothing. When it says 91%, it
  means "14 of 15 in this context" — checkable by hand, which matters more here than sophistication.
- **Weather is rain/snow/temperature only**, and it won't geocode a place name that Open-Meteo
  doesn't know; when that happens the trip is logged normally without weather.
