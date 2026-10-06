# Flipp Weekly Flyer API: Flyer Deals by Postal Code to CSV (Python + Node.js)

[![Flipp Flyer Deals Scraper on Apify][badge]][actor]

**Weekly flyer deals from 2,500+ Canadian and US retailers**, by postal code or ZIP, exported to **Excel (.xlsx), CSV or JSONL**: product, store, sale price, per-item price for multi-buys, $/kg, regular price, discount, valid dates, and (optionally) size, SKU and product link. Search every flyer near you for a product, pull every item in every flyer, or get a weekly digest of price drops.

Instead of writing and maintaining your own Flipp scraper, the scripts here (Python and Node.js) call a hosted Actor on Apify, the [Flipp Flyer Deals Scraper][actor]. You need an Apify API token. You don't need a Flipp account or API key.

> Not affiliated with or endorsed by Flipp or any retailer named here. Public flyer data only.

| Script | What it does |
|---|---|
| `search.mjs` / `search.py` | Search terms + postal codes or ZIPs → every matching deal, lowest price first |
| `flyers.mjs` / `flyers.py` | Every item in every flyer near postal codes, in a region preset, or in flyers you name |
| `weekly.mjs` / `weekly.py` | A Markdown digest of price drops, new deals and deals that ended since last week |

## Does Flipp have a public API?

Not for flyer data across retailers. Flipp's FlyerKit documentation "specifies an API to access Flipp's publication data for use in merchant or publisher applications", and its access token "is used to ensure that only the intended merchant's data is filtered through the API" ([FlyerKit documentation][flyerkit], read 2026-10-06). If you're a retailer or publisher working with Flipp, that is the official route.

To get the deals from every flyer near a postal code, this repo uses the Actor instead. It reads the flyers Flipp shows any visitor, without signing in, and returns each deal as a row you can use from Python, Node.js, `curl` or any HTTP client. The only key involved is your Apify API token.

## What you get

Real output from one run on 2026-10-06 (21:26 UTC): every flyer deal and in-store price for **"chicken breast" near M5V 2T6 (downtown Toronto)** that was valid that day, from

```bash
node --env-file=.env search.mjs --postal "M5V 2T6" "chicken breast" --valid-now --details --max 50
```

It returned 39 deals (fewer than the 50 cap, so that's all of them) from 17 stores: 26 flyer deals and 13 in-store prices from Fortinos, Giant Tiger and No Frills. At the Store price this run cost $0.07 (39 deals, 26 of them with item details). Five of the deals priced by weight, ranked by $/kg:

| rank | name | merchant | price_as_printed | price_per_kg | sale_story | valid_to (UTC) |
|---:|---|---|---|---:|---|---|
| 1 | CHICKEN BREASTS | Real Canadian Superstore | 3.98 LB | 8.77 | SAVE UP TO 48% | 2026-10-08 03:59 |
| 2 | CHICKEN BREASTS | No Frills | 4.88 LB | 10.76 | SAVE 30% | 2026-10-08 03:59 |
| 3 | CHICKEN BREASTS | Wholesale Club and Club Entrepôt | 4.99 /lb$11.00/kg | 11 | $2.30/lb 5.07/kg savings | 2026-10-22 03:59 |
| 6 | FRESH SPLIT CHICKEN BREAST | Metro | 4.99 /lb | 11 | | 2026-10-08 03:59 |
| 9 | Maple Leaf Prime raised without antibiotics boneless skinless chicken breasts 3-pack | Walmart | 6.34 lb | 13.98 | Rollback | 2026-10-08 03:59 |

All 39 rows as [Excel](samples/toronto-chicken-breast.xlsx), [CSV](samples/toronto-chicken-breast.csv) and the Actor's [raw JSON rows](samples/toronto-chicken-breast.json). Flyer deals and prices are as published; the rows hold no personal data.

### Columns

| Column | Meaning |
|---|---|
| `search_term` | The search that found the deal (Search mode, or `--keywords` in full-flyer mode) |
| `rank`, `price_basis` | `search.*` only. `rank` 1 = the lowest price for that search term. Deals priced by weight (`price_basis` = `kg`) are ranked by $/kg, other deals (`item`) by the per-item price: the two aren't comparable, so each has its own rank |
| `name`, `brand`, `merchant` | What's on sale and which retailer. Flyer names are as printed, often in capitals |
| `effective_price` | Price for one item or one unit: a "2 for $5" deal shows 2.50 |
| `price_per_kg`, `price_unit` | $/kg, for deals priced by weight (`lb`, `kg`, `100g`), and what the price is per (`each`, `lb`, `kg`, `100g`, `pack`) |
| `price_as_printed`, `sale_story` | The price and promo text as the flyer shows them ("2 FOR 23", "4.99 /lb", "SAVE 30%", "Rollback") |
| `current_price`, `original_price` | Sale price and regular price, as numbers |
| `discount_pct`, `dollars_off` | Discount against the regular price, or as stated by the retailer |
| `multi_buy_qty`, `multi_buy_total` | For "2 for $5"-style deals: 2 and 5 |
| `currency` | `CAD` or `USD` |
| `valid_from`, `valid_to` | When the deal runs (UTC). In the .xlsx they are date-time cells |
| `item_type` | `flyer` (printed flyer), `store` (a chain's own in-store sale price at one branch) or `online` |
| `store_address` | The branch, for in-store prices |
| `description`, `sku`, `product_url` | Size and varieties ("450-800 g"), SKU and the retailer's product page. Flyer deals get them with `--details` |
| `image_url` | Item image |
| `flyer_id`, `flyer_name`, `flyer_categories` | The flyer it came from and its categories (Groceries, Pharmacy...) |
| `product_category` | Product category, Search mode ("Food, Beverages & Tobacco > Food Items") |
| `in_store_only`, `rating`, `review_count` | Extra detail where the retailer provides it |
| `postal_code` | The postal code or ZIP the deal was found for |
| `change_type`, `previous_price` | With `--track`: `new`, `price_drop`, `price_up` or `unchanged`, and last run's price |
| `item_id`, `merchant_id`, `scraped_at` | Ids and the time of the run |

## Quick start

1. Create a free Apify account and copy your API token ([sign up][signup], then Console > Settings > API & Integrations).
2. `cp .env.example .env` and paste the token after `APIFY_TOKEN=`.

**Python** (3.10 or newer):

```bash
pip install -r requirements.txt
python search.py --postal "M5V 2T6" milk eggs butter --valid-now --out basket.xlsx
python search.py --postal 10001 "paper towels" --stores "Target,Walgreens" --out nyc.csv
python flyers.py "V6B 1A1" --categories Groceries --valid-now --details --max-charge 50 --out vancouver.csv
```

**Node.js** (20.6 or newer):

```bash
npm install
node --env-file=.env search.mjs --postal "M5V 2T6" --file basket.example.txt --valid-now --out basket.xlsx
node --env-file=.env search.mjs --postal "H2X 1Y4" lait oeufs --french --out montreal.csv
node --env-file=.env flyers.mjs --preset ca-major-cities --stores "No Frills" --valid-now --max-charge 25 --out no-frills.csv
```

Both languages take the same options (`--help` prints them) and write byte-identical CSV and JSONL. The CSV is UTF-8 with a BOM so Excel shows accents correctly, and text that starts with `=`, `+`, `-` or `@` gets a leading `'` so a spreadsheet never runs it as a formula.

### Search options (`search.*`)

| Option | What it does | Default |
|---|---|---|
| terms | Products, one search each: `milk "chicken breast" tv` | |
| `--file basket.txt` | One search term per line ([example](basket.example.txt)) | |
| `--postal CODE` | Full Canadian postal code (`M5V 2T6`) or US ZIP (`10001`). Repeat for more | |
| `--stores LIST` | Only these retailers, by name or `merchant_id`: `"No Frills,Walmart"` | all |
| `--categories LIST` | Only these flyer or product categories (`Groceries`, `Meat`, `Beverages`); partial names work | all |
| `--types LIST` | `flyer`, `store` (in-store prices), `online` | `flyer,store` |
| `--valid-now` | Skip deals from flyers that haven't started yet or have ended | |
| `--details` | Add size, SKU, product link and sale text to flyer deals (+$0.0005 per deal) | |
| `--top-200` | One plain search per term, at most 200 results (see below) | |
| `--track` | Fill `change_type` and `previous_price` against the last run of the same search | |
| `--french` | French item names where retailers publish them (Canadian postal codes) | |
| `--max N` | At most N deals for the whole run | no limit |
| `--out FILE` | `.xlsx`, `.csv` or `.jsonl` | `deals.csv` |
| `--keep-order` | Keep the Actor's order instead of lowest price first | |
| `--max-charge USD` | Hard cost cap for the run, enforced by Apify. Deals past the cap aren't collected | `2` |
| `--dataset ID` | Export a run you already made in Apify Console. No new run starts | |
| `--from FILE` | Convert a JSON or JSONL file of the Actor's rows or of these scripts' rows. Needs no token | |

`flyers.*` takes postal codes as arguments plus `--preset`, `--flyer`, `--keywords`, `--no-dedupe` and `--per-postal`; run `node flyers.mjs --help` or `python flyers.py --help`.

## Past Flipp's 200-result search cap

A Flipp search stops at 200 results. When a search hits that cap, the Actor re-runs it store by store and merges the results, so you get the long tail too. Its README gives the example of "chicken" in downtown Toronto: **197 deals become 715** in about 30 seconds. That is on by default. `--top-200` turns it off for a quick sample of the first 200.

A narrower term needs no split: "chicken breast" with `--valid-now` gave the 39 deals above in under 5 seconds.

## Every item in every flyer, and region presets

`flyers.*` reads whole flyers instead of searching them:

```bash
# every grocery flyer item near one Vancouver postal code, with sale text and units
node --env-file=.env flyers.mjs "V6B 1A1" --categories Groceries --details --max-charge 50 --out vancouver.csv

# one chain in 46 Canadian cities (one postal code in each, every province and territory)
node --env-file=.env flyers.mjs --preset ca-major-cities --stores "No Frills" --max-charge 25 --out no-frills.csv

# only the items matching a keyword, across the 50 US metros
node --env-file=.env flyers.mjs --preset us-major-cities --keywords "ground beef" --out beef-us.csv

# flyers you name: a flyer_id from any export, or a flipp.com flyer link (flyers change weekly)
node --env-file=.env flyers.mjs --flyer <flyer_id> --out one-flyer.xlsx
```

- Size: one big-city postal code has about 15,000 to 30,000 flyer items. The Actor's README measured **about 18,000 items from 108 flyers in 12 seconds** for one Vancouver postal code. The presets cover about 1,200 distinct Canadian flyers (`ca-major-cities`) and about 800 US flyers (`us-major-cities`).
- Neighbouring postal codes share most flyers. Each flyer is read once and each deal is returned once, tagged with the first postal code it was found for; `--no-dedupe` gives one row per deal per postal code instead.
- In this mode, flyer rows carry the printed price only unless you add `--details`: the sale text, the unit (`/lb`, `ea.`) and the multi-buy split come with it, and so do `price_per_kg` and the per-item price of a "2 for $5" deal.
- Raise `--max-charge` for big pulls. With the default $2 cap a run stops at about 1,333 deals (1,000 with `--details`); the scripts print this before they start.

## Weekly price-drop digest

Turn on change tracking and run the same input every week. The Actor keeps a small snapshot of the last run of each distinct input in your Apify account, and compares each deal with it: `change_type` is `new`, `price_drop`, `price_up` or `unchanged`, with `previous_price`. The run's `CHANGES` record holds the totals and the deals that ended. `weekly.*` turns that into a Markdown report:

```bash
node --env-file=.env weekly.mjs --input weekly.example.json --out digest.md --csv changes.csv
python weekly.py --input weekly.example.json --min-drop 15 --top 10
```

- `--input` takes the Actor's input as JSON ([example](weekly.example.json): four grocery staples near downtown Toronto) and switches tracking on. The first run marks every deal `new`; the digest then lists the biggest discounts instead.
- The report has price drops (largest first, `--min-drop` to filter), new deals (biggest discount first), price increases and deals that ended. `--csv` writes the new and re-priced deals as rows.
- Deals that ended are reported only when the run wasn't capped: leave `maxItems` and `maxItemsPerPostalCode` out of the weekly input. `weekly.*` warns when they're set.
- In the sample run, 21 of the 26 flyer deals came from flyers that started on Thursday at midnight Eastern time. Schedule the digest for Thursday afternoon.

Here's the format, from [made-up data](samples/weekly-synthetic-rows.json) (**synthetic: invented stores, products and prices**, not real deals). The [full sample digest](samples/weekly-synthetic-digest.md):

```markdown
Changes since 2026-10-01: **4 price drops**, 4 new deals, 2 price increases, 3 deals ended, 4 unchanged.

## Price drops (4 of 4)

| Deal | Store | Now | Before | Change | Ends |
|---|---|---:|---:|---:|---|
| Boneless skinless chicken breasts | Sample Grocer | $3.99/lb | $5.99/lb | -33% | 2026-10-14 |
| Salted butter 454 g | Demo Market | $4.49 | $5.49 | -18% | 2026-10-14 |
```

**Run it every week.** On your own machine with cron (Thursdays at 18:00):

```bash
0 18 * * 4 cd /path/to/flipp-weekly-flyer-api && node --env-file=.env weekly.mjs --input weekly.example.json --out digest-$(date +\%F).md
```

Or on Apify: open the Actor in Console, enter the input with **Track week-over-week changes** on, save it as a task, and add a weekly [schedule][schedules]. Then read the latest run from anywhere:

```bash
node --env-file=.env weekly.mjs --task <taskId> --out digest.md
```

n8n and Make can run the task with their Apify node, too.

## Without the scripts

Python with `apify-client`:

```python
from apify_client import ApifyClient

client = ApifyClient("YOUR_APIFY_TOKEN")
run = client.actor("yugenox/flipp-flyer-deals-scraper").call(run_input={
    "postalCodes": ["M5V 2T6"],
    "searchTerms": ["milk", "eggs"],
    "onlyValidNow": True,
    "maxItems": 100,
})
# apify-client 1.x and 2.x return a dict, 3.x an object
dataset_id = run["defaultDatasetId"] if isinstance(run, dict) else run.default_dataset_id
for deal in client.dataset(dataset_id).iterate_items():
    print(deal["merchant"], deal["name"], deal["effectivePrice"], deal["validTo"])
```

`curl`, straight to CSV (the Actor's own field names):

```bash
curl -s -X POST "https://api.apify.com/v2/acts/yugenox~flipp-flyer-deals-scraper/run-sync-get-dataset-items?format=csv" \
  -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"postalCodes":["M5V 2T6"],"searchTerms":["milk"],"onlyValidNow":true,"maxItems":50}' -o milk.csv
```

The Actor's [API page][actor-api] has the same call for JavaScript and other clients, and its input form shows every field.

## Use cases

- **Grocery price comparison and "lowest price near me" apps:** grocery flyer data for a basket of products across every store near a postal code, sorted by $/kg or per-item price.
- **Deal alerts and newsletters:** the weekly digest, or `--track` rows into your own pipeline.
- **CPG and retail analytics:** which brands are promoted, at what discount, by which chains and in which cities, week after week (`flyers.*` with a region preset and `--track`).
- **Competitive pricing:** a competitor's flyer prices by city, with `--stores`.

## Price

Pay per deal, billed to your own Apify account. From the Actor's pricing in the Apify API on 2026-10-06 (the Store page always shows the current price):

| | Flipp Flyer Deals Scraper |
|---|---:|
| Per deal saved | $0.0015 ($1.50 per 1,000) |
| Item details add-on (`--details`), per deal enriched | $0.0005 ($0.50 per 1,000) |
| Start fee per run, until 2026-10-11 (19:57 UTC) | none |
| Start fee per run, from 2026-10-11 (19:57 UTC) | $0.001 |

The prices are the same on every Apify plan. Deals removed by your filters or as duplicates aren't charged. The start fee is charged once per run per GB of memory, and runs use 1 GB by default. The Actor's compute isn't billed on top.

| Example | Deals | Cost |
|---|---:|---:|
| The sample above: "chicken breast", one postal code, `--details` | 39 (26 with details) | $0.07 |
| "chicken" in downtown Toronto, past the 200 cap (Actor README) | 715 | $1.07 |
| Every flyer item near one Vancouver postal code (Actor README) | about 18,000 | about $27.00 ($36.00 with `--details`) |
| A weekly run that saves 500 deals, for a year | 26,000 | $39.00 + $0.05 in start fees |

Amounts are rounded to the cent. Apify's Free plan includes monthly usage credit you can spend on this Actor. `--max-charge` (default $2) is a hard cap Apify enforces for each run.

Other Flipp Actors on the Apify Store, from the Apify API on 2026-10-06 (per 1,000 results):

| Actor | Per 1,000 results | Start fee per run | Platform usage |
|---|---|---:|---|
| [yugenox/flipp-flyer-deals-scraper][actor] (this repo) | $1.50 on every plan (+$0.50 with item details) | $0.001 from 2026-10-11 | included |
| [crawlerbros/flipp-grocery-deals-scraper][rival-cb1] | $5.00 Free, $4.33 Bronze, $3.67 Silver, $3.00 Gold and up | $0.005 | billed to you on top |
| [crawlerbros/flipp-weekly-deals-scraper][rival-cb2] | $5.00 Free, $4.33 Bronze, $3.67 Silver, $3.00 Gold and up | $0.005 | billed to you on top |
| [chimerical_quicklime/flipp-scraper][rival-cq] | $4.65 Free, $4.03 Bronze, $3.41 Silver, $2.79 Gold and up | $0.00465 | included |

Their fields and coverage differ from this Actor's; compare their output tabs before you pick. For a one-off look at one store's flyer, the Flipp app and website are free.

## Limits

- **Full postal codes only.** `M5V 2T6` or a 5-digit US ZIP; the first three characters of a postal code (`M5V`) aren't enough. One downtown postal code covers the flyers for most of a metro area.
- **Some deals have no single price** ("20% off all toys", "Buy 1 get 1"). Their price columns and `rank` are empty, and `discount_pct` or `sale_story` carries the deal.
- **Per-item prices compare packages, not weights.** A 150 g pack at $2.70 ranks ahead of a 907 g pack at $10. Check `description` (size), or compare `price_per_kg`, which is filled only for deals priced by weight.
- **In-store prices** come only from chains that publish them, for one branch each (`store_address`), with a short validity window (about 30 hours in the sample).
- **No history before your first run.** Week-over-week changes start with the first tracked run of an input; past weeks are only what you saved yourself.
- Full-flyer rows without `--details` carry the printed price only (see above).
- Some image links are signed and stop working after about a week (the in-store images in the sample). Download images you need to keep.
- US ZIP codes work, and US flyer rows are in USD. The retailers named in the Actor's README are Walmart, Costco, No Frills, Loblaws, Metro, Sobeys, Shoppers Drug Mart, Canadian Tire, Home Depot, Best Buy, Target, CVS, Walgreens, ALDI and Lowe's, plus hundreds of independents. For any other chain, run a 5-deal test first (`--max 5`).

## FAQ

**Is there a Flipp API key I need?**
No. Flipp's FlyerKit access tokens are for merchant and publisher apps (see above). Here you need only an Apify API token.

**Which stores and countries does it cover?**
2,500+ Canadian and US retailers, by postal code or ZIP: grocery, pharmacy, hardware, electronics, pets, home and more.

**How fresh is the data?**
Read live when the run starts. Most retailers publish new flyers weekly, often a day or two before they start; `--valid-now` keeps only deals valid today.

**How do I cover a whole city, province or country?**
One downtown postal code covers most of a metro area. For national coverage use `--preset ca-major-cities` or `--preset us-major-cities`; flyers shared between cities are read once.

**Is scraping Flipp legal?**
Here are the facts; this is not legal advice. The Actor collects only what Flipp shows any visitor without an account: flyer deals, prices, product details and store locations. It never signs in. The rows hold no personal data. You're responsible for how you use the data, for following Flipp's terms, and for the rights in retailers' product images and text if you republish them. For a commercial product, ask a lawyer. More: [Is web scraping legal?][legal]

**Can I call it from Claude, ChatGPT or Cursor?**
Yes, through Apify's hosted MCP server. Add `https://mcp.apify.com/?tools=fetch-actor-details,yugenox/flipp-flyer-deals-scraper` to your assistant as a custom connector and sign in with your Apify account; runs bill to that account. In Claude Code: `claude mcp add --transport http yugenox-flipp "https://mcp.apify.com/?tools=fetch-actor-details,yugenox/flipp-flyer-deals-scraper"`. Steps for each client: [use it in ChatGPT, Claude and Cursor][ai].

**Can I run it from n8n, Make or Zapier?**
Yes. n8n, Make and Zapier have Apify integrations that run an Actor or a saved task and return its dataset. The input is the same JSON as in `weekly.example.json`.

## Privacy

Flyer deals are product, price and store data. The rows and the sample hold no personal data.

## More

- The guide this repo goes with: [weekly flyer API][guide]. Other guides and public-data examples: [yugenox-data.vercel.app](https://yugenox-data.vercel.app)
- The Actor, with its input form, output table and API page: [Flipp Flyer Deals Scraper][actor] ([API][actor-api])
- More Canadian retail and grocery data (Loblaws, Costco, Canadian Tire, jobs, real estate): [yugenox on Apify][store]
- Use it from AI assistants: [setup guide][ai]

## Samples, testing and legal

- The search sample comes from one run on 2026-10-06 (Actor build 0.1.7, 39 deals) through `search.mjs`. The raw rows are committed as returned; the .csv and .xlsx were written from them with `--from`. Input keys were checked against the Actor's live input schema the same day.
- `samples/weekly-synthetic-*` is made up (stores, products, prices) to show the digest format. It isn't real data.
- Tested: Node 22, Python 3.9 and Python 3.14 write byte-identical CSV, JSONL and digests, and the .xlsx cells match between Node and Python (openpyxl 3.1.5). Only `search.mjs` ran against the live Actor (the sample run); the new-run, `--task` and `--run` paths of every script were tested against a stub client, and the client calls they use exist in apify-client 2.25 (Node) and 2.5.1 and 3.2.1 (Python).
- Flipp and the retailers' names are trademarks of their owners. This repo and the Actor are not affiliated with or endorsed by Flipp or any retailer.
- The MIT licence covers the code. The deal data in `samples/` is a short excerpt of public flyer listings, included to show the output format; it isn't ours to license.
- Made by Yugenox Corporation.

<!-- All apify.com links for this README live below. When the Apify affiliate id exists, append ?fpr=<id> to these URLs only. -->
[actor]: https://apify.com/yugenox/flipp-flyer-deals-scraper
[actor-api]: https://apify.com/yugenox/flipp-flyer-deals-scraper/api
[badge]: https://apify.com/actor-badge?actor=yugenox/flipp-flyer-deals-scraper
[store]: https://apify.com/yugenox
[signup]: https://console.apify.com/sign-up
[schedules]: https://docs.apify.com/platform/schedules
[rival-cb1]: https://apify.com/crawlerbros/flipp-grocery-deals-scraper
[rival-cb2]: https://apify.com/crawlerbros/flipp-weekly-deals-scraper
[rival-cq]: https://apify.com/chimerical_quicklime/flipp-scraper
[legal]: https://blog.apify.com/is-web-scraping-legal/
[flyerkit]: https://api.flipp.com/flyerkit/v3.0/documentation
[guide]: https://yugenox-data.vercel.app/retail/weekly-flyer-api
[ai]: https://yugenox-data.vercel.app/ai/use-in-chatgpt-claude-cursor
