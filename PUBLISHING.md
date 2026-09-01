# Publishing Wireframy

Everything in this file is a step **you** take. The plugin itself is finished and
compliant — this is only the paperwork.

Two things must be true before you start:

- The GitHub username in `README.md` is right. It is currently `Divyaraj-M`, in
  two places — the release download link and the BRAT line. If that is not the
  account you want to publish from, change it before step 2; the docs check
  fails on an unfilled placeholder, but it cannot know you meant a *different*
  real account.
- The repository is named **`wireframy`** — the same as `id` in `manifest.json`.
  Nothing enforces this, but the install path, the BRAT string and the README
  links all read as one name when it holds, and confusingly when it does not.

---

## 1. Check the username

Already filled in as `Divyaraj-M`. Only if you want a different account:

```sh
cd wireframy
sed -i '' 's/Divyaraj-M/other-account/g' README.md   # macOS
```

## 2. Create the repository

On github.com → **New repository**:

| Field | Value |
| --- | --- |
| Name | `wireframy` |
| Description | the one line from `manifest.json` |
| Visibility | **Public** — a private repo cannot be reviewed |
| Initialise with README | **no**, one already exists here |

Then, from this folder:

```sh
git init
git add .
git commit -m "Wireframy 1.0.0"
git branch -M main
git remote add origin https://github.com/Divyaraj-M/wireframy.git
git push -u origin main
```

Add the topic `obsidian-plugin` to the repo (Settings, or the gear beside
"About"). It is how people find it on GitHub.

## 3. Cut the release

This is the step with the fiddly rules, and getting it wrong is the most common
reason a submission bounces.

```sh
git tag 1.0.0
git push origin 1.0.0
```

**The tag is `1.0.0`, not `v1.0.0`.** It must equal `version` in
`manifest.json` exactly. Obsidian reads the tag to find the release.

Then on GitHub → **Releases** → **Draft a new release**:

- **Tag**: choose the existing `1.0.0`
- **Title**: `1.0.0`
- **Attach these three files as individual assets** — drag them into the
  "Attach binaries" box one at a time:
  - `main.js`
  - `manifest.json`
  - `styles.css`

Not a zip. Not a folder. Three separate files. Obsidian downloads them by name
straight out of the release, so a zip means the plugin cannot install.

`manifest.json` must sit in the repo root **as well as** in the release assets.
Both copies are read, at different moments.

- Leave **"Set as a pre-release" unchecked.** A pre-release is invisible to the
  submission bot.
- Publish the release.

## 4. Submit

The old route was a pull request against `obsidianmd/obsidian-releases`. **That
is no longer how it works** — there is a portal now:

1. Go to **community.obsidian.md** and sign in with your Obsidian account.
2. Link your GitHub account when it asks.
3. **Add plugin** → give it `Divyaraj-M/wireframy`.
4. It validates the manifest and the release automatically. Anything it finds,
   it tells you immediately — fix it, publish a *new* release, and resubmit.

Then you wait. A human reviews it; the queue has historically run from a few
days to a few weeks. You get comments on the submission, not by email, so check
back.

## 5. When they ask for changes

You do not edit and resubmit. You:

1. Make the fix.
2. Bump `version` in `manifest.json` — `1.0.1`.
3. Commit, tag `1.0.1`, push the tag.
4. Publish a new release with the three assets attached again.
5. Reply on the submission saying which version to look at.

Same loop for every release afterwards, forever. Users get the update through
Obsidian's own updater; you never touch the store again.

---

## What the reviewers check

All of these already pass — this list is so you know what not to break later.

| Rule | Where it is enforced here |
| --- | --- |
| No `innerHTML` / `outerHTML` | `harness/compliance.test.js` |
| No `var` | same |
| No `console.log` left in | same |
| No `app` as a global — use `this.app` | same |
| No `activeLeaf` | same |
| No Node/Electron requires (must work on mobile) | same |
| `normalizePath()` on every user-supplied path | same |
| No regex lookbehind (breaks older iOS) | same |
| Modal titles via `titleEl`, not a hand-rolled `<h3>` | same |
| CSS namespaced, no bare element selectors | same |
| Obsidian CSS variables for plugin chrome | same |
| Sentence case in UI text | same |
| `id`, `name`, `version`, `minAppVersion`, `description`, `author` present | `manifest.json` |
| Repo name matches `id` | step 2 above |
| Tag matches `version`, no `v` | step 3 above |
| Three loose assets, no zip | step 3 above |

The suite that enforces them is not in this repository — it needs jsdom and a
headless Chromium, and it points at absolute paths in the workspace it was
written in. It is 15 suites and 419 assertions, and it is what green means in
the notes below; if you want it in the repo later it needs its paths made
relative first.

## The one thing that is not automated

Screenshots. `docs/editor.png`, `docs/icons.png`, `docs/arrow-label.png` and
`docs/export.png` are real captures of this build. If the UI changes
substantially, retake them — a README showing a version that no longer exists is
the fastest way to lose someone in the first ten seconds.
