#!/usr/bin/env node
// Weekly flyer price-drop digest in Markdown: price drops, new deals, price increases and deals that
// ended since the last run of the same input.
//
// Runs yugenox/flipp-flyer-deals-scraper with trackChanges on (or reads a run that already
// finished, e.g. from an Apify schedule), then turns each row's change_type / previous_price and
// the run's CHANGES record into a short report you can email, post or commit.
//
// Run with --help for every option. Requires Node 20.6+; APIFY_TOKEN in the environment (or in
// .env, loaded with `node --env-file=.env`) for --input, --run and --task.

import { readFileSync, writeFileSync } from 'node:fs';
import { apifyClient, checkOut, datasetItems, dealsForCap, isDeal, readFromFile, runActor, toRow, writeRows } from './flyerlib.mjs';

const HELP = `Weekly flyer price-drop digest (Markdown) from a change-tracking run.

Usage:
  node --env-file=.env weekly.mjs --input weekly.example.json --out digest.md
  node --env-file=.env weekly.mjs --task <taskId> --out digest.md --csv changes.csv
  node --env-file=.env weekly.mjs --run <runId> --min-drop 20
  node weekly.mjs --from rows.json --changes CHANGES.json --out digest.md

Where the deals come from (pick one)
  --input <file>        Actor input (JSON) for a new run. trackChanges is switched on for you.
                        Run the same file every week: changes are against the last run of
                        exactly that input in your Apify account.
  --task <id>           The last succeeded run of a saved Apify task (e.g. one with a weekly
                        schedule). No new run starts.
  --run <id>            A run that already finished. No new run starts.
  --from <file>         Offline: the run's rows as JSON or JSONL. Needs no token.
  --changes <file>      With --from: the run's CHANGES record (JSON), for the totals and the
                        deals that ended.

Output
  --out <path>          Write the digest here (default: print it).
  --csv <path>          Also write the new, cheaper and pricier deals (.csv, .xlsx or .jsonl).
  --top <n>             Rows per table (default 25).
  --min-drop <pct>      Only list price drops of at least this many percent (default 0).
  --title <text>        Heading (default "Flyer deals: week of <date>").
  --max-charge <usd>    Hard cost cap for an --input run, enforced by Apify (default 2).

  -h, --help            Show this help.

Price of a run: $0.0015 per deal, +$0.0005 per deal with item details, and from 2026-10-11
19:57 UTC a $0.001 start fee per run (Apify API, read 2026-10-06). Not affiliated with Flipp.`;

function parseArgs(argv) {
    const o = { top: 25, minDrop: 0, maxCharge: 2 };
    const val = (flag, v) => {
        if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
        return v;
    };
    const num = (flag, v, min = 0) => {
        const n = Number(val(flag, v));
        if (!Number.isFinite(n) || n < min) throw new Error(`${flag} needs a number of ${min} or more`);
        return n;
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') o.help = true;
        else if (a === '--input') o.input = val(a, argv[++i]);
        else if (a === '--task') o.task = val(a, argv[++i]);
        else if (a === '--run') o.run = val(a, argv[++i]);
        else if (a === '--from') o.from = val(a, argv[++i]);
        else if (a === '--changes') o.changes = val(a, argv[++i]);
        else if (a === '--out') o.out = val(a, argv[++i]);
        else if (a === '--csv') o.csv = val(a, argv[++i]);
        else if (a === '--top') o.top = num(a, argv[++i], 1);
        else if (a === '--min-drop') o.minDrop = num(a, argv[++i]);
        else if (a === '--title') o.title = val(a, argv[++i]);
        else if (a === '--max-charge') o.maxCharge = num(a, argv[++i], 0.01);
        else throw new Error(`Unknown option ${a} (see --help)`);
    }
    if (o.help) return o;
    const sources = [o.input, o.task, o.run, o.from].filter(Boolean).length;
    if (sources !== 1) throw new Error('Give exactly one of --input, --task, --run or --from (see --help)');
    if (o.changes && !o.from) throw new Error('--changes goes with --from (the other sources read the record from the run)');
    if (!Number.isInteger(o.top)) throw new Error('--top needs a whole number');
    if (o.csv) checkOut(o.csv);
    return o;
}

async function load(o) {
    if (o.from) {
        return { items: readFromFile(o.from), changes: o.changes ? JSON.parse(readFileSync(o.changes, 'utf8')) : null };
    }
    const client = await apifyClient();
    let run;
    if (o.input) {
        const input = { ...JSON.parse(readFileSync(o.input, 'utf8')), trackChanges: true };
        if (input.maxItems || input.maxItemsPerPostalCode) {
            console.error('Note: with maxItems or maxItemsPerPostalCode set, the Actor compares only the deals it saved '
                + 'and does not report deals that ended.');
        }
        console.error(`Running yugenox/flipp-flyer-deals-scraper with trackChanges, cost cap $${o.maxCharge} `
            + `(about ${dealsForCap(o.maxCharge, input.includeItemDetails)} deals) ...`);
        run = await runActor(client, input, o.maxCharge);
    } else if (o.task) {
        run = await client.task(o.task).lastRun({ status: 'SUCCEEDED' }).get();
        if (!run) throw new Error(`Task ${o.task} has no succeeded run yet`);
    } else {
        run = await client.run(o.run).get();
        if (!run) throw new Error(`Run ${o.run} not found`);
    }
    if (!o.input) console.error(`Reading run ${run.id} (${run.status}, finished ${run.finishedAt ? new Date(run.finishedAt).toISOString() : 'not yet'})`);
    const items = await datasetItems(client, run.defaultDatasetId);
    const record = await client.keyValueStore(run.defaultKeyValueStoreId).getRecord('CHANGES');
    return { items, changes: record?.value ?? null, finishedAt: run.finishedAt };
}

// ---- the digest -----------------------------------------------------------------------------------

const priceOf = (r) => (r.effective_price ?? r.current_price ?? null);
const cell = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const shorten = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const dealName = (r) => cell(shorten([r.brand && !String(r.name ?? '').toLowerCase().includes(String(r.brand).toLowerCase()) ? r.brand : null, r.name]
    .filter(Boolean).join(' ')));
// The date a deal ends, in this computer's time zone (flyers usually end at 23:59 local time).
const endDate = (v) => {
    const t = Date.parse(v ?? '');
    if (Number.isNaN(t)) return '';
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function money(v, unit, currency, showCurrency) {
    if (v == null || v === '') return '';
    const per = unit && unit !== 'each' ? `/${unit}` : '';
    return `$${Number(v).toFixed(2)}${per}${showCurrency && currency ? ` ${currency}` : ''}`;
}
// The per-item price, plus the multi-buy as printed: "$5.00 (2 for $10.00)".
const nowPrice = (r, m) => `${m(r, priceOf(r))}${r.multi_buy_qty && r.multi_buy_total != null
    ? ` (${r.multi_buy_qty} for $${Number(r.multi_buy_total).toFixed(2)})` : ''}`;

function table(header, rows) {
    return [`| ${header.join(' | ')} |`, `|${header.map((h) => (/^(Now|Before|Change|Price|Last price|Off)$/.test(h) ? '---:' : '---')).join('|')}|`,
        ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

export function digest(rows, changes, o, finishedAt) {
    const currencies = new Set(rows.map((r) => r.currency).filter(Boolean));
    const showCur = currencies.size > 1;
    const m = (r, v) => money(v, r.price_unit, r.currency, showCur);
    const count = (t) => rows.filter((r) => r.change_type === t).length;
    const totals = {
        new: changes?.new ?? count('new'),
        price_drop: changes?.price_drop ?? count('price_drop'),
        price_up: changes?.price_up ?? count('price_up'),
        unchanged: changes?.unchanged ?? count('unchanged'),
        expired: changes?.expired ?? null,
    };
    const firstRun = changes ? Boolean(changes.firstRun) : rows.length > 0 && totals.new === rows.length;
    const when = finishedAt ? new Date(finishedAt) : rows.map((r) => r.scraped_at).filter(Boolean).sort().at(-1);
    const title = o.title ?? `Flyer deals: week of ${endDate(when ? new Date(when).toISOString() : new Date().toISOString())}`;
    const out = [`# ${title}`, ''];
    const terms = [...new Set(rows.map((r) => r.search_term).filter(Boolean))];
    const stores = [...new Set(rows.map((r) => r.merchant).filter(Boolean))];
    const postals = [...new Set(rows.map((r) => r.postal_code).filter(Boolean))];
    out.push(`${rows.length} deals from ${stores.length} store${stores.length === 1 ? '' : 's'}`
        + `${postals.length ? ` near ${postals.slice(0, 5).join(', ')}${postals.length > 5 ? ` and ${postals.length - 5} more` : ''}` : ''}`
        + `${terms.length ? ` for ${terms.slice(0, 8).map((t) => `"${t}"`).join(', ')}${terms.length > 8 ? '…' : ''}` : ''}.`
        + `${currencies.size === 1 ? ` Prices in ${[...currencies][0]}, per item unless a unit is shown.` : ''}`);
    out.push('');
    if (firstRun) {
        out.push('First run of this input: every deal is marked new. Run the same input again next week to see price drops, '
            + 'new deals and deals that ended.', '');
        const best = rows.filter((r) => r.discount_pct != null).sort((a, b) => b.discount_pct - a.discount_pct || (b.dollars_off ?? 0) - (a.dollars_off ?? 0));
        if (best.length) {
            out.push(`## Biggest discounts this week (${Math.min(o.top, best.length)} of ${best.length})`, '');
            out.push(table(['Deal', 'Store', 'Price', 'Off', 'Ends'],
                best.slice(0, o.top).map((r) => [dealName(r), cell(r.merchant), nowPrice(r, m), `${r.discount_pct}%`, endDate(r.valid_to)])), '');
        }
        return out.join('\n');
    }
    const since = changes?.previousRunAt ? ` since ${String(changes.previousRunAt).slice(0, 10)}` : '';
    out.push(`Changes${since}: **${totals.price_drop} price drops**, ${totals.new} new deals, ${totals.price_up} price increases`
        + `${totals.expired != null ? `, ${totals.expired} deals ended` : ''}, ${totals.unchanged} unchanged.`);
    if (changes && changes.complete === false) out.push('', '_This run was capped or partial, so deals that ended are not reported._');
    out.push('');

    const drops = rows.filter((r) => r.change_type === 'price_drop' && Number(r.previous_price) > 0 && priceOf(r) != null)
        .map((r) => ({ r, pct: ((Number(r.previous_price) - Number(priceOf(r))) / Number(r.previous_price)) * 100 }))
        .filter((x) => x.pct >= o.minDrop)
        .sort((a, b) => b.pct - a.pct);
    out.push(`## Price drops (${Math.min(o.top, drops.length)} of ${drops.length}${o.minDrop ? `, ${o.minDrop}% or more` : ''})`, '');
    out.push(drops.length
        ? table(['Deal', 'Store', 'Now', 'Before', 'Change', 'Ends'], drops.slice(0, o.top).map(({ r, pct }) => [dealName(r), cell(r.merchant),
            nowPrice(r, m), m(r, r.previous_price), `-${pct.toFixed(0)}%`, endDate(r.valid_to)]))
        : 'None.', '');

    const fresh = rows.filter((r) => r.change_type === 'new')
        .sort((a, b) => (b.discount_pct ?? -1) - (a.discount_pct ?? -1) || (b.dollars_off ?? -1) - (a.dollars_off ?? -1));
    out.push(`## New deals (${Math.min(o.top, fresh.length)} of ${fresh.length}, biggest discount first)`, '');
    out.push(fresh.length
        ? table(['Deal', 'Store', 'Price', 'Off', 'Ends'], fresh.slice(0, o.top).map((r) => [dealName(r), cell(r.merchant), nowPrice(r, m),
            r.discount_pct != null ? `${r.discount_pct}%` : '', endDate(r.valid_to)]))
        : 'None.', '');

    const ups = rows.filter((r) => r.change_type === 'price_up' && Number(r.previous_price) > 0 && priceOf(r) != null)
        .map((r) => ({ r, pct: ((Number(priceOf(r)) - Number(r.previous_price)) / Number(r.previous_price)) * 100 }))
        .sort((a, b) => b.pct - a.pct);
    if (ups.length) {
        out.push(`## Price increases (${Math.min(o.top, ups.length)} of ${ups.length})`, '');
        out.push(table(['Deal', 'Store', 'Now', 'Before', 'Change'], ups.slice(0, o.top).map(({ r, pct }) => [dealName(r), cell(r.merchant),
            nowPrice(r, m), m(r, r.previous_price), `+${pct.toFixed(0)}%`])), '');
    }

    const ended = Array.isArray(changes?.expiredItems) ? changes.expiredItems : [];
    if (ended.length) {
        out.push(`## Ended since the last run (${Math.min(o.top, ended.length)} of ${totals.expired ?? ended.length})`, '');
        out.push(table(['Deal', 'Store', 'Last price'], ended.slice(0, o.top).map((e) => [cell(shorten(String(e.name ?? ''))), cell(e.merchant),
            e.lastPrice != null ? `$${Number(e.lastPrice).toFixed(2)}` : ''])), '');
    }
    return out.join('\n');
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(HELP); return; }
    const { items, changes, finishedAt } = await load(o);
    const rows = items.filter(isDeal).map(toRow);
    if (rows.length && rows.every((r) => r.change_type == null)) {
        throw new Error('These deals have no change_type: the run had trackChanges off. Use --input (it switches it on), '
            + 'or turn on "Track week-over-week changes" in the task.');
    }
    const md = `${digest(rows, changes, o, finishedAt).trimEnd()}\n`;
    if (o.out) {
        writeFileSync(o.out, md);
        console.error(`Wrote the digest of ${rows.length} deals to ${o.out}`);
    } else {
        process.stdout.write(md);
    }
    if (o.csv) {
        const changed = rows.filter((r) => ['price_drop', 'new', 'price_up'].includes(r.change_type));
        await writeRows(o.csv, changed);
        console.error(`Wrote ${changed.length} new or re-priced deals to ${o.csv}`);
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
