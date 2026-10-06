#!/usr/bin/env node
// Search every weekly flyer near a postal code or ZIP for products, and export the deals to CSV,
// Excel (.xlsx) or JSONL, lowest price first.
//
// Calls the yugenox/flipp-flyer-deals-scraper Actor on Apify in Search mode: one search per term
// and postal code, past Flipp's 200-results-per-search cap (the Actor re-runs a capped search
// store by store). Rows: product, store, per-item price, $/kg, the price as printed, regular
// price, discount, multi-buy, valid dates, and (with --details) size, SKU and product link.
//
// Run with --help for every option. Requires Node 20.6+; APIFY_TOKEN in the environment (or in
// .env, loaded with `node --env-file=.env`) for new runs and --dataset.

import { checkOut, dealsForCap, exportDeals, isPostal, readList, splitList } from './flyerlib.mjs';

const HELP = `Search weekly flyers near a postal code or ZIP; export the deals, lowest price first.

Usage:
  node --env-file=.env search.mjs --postal "M5V 2T6" milk "chicken breast" [options]
  node --env-file=.env search.mjs --postal "M5V 2T6" --postal 10001 --file basket.example.txt --out basket.xlsx
  node --env-file=.env search.mjs --dataset <datasetId> --out deals.csv
  node search.mjs --from samples/toronto-chicken-breast.json --out deals.xlsx

What to search
  <term>...             Products, e.g. milk "chicken breast" tv. One search per term.
  --file <path>         One search term per line. Blank lines and lines starting with # are skipped.
  --postal <code>       Full Canadian postal code (M5V 2T6) or US ZIP (10001). Repeat for more.
                        The first three characters alone (M5V) are not enough.
  --stores <list>       Only these stores: names or Flipp store ids (merchant_id), comma-separated,
                        e.g. "No Frills,Walmart".
  --categories <list>   Only these categories, comma-separated: flyer categories (Groceries,
                        Pharmacy...) or product categories (Meat, Beverages...). Partial names work.
  --types <list>        flyer, store (a chain's own in-store sale price at the nearest branch),
                        online. Default: flyer,store.
  --valid-now           Skip deals from flyers that haven't started yet or have ended.
  --details             Add size/description, SKU, product link and sale text to flyer deals
                        (+$0.0005 per deal).
  --top-200             One plain search per term (at most 200 results); no store-by-store split.
  --track               Week-over-week: fill change_type and previous_price against the last run
                        of the same search in your Apify account.
  --french              French names where retailers publish them (Canadian postal codes).
  --max <n>             At most n deals for the whole run.

Output
  --out <path>          .csv (default deals.csv), .xlsx or .jsonl
  --keep-order          Keep the Actor's order. Default: lowest price first per search term
                        (by $/kg for deals priced by weight, then by the per-item price).
  --max-charge <usd>    Hard cost cap for the run, enforced by Apify (default 2).

Re-export without a new run
  --dataset <id>        Export the dataset of a run you already made (Apify Console >
                        Storage > Datasets). No new run starts.
  --from <file>         Convert a JSON or JSONL file of the Actor's rows (Console export)
                        or of these scripts' rows. Needs no token.

  -h, --help            Show this help.

Price: $0.0015 per deal, +$0.0005 per deal with --details, and from 2026-10-11 19:57 UTC a
$0.001 start fee per run (Apify API, read 2026-10-06; the Store page shows the current price).
Not affiliated with Flipp or any retailer.`;

const TYPES = ['flyer', 'store', 'online'];

function parseArgs(argv) {
    const o = { terms: [], postals: [], stores: [], categories: [], out: 'deals.csv', maxCharge: 2 };
    const val = (flag, v) => {
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
        return v;
    };
    const num = (flag, v) => {
        const n = Number(val(flag, v));
        if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a number above 0`);
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') o.help = true;
        else if (a === '--file') o.terms.push(...readList(val(a, argv[++i])));
        else if (a === '--postal') o.postals.push(val(a, argv[++i]).trim());
        else if (a === '--stores') o.stores.push(...splitList(val(a, argv[++i])));
        else if (a === '--categories') o.categories.push(...splitList(val(a, argv[++i])));
        else if (a === '--types') o.types = splitList(val(a, argv[++i]));
        else if (a === '--valid-now') o.validNow = true;
        else if (a === '--details') o.details = true;
        else if (a === '--top-200') o.top200 = true;
        else if (a === '--track') o.track = true;
        else if (a === '--french') o.french = true;
        else if (a === '--max') o.max = num(a, argv[++i]);
        else if (a === '--out') o.out = val(a, argv[++i]);
        else if (a === '--keep-order') o.keepOrder = true;
        else if (a === '--max-charge') o.maxCharge = num(a, argv[++i]);
        else if (a === '--dataset') o.dataset = val(a, argv[++i]);
        else if (a === '--from') o.from = val(a, argv[++i]);
        else if (a.startsWith('-')) throw new Error(`Unknown option ${a} (see --help)`);
        else o.terms.push(a);
    }
    if (o.help) return o;
    checkOut(o.out);
    if (o.max !== undefined && !Number.isInteger(o.max)) throw new Error('--max needs a whole number');
    const bad = (o.types ?? []).filter((t) => !TYPES.includes(t));
    if (bad.length) throw new Error(`--types: ${bad.join(', ')} isn't one of ${TYPES.join(', ')}`);
    if (o.dataset || o.from) {
        if (o.dataset && o.from) throw new Error('Use --dataset or --from, not both');
        if (o.terms.length || o.postals.length) throw new Error('--dataset and --from export rows that already exist; leave out search terms and --postal');
        return o;
    }
    if (!o.terms.length) throw new Error('Give one or more search terms (or --file), --dataset <id> or --from <file> (see --help)');
    if (!o.postals.length) throw new Error('Give --postal with a full Canadian postal code (M5V 2T6) or a US ZIP (10001)');
    const badPostal = o.postals.filter((p) => !isPostal(p));
    if (badPostal.length) {
        throw new Error(`Not a full postal code or ZIP: ${badPostal.join('; ')}. Use e.g. M5V 2T6 or 10001; `
            + 'the first three characters of a postal code are not enough.');
    }
    // Flipp searches words with Latin letters or digits; an emoji-only term would match nothing useful.
    const noWords = o.terms.filter((t) => !/[a-z0-9]/i.test(t.normalize('NFD')));
    if (noWords.length) throw new Error(`Search terms need letters or digits: ${noWords.join('; ')}`);
    return o;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(HELP); return; }

    const input = {
        mode: 'search',
        postalCodes: o.postals,
        searchTerms: o.terms,
        itemTypes: o.types ?? ['flyer', 'store'],
        onlyValidNow: Boolean(o.validNow),
        includeItemDetails: Boolean(o.details),
        completeCoverage: !o.top200,
        trackChanges: Boolean(o.track),
        language: o.french ? 'fr' : 'en',
    };
    if (o.stores.length) input.merchants = o.stores;
    if (o.categories.length) input.categories = o.categories;
    if (o.max) input.maxItems = o.max;
    if (!o.from && !o.dataset) {
        const cap = dealsForCap(o.maxCharge, o.details);
        console.error(`Running yugenox/flipp-flyer-deals-scraper: ${o.terms.length} term(s) x ${o.postals.length} postal code(s)`
            + `${o.max ? `, at most ${o.max} deals` : ''}, cost cap $${o.maxCharge} (about ${cap} deals) ...`);
        if (o.max && o.max > cap) {
            console.error(`--max ${o.max} is more than the $${o.maxCharge} cap pays for; deals past the cap are not collected. Raise --max-charge to get them all.`);
        }
    }
    await exportDeals(o, input, { sort: !o.keepOrder });
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
