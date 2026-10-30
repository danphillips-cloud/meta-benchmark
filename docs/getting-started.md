# Getting started with one-shot prompts

A one-shot prompt describes a complete small app in a single instruction. I use them as benchmark runs because they do real work. The model has to plan the files, write code, use tools, and check the result. The Overview page then shows where the time went.

These prompts are free with a Muse subscription. They need no API keys. Each one is scoped to a new folder inside its run workspace under `muse-runs/`. No tracked repo files should change.

## Run your first one

Start from the repo root.

```sh
muse login
./run-muse --minimal "what is 2+2"
```

That warm-up should take one model call. Open the results page at http://127.0.0.1:8765 and look at the time split. Then pick one of the app prompts below and run it as one command.

To see two Meta models attempt the same build, add the compare flag.

```sh
./run-muse --minimal --compare meta "PASTE ONE PROMPT HERE"
```

Compare mode runs each model in its own workspace. The Compare page lines up the recorded times. Pick a run there to find its files under that run folder in `muse-runs/`.

## What makes these prompts work

Every prompt below uses the same shape. It names the type of app and who it is for. It lists three to five features and names the main screens. It gives one clear design direction. It locks the technical scope to plain files that run offline. It asks for syntax checks before the final reply.

That structure matters more than length. "Build a store" leaves the model guessing. A prompt that names the shopper, the product grid, the cart behaviour, and the file rules gives it a finish line.

## Shared ground rules

I repeat the same constraints in every prompt. Repetition is the point. A one-shot prompt has to carry the whole brief because there is no follow-up round to repair missed details.

- Create exactly `index.html`, `style.css`, and `app.js` in one new folder.
- Use no external URLs, fonts, images, libraries, build step, or server.
- Open `index.html` from the filesystem to run the app.
- Seed the app with realistic sample data.
- Check the JavaScript syntax, then report the files, controls, and checks.

## 1. Project dashboard

This one suits a first long run. It mixes layout, state, drag interactions, search, and browser storage.

```sh
./run-muse --minimal "Build a project management dashboard for a small marketing team in a new folder named project-dashboard. Create exactly index.html, style.css, and app.js. Include a sidebar labelled Projects, Calendar, and Settings, a three-column Kanban board, and a summary strip showing open tasks per person. Seed it with nine realistic campaign tasks across three people. Let me add a task, search tasks by text, filter by owner, and drag cards between To do, Doing, and Done. Save changes in localStorage and add a reset sample data button. Use a white working surface, dark text, and one blue accent colour. Use no external URLs, fonts, images, libraries, build step, or server. It must work by opening index.html from the filesystem. Run node --check app.js if node is available. Fix any failure and rerun the check. Do not modify files outside project-dashboard. Final reply under 120 words with the controls, files created, and check result."
```

Open the finished `index.html`. Drag one card into Done. Refresh the page. The card should stay there.

## 2. Fitness tracker

This prompt asks for a mobile layout inside a normal browser page. It adds charts, tabs, forms, and saved activity data.

```sh
./run-muse --minimal "Build a mobile-first fitness tracker for gym members in a new folder named fitness-tracker. Create exactly index.html, style.css, and app.js. Use a phone-width layout with bottom tabs labelled Home, Workouts, Progress, and Profile. Home shows a daily step ring drawn with SVG, calories, active minutes, and today's workout list. Workouts lets me add an activity with type, minutes, and calories. Progress shows a seven-day bar chart drawn without libraries. Profile holds editable daily step and calorie goals. Seed seven days of realistic activity, save entries and goals in localStorage, and make every tab work. Use charcoal panels, white text, and one green accent colour. Use no external URLs, fonts, images, libraries, build step, or server. It must work by opening index.html from the filesystem. Run node --check app.js if node is available. Fix any failure and rerun the check. Do not modify files outside fitness-tracker. Final reply under 120 words with the controls, files created, and check result."
```

Add a workout, then open Progress. The new activity should appear in the totals.

## 3. Coffee store

This is the shopping prompt without the dangerous parts. It has a catalogue and a cart, but no payment provider, account system, or network calls.

```sh
./run-muse --minimal "Build a specialty coffee store for home brewers in a new folder named coffee-store. Create exactly index.html, style.css, and app.js. Show a compact sale banner, a searchable grid of eight coffees with origin, roast level, tasting notes, bag size, and price, plus filters for roast and brewing method. Draw simple bag artwork with CSS shapes instead of images. Add a cart drawer with quantity controls, a running total, and a simulated checkout button that clears the cart and shows an order confirmation. Let me switch a product between one bag and a monthly subscription with a lower repeat price. Save the cart in localStorage. Use warm paper tones, brown text, and one orange accent colour. Use no external URLs, fonts, images, libraries, build step, server, payment service, or user accounts. It must work by opening index.html from the filesystem. Run node --check app.js if node is available. Fix any failure and rerun the check. Do not modify files outside coffee-store. Final reply under 120 words with the controls, files created, and check result."
```

Add two different bags. Change one quantity. Refresh before checkout. The cart should come back with the same total.

## 4. Inventory tool

Internal tools make good benchmark prompts because the workflow is precise. This one covers tables, filters, data edits, and a file download.

```sh
./run-muse --minimal "Build an internal inventory tool for warehouse staff in a new folder named inventory-tool. Create exactly index.html, style.css, and app.js. Seed twelve products with SKU, name, location, stock, reorder level, and unit cost. Show a searchable table, location filter, low-stock rows marked in orange, and summary cards for product count, total units, stock value, and reorder alerts. Let me add a product, adjust stock with plus and minus controls, and export the current table as a CSV download. Save changes in localStorage and add a reset sample data button. Use a plain light workspace, compact rows, and one teal accent colour. Use no external URLs, fonts, images, libraries, build step, or server. It must work by opening index.html from the filesystem. Run node --check app.js if node is available. Fix any failure and rerun the check. Do not modify files outside inventory-tool. Final reply under 120 words with the controls, files created, and check result."
```

Export the CSV, then lower one item below its reorder level. The alert count should rise straight away.

## 5. Event landing page

Landing pages test layout and copy more than state. This one still has useful behaviour through its countdown, agenda, pricing, and form validation.

```sh
./run-muse --minimal "Build an event registration landing page for a one-day local web builders meetup in a new folder named meetup-landing. Create exactly index.html, style.css, and app.js. Include a sticky header, a hero with the event promise and two clear calls to action, a live countdown to a fixed future date written in the JavaScript, four speaker cards with CSS-only initials avatars, a timed agenda, three ticket tiers, venue details, and an early bird registration form. Validate name, email, and ticket choice on the page, show field errors inline, and replace the form with a confirmation after a valid simulated registration. Add an FAQ accordion and make the page work well at phone width. Use off-white sections, near-black text, and one red accent colour. Use no external URLs, fonts, images, libraries, build step, server, map embed, payment service, or real form submission. It must work by opening index.html from the filesystem. Run node --check app.js if node is available. Fix any failure and rerun the check. Do not modify files outside meetup-landing. Final reply under 120 words with the controls, files created, and check result."
```

Submit the form empty first. Fix the highlighted fields and submit again. The confirmation should replace the form.

## Make your own

Start with this frame and fill every bracket. Keep the first build to three to five features. Add the sixth feature in a later run if the first one lands cleanly.

```text
Build a [type of app] for [person or team] in a new folder named [folder].
Create exactly index.html, style.css, and app.js.
Main screens are [screen one], [screen two], and [screen three].
Let me [core action one], [core action two], and [core action three].
Seed it with [quantity and kind of realistic sample data].
Use [two or three plain design choices].
Save [what should persist] in localStorage.
Use no external URLs, fonts, images, libraries, build step, or server.
It must work by opening index.html from the filesystem.
Run node --check app.js if node is available.
Fix any failure and rerun the check.
Do not modify files outside [folder].
Final reply under 120 words with the controls, files created, and check result.
```

Then run it with `./run-muse --minimal` and the full prompt in quotes.

## Judge the run, not the sales pitch

Open the app before trusting the final reply. Try the main action on each screen. Refresh once to test saved state. Break one form on purpose. Shrink the browser to phone width.

Back on the results page, read the wall time split and the per-call chart. A fast run that skipped checks is a worse result than a slower run that shipped working files. The stopwatch tells you where time went. The app tells you whether the time bought anything.

## Source

The app categories and prompt shape come from Rocket's [guide to one-shot app generation prompts](https://www.rocket.new/blog/best-ai-prompts-for-one-shot-app-generation-guide-this-year). I started from its project dashboard, fitness tracker, coffee subscription store, inventory tool, and event registration page. I adapted those prompts for local Muse runs, offline files, and this benchmark. They do not use Rocket or any hosted app builder.


