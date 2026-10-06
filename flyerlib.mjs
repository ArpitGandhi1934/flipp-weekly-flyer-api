// Shared by search.mjs, flyers.mjs and weekly.mjs: the Actor call, the flat output row, sorting,
// and the CSV / Excel (.xlsx) / JSONL writers. flyerlib.py is the Python twin; both write
// byte-identical CSV and JSONL.

import { readFileSync, writeFileSync } from 'node:fs';

export const ACTOR = 'yugenox/flipp-flyer-deals-scraper';

// From the Actor's pricing in the Apify API, read 2026-10-06. The Store page shows the current price.
export const PRICE_PER_DEAL = 0.0015; // every deal saved
export const PRICE_PER_DETAILS = 0.0005; // add-on per deal with --details
export const START_FEE = 0.001; // per run (per GB of memory, 1 GB by default) ...
export const START_FEE_FROM = '2026-10-11T19:57:49Z'; // ... from this moment; $0 before it

// Column order for CSV, XLSX and JSONL.
export const COLUMNS = ['search_term', 'rank', 'price_basis', 'name', 'brand', 'merchant', 'effective_price',
    'price_per_kg', 'price_unit', 'price_as_printed', 'sale_story', 'current_price', 'original_price',
    'discount_pct', 'dollars_off', 'multi_buy_qty', 'multi_buy_total', 'currency', 'valid_from', 'valid_to',
    'item_type', 'store_address', 'description', 'sku', 'product_url', 'image_url', 'flyer_id', 'flyer_name',
    'flyer_categories', 'product_category', 'in_store_only', 'rating', 'review_count', 'postal_code',
    'change_type', 'previous_price', 'item_id', 'merchant_id', 'scraped_at'];
const NUMBER_COLUMNS = new Set(['rank', 'effective_price', 'price_per_kg', 'current_price',
    'original_price', 'discount_pct', 'dollars_off', 'multi_buy_qty', 'multi_buy_total', 'rating',
    'review_count', 'previous_price']);
const DATE_COLUMNS = new Set(['valid_from', 'valid_to', 'scraped_at']);

// Canadian postal code (M5V 2T6, M5V2T6) or US ZIP (10001, 10001-1234). The first three
// characters of a postal code ("M5V") are not enough for Flipp.
export const isPostal = (s) => /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/.test(s.trim()) || /^\d{5}(-?\d{4})?$/.test(s.trim());

export const splitList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);

export function readList(path) {
    return readFileSync(path, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
}

// $/kg is only meaningful for deals priced by weight (the Actor's README: "$/kg for weight-priced
// items"). A few in-store prices print an estimate such as "(est.) ea ($17.61/1kg ...)" and come back
// with no unit and a $/kg that doesn't match; for those price_per_kg is left empty.
const WEIGHT_UNITS = new Set(['lb', 'kg', '100g']);

const text = (parts) => {
    const s = parts.filter((p) => p != null && String(p).trim() !== '').map((p) => String(p).trim()).join(' ');
    return s || null;
};

// One Actor row (or one row these scripts wrote earlier) -> one flat output row.
export function toRow(r) {
    if ('item_type' in r) return Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? null]));
    const mb = r.multiBuy && typeof r.multiBuy === 'object' ? r.multiBuy : null;
    const cats = Array.isArray(r.flyerCategories) ? r.flyerCategories.filter(Boolean) : [];
    const perKg = WEIGHT_UNITS.has(r.priceUnit) ? (r.pricePerKg ?? null) : null;
    const each = r.effectivePrice ?? null;
    return {
        search_term: r.searchTerm ?? null,
        rank: null, // set by lowestPriceFirst()
        price_basis: perKg != null ? 'kg' : each != null && Number(each) > 0 ? 'item' : null,
        name: r.name ?? null,
        brand: r.brand ?? null,
        merchant: r.merchant ?? null,
        effective_price: each,
        price_per_kg: perKg,
        price_unit: r.priceUnit ?? null,
        price_as_printed: text([r.prePriceText, r.priceText, r.postPriceText]),
        sale_story: r.saleStory ?? null,
        current_price: r.currentPrice ?? null,
        original_price: r.originalPrice ?? null,
        discount_pct: r.discountPct ?? null,
        dollars_off: r.dollarsOff ?? null,
        multi_buy_qty: mb?.quantity ?? null,
        multi_buy_total: mb?.totalPrice ?? null,
        currency: r.currency ?? null,
        valid_from: r.validFrom ?? null,
        valid_to: r.validTo ?? null,
        item_type: r.itemType ?? null,
        store_address: r.storeAddress ?? null,
        description: r.description ?? null,
        sku: r.sku ?? null,
        product_url: r.productUrl ?? null,
        image_url: r.imageUrl ?? null,
        flyer_id: r.flyerId ?? null,
        flyer_name: r.flyerName ?? null,
        flyer_categories: cats.length ? cats.join(' | ') : null,
        product_category: r.categoryL1 && r.categoryL2 ? `${r.categoryL1} > ${r.categoryL2}` : (r.categoryL1 ?? r.categoryL2 ?? null),
        in_store_only: r.inStoreOnly ?? null,
        rating: r.rating ?? null,
        review_count: r.reviewCount ?? null,
        postal_code: r.postalCode ?? null,
        change_type: r.changeType ?? null,
        previous_price: r.previousPrice ?? null,
        item_id: r.itemId ?? null,
        merchant_id: r.merchantId ?? null,
        scraped_at: r.scrapedAt ?? null,
    };
}

export const isDeal = (r) => r && typeof r === 'object' && ('item_type' in r || 'itemType' in r);

// Lowest price first within each search term (terms keep the order they first appear in): deals priced
// by weight by $/kg, then deals priced per item by the per-item price, then deals with no single
// price ("20% off"). The two price bases aren't comparable, so each gets its own rank: 1 = lowest
// for that search term and price basis.
export function lowestPriceFirst(rows) {
    const termOrder = new Map();
    for (const r of rows) if (!termOrder.has(r.search_term ?? '')) termOrder.set(r.search_term ?? '', termOrder.size);
    const basis = { kg: 0, item: 1 };
    const value = (r) => Number(r.price_basis === 'kg' ? r.price_per_kg : r.price_basis === 'item' ? r.effective_price : 0);
    const sorted = rows
        .map((r, i) => ({ r, i, t: termOrder.get(r.search_term ?? ''), b: basis[r.price_basis] ?? 2, v: value(r) }))
        .sort((a, b) => a.t - b.t || a.b - b.b || a.v - b.v || a.i - b.i)
        .map((x) => x.r);
    const counter = new Map();
    for (const r of sorted) {
        if (!r.price_basis) { r.rank = null; continue; }
        const k = `${r.search_term ?? ''}\u0000${r.price_basis}`;
        counter.set(k, (counter.get(k) ?? 0) + 1);
        r.rank = counter.get(k);
    }
    return sorted;
}

// CSV cell. Text that starts with = + - @, a tab or a carriage return gets a leading ' so Excel and
// Google Sheets show it as text instead of running it as a formula.
function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function writeXlsx(path, rows) {
    // Loaded only for .xlsx so CSV/JSONL users don't need it.
    const { default: writeExcelFile } = await import('write-excel-file/node').catch(() => {
        throw new Error('Writing .xlsx needs write-excel-file: run npm install');
    });
    // Strip characters that are not allowed in XLSX (XML) cells.
    const clean = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const cell = (col, v) => {
        if (v == null || v === '') return null;
        if (NUMBER_COLUMNS.has(col)) return { value: Number(v), type: Number };
        if (DATE_COLUMNS.has(col) && !Number.isNaN(Date.parse(v))) {
            return { value: new Date(v), type: Date, format: 'yyyy-mm-dd hh:mm' }; // UTC
        }
        if (typeof v === 'boolean') return { value: v, type: Boolean };
        return { value: clean(v), type: String };
    };
    const data = [
        COLUMNS.map((value) => ({ value, fontWeight: 'bold' })),
        ...rows.map((r) => COLUMNS.map((c) => cell(c, r[c]))),
    ];
    const widths = { name: 45, merchant: 18, price_as_printed: 16, sale_story: 18, store_address: 36, description: 40,
        product_url: 40, image_url: 40, flyer_categories: 26, product_category: 30, valid_from: 17, valid_to: 17, scraped_at: 17 };
    const columns = COLUMNS.map((c) => ({ width: widths[c] ?? 12 }));
    await writeExcelFile(data, { columns, stickyRowsCount: 1, sheet: 'Deals' }).toFile(path);
}

export async function writeRows(path, rows) {
    if (/\.xlsx$/i.test(path)) return writeXlsx(path, rows);
    if (/\.jsonl$/i.test(path)) {
        writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
        return;
    }
    const lines = rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','));
    // UTF-8 with a BOM, so Excel shows accents (Québec, crème) correctly when it opens the file.
    writeFileSync(path, `﻿${[COLUMNS.join(','), ...lines].join('\r\n')}\r\n`);
}

export function checkOut(path) {
    if (!/\.(csv|xlsx|jsonl)$/i.test(path)) throw new Error(`${path}: output files must end in .csv, .xlsx or .jsonl`);
}

// A JSON array, a single JSON object or JSONL: an Apify Console export of the Actor's rows, or a
// .jsonl file these scripts wrote.
export function readFromFile(path) {
    const body = readFileSync(path, 'utf8').replace(/^﻿/, '').trim();
    if (!body) return [];
    const data = body.startsWith('[') ? JSON.parse(body) : body.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return Array.isArray(data) ? data : [data];
}

export const startFeeNow = () => (Date.now() >= Date.parse(START_FEE_FROM) ? START_FEE : 0);

// How many deals a cost cap pays for.
export function dealsForCap(maxCharge, details) {
    return Math.max(0, Math.floor((maxCharge - startFeeNow()) / (PRICE_PER_DEAL + (details ? PRICE_PER_DETAILS : 0)) + 1e-9));
}

export async function apifyClient() {
    if (!process.env.APIFY_TOKEN) throw new Error('Set APIFY_TOKEN (see .env.example), or use --from <file>');
    const { ApifyClient } = await import('apify-client'); // loaded here so --help and --from work before npm install
    return new ApifyClient({ token: process.env.APIFY_TOKEN });
}

// Start a run, wait for it, print how it ended. maxTotalChargeUsd is a hard cost cap Apify enforces.
export async function runActor(client, input, maxCharge) {
    const run = await client.actor(ACTOR).call(input, { maxTotalChargeUsd: maxCharge });
    console.error(`Run ${run.id} finished: ${run.status}${run.statusMessage ? ` (${run.statusMessage})` : ''}`);
    return run;
}

export async function datasetItems(client, datasetId) {
    const items = [];
    for await (const it of client.dataset(datasetId).listItems()) items.push(it);
    return items;
}

// Shared tail of search.mjs and flyers.mjs: new run, --dataset or --from -> rows -> file.
export async function exportDeals(o, input, { sort }) {
    let items;
    let failedRun = false;
    if (o.from) {
        items = readFromFile(o.from);
    } else {
        const client = await apifyClient();
        let datasetId = o.dataset;
        if (!datasetId) {
            const run = await runActor(client, input, o.maxCharge);
            failedRun = run.status !== 'SUCCEEDED';
            datasetId = run.defaultDatasetId;
        }
        items = await datasetItems(client, datasetId);
    }
    if (failedRun && items.length === 0) {
        console.error(`No deals, so ${o.out} was left as it was.`);
        process.exit(1);
    }
    let rows = items.filter(isDeal).map(toRow);
    if (sort) rows = lowestPriceFirst(rows);
    await writeRows(o.out, rows);
    console.error(`Wrote ${rows.length} deals to ${o.out}`);
}
