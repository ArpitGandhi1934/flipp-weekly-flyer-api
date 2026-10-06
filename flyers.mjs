#!/usr/bin/env node
// Export every item in every weekly flyer near one or more postal codes / ZIPs (or in flyers you
// name) to CSV, Excel (.xlsx) or JSONL.
//
// Calls the yugenox/flipp-flyer-deals-scraper Actor on Apify in Full-flyer mode (postal codes or
// region presets) or Specific-flyer mode (flyer ids or flipp.com flyer links). Narrow it with
// --stores, --categories and --keywords; each flyer shared by several postal codes is read once.
//
// Run with --help for every option. Requires Node 20.6+; APIFY_TOKEN in the environment (or in
// .env, loaded with `node --env-file=.env`) for new runs and --dataset.

import { checkOut, dealsForCap, exportDeals, isPostal, splitList } from './flyerlib.mjs';

const PRESETS = ['ca-major-cities', 'us-major-cities'];

const HELP = `Export every item in the weekly flyers near a postal code or ZIP (or in flyers you name).

Usage:
  node --env-file=.env flyers.mjs "V6B 1A1" --categories Groceries --valid-now --details --out vancouver.csv
  node --env-file=.env flyers.mjs --preset ca-major-cities --stores "No Frills" --max-charge 20 --out no-frills.csv
  node --env-file=.env flyers.mjs --flyer <flyer_id> --out one-flyer.xlsx
  node flyers.mjs --from rows.json --out flyers.xlsx

Which flyers
  <postal>...           Full Canadian postal codes (V6B 1A1) or US ZIPs (10001).
  --preset <name>       ca-major-cities (one postal code in each of 46 Canadian cities, every
                        province and territory) or us-major-cities (50 US metros). Repeatable.
  --flyer <id|link>     Only these flyers: a flyer_id from any export, or a flipp.com flyer link.
                        Repeatable. Can't be mixed with postal codes or presets.

Which items
  --stores <list>       Only these stores: names or Flipp store ids, comma-separated.
  --categories <list>   Only these flyer categories, comma-separated (Groceries, Pharmacy,
                        Home & Garden, Electronics, Pets...). Partial names work.
  --keywords <list>     Only items matching one of these, comma-separated: every word of a
                        keyword must start a word in the item's name, brand or description.
  --valid-now           Skip flyers that haven't started yet or have ended.
  --details             Add sale text, unit (/lb, ea.), size, SKU and product link (+$0.0005 per
                        deal). In this mode the sale text and units come with it, so the per-item
                        price of a multi-buy and price_per_kg need --details.
  --track               Week-over-week: fill change_type and previous_price against the last run
                        of the same input in your Apify account.
  --french              French names where retailers publish them (Canadian postal codes).
  --no-dedupe           One row per deal per postal code (default: each deal once, tagged with
                        the first postal code it was found for).
  --max <n>             At most n deals for the whole run.
  --per-postal <n>      At most n deals per postal code.

Output
  --out <path>          .csv (default flyers.csv), .xlsx or .jsonl
  --max-charge <usd>    Hard cost cap for the run, enforced by Apify (default 2). One big-city
                        postal code has about 15,000 to 30,000 flyer items.

Re-export without a new run
  --dataset <id>        Export the dataset of a run you already made. No new run starts.
  --from <file>         Convert a JSON or JSONL file of the Actor's rows or of these scripts'
                        rows. Needs no token.

  -h, --help            Show this help.

Price: $0.0015 per deal, +$0.0005 per deal with --details, and from 2026-10-11 19:57 UTC a
$0.001 start fee per run (Apify API, read 2026-10-06; the Store page shows the current price).
Not affiliated with Flipp or any retailer.`;

function parseArgs(argv) {
    const o = { postals: [], presets: [], flyers: [], stores: [], categories: [], keywords: [], out: 'flyers.csv', maxCharge: 2 };
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
        else if (a === '--preset') o.presets.push(val(a, argv[++i]));
        else if (a === '--flyer') o.flyers.push(val(a, argv[++i]).trim());
        else if (a === '--stores') o.stores.push(...splitList(val(a, argv[++i])));
        else if (a === '--categories') o.categories.push(...splitList(val(a, argv[++i])));
        else if (a === '--keywords') o.keywords.push(...splitList(val(a, argv[++i])));
        else if (a === '--valid-now') o.validNow = true;
        else if (a === '--details') o.details = true;
        else if (a === '--track') o.track = true;
        else if (a === '--french') o.french = true;
        else if (a === '--no-dedupe') o.noDedupe = true;
        else if (a === '--max') o.max = num(a, argv[++i]);
        else if (a === '--per-postal') o.perPostal = num(a, argv[++i]);
        else if (a === '--out') o.out = val(a, argv[++i]);
        else if (a === '--max-charge') o.maxCharge = num(a, argv[++i]);
        else if (a === '--dataset') o.dataset = val(a, argv[++i]);
        else if (a === '--from') o.from = val(a, argv[++i]);
        else if (a.startsWith('-')) throw new Error(`Unknown option ${a} (see --help)`);
        else o.postals.push(a.trim());
    }
    if (o.help) return o;
    checkOut(o.out);
    for (const [flag, n] of [['--max', o.max], ['--per-postal', o.perPostal]]) {
        if (n !== undefined && !Number.isInteger(n)) throw new Error(`${flag} needs a whole number`);
    }
    const badPreset = o.presets.filter((p) => !PRESETS.includes(p));
    if (badPreset.length) throw new Error(`--preset: ${badPreset.join(', ')} isn't one of ${PRESETS.join(', ')}`);
    if (o.dataset || o.from) {
        if (o.dataset && o.from) throw new Error('Use --dataset or --from, not both');
        if (o.postals.length || o.presets.length || o.flyers.length) {
            throw new Error('--dataset and --from export rows that already exist; leave out postal codes, --preset and --flyer');
        }
        return o;
    }
    if (o.flyers.length && (o.postals.length || o.presets.length)) {
        throw new Error('--flyer reads only the flyers you name; leave out postal codes and --preset');
    }
    if (!o.flyers.length && !o.postals.length && !o.presets.length) {
        throw new Error('Give postal codes, --preset, --flyer, --dataset <id> or --from <file> (see --help)');
    }
    const badPostal = o.postals.filter((p) => !isPostal(p));
    if (badPostal.length) {
        throw new Error(`Not a full postal code or ZIP: ${badPostal.join('; ')}. Use e.g. V6B 1A1 or 10001; `
            + 'the first three characters of a postal code are not enough.');
    }
    const badFlyer = o.flyers.filter((f) => !/^\d{5,10}$/.test(f) && !/flipp\.com\/.*\d{5,10}/i.test(f));
    if (badFlyer.length) throw new Error(`Not a flyer id or flipp.com flyer link: ${badFlyer.join('; ')}`);
    return o;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(HELP); return; }

    const input = {
        mode: o.flyers.length ? 'flyerIds' : 'flyers',
        onlyValidNow: Boolean(o.validNow),
        includeItemDetails: Boolean(o.details),
        trackChanges: Boolean(o.track),
        dedupeAcrossPostalCodes: !o.noDedupe,
        language: o.french ? 'fr' : 'en',
    };
    if (o.flyers.length) input.flyerIds = o.flyers;
    if (o.postals.length) input.postalCodes = o.postals;
    if (o.presets.length) input.regionPresets = o.presets;
    if (o.stores.length) input.merchants = o.stores;
    if (o.categories.length) input.categories = o.categories;
    if (o.keywords.length) input.searchTerms = o.keywords;
    if (o.max) input.maxItems = o.max;
    if (o.perPostal) input.maxItemsPerPostalCode = o.perPostal;
    if (!o.from && !o.dataset) {
        const cap = dealsForCap(o.maxCharge, o.details);
        const where = o.flyers.length ? `${o.flyers.length} flyer(s)`
            : [o.postals.length && `${o.postals.length} postal code(s)`, ...o.presets].filter(Boolean).join(' + ');
        console.error(`Running yugenox/flipp-flyer-deals-scraper: every item in the flyers for ${where}`
            + `${o.max ? `, at most ${o.max} deals` : ''}, cost cap $${o.maxCharge} (about ${cap} deals) ...`);
        if (!o.max || o.max > cap) {
            console.error(`Deals past the $${o.maxCharge} cap are not collected. Full flyers for one big-city postal code are `
                + 'about 15,000 to 30,000 items: narrow with --stores, --categories or --keywords, or raise --max-charge.');
        }
        if (!o.details) console.error('Without --details, rows carry the printed price only (no sale text, unit or multi-buy split).');
    }
    await exportDeals(o, input, { sort: false });
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
