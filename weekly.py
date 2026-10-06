#!/usr/bin/env python3
"""Weekly flyer price-drop digest in Markdown: price drops, new deals, price increases and deals
that ended since the last run of the same input.

Runs yugenox/flipp-flyer-deals-scraper with trackChanges on (or reads a run that already
finished, e.g. from an Apify schedule), then turns each row's change_type / previous_price and
the run's CHANGES record into a short report you can email, post or commit. Same digest as
weekly.mjs.

Run with --help for every option. Requires Python 3.10+; APIFY_TOKEN from the environment or a
.env file next to this script for --input, --run and --task.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from flyerlib import (
    apify_client, check_out, dataset_items, deals_for_cap, field, is_deal, read_from_file, run_actor,
    to_row, write_rows,
)

EPILOG = """\
price of a run: $0.0015 per deal, +$0.0005 per deal with item details, and from 2026-10-11
19:57 UTC a $0.001 start fee per run (Apify API, read 2026-10-06). Not affiliated with Flipp.

examples:
  python weekly.py --input weekly.example.json --out digest.md
  python weekly.py --task <taskId> --out digest.md --csv changes.csv
  python weekly.py --from rows.json --changes CHANGES.json --out digest.md
"""


def load(args):
    if args.from_file:
        changes = json.loads(Path(args.changes).read_text(encoding="utf-8")) if args.changes else None
        return read_from_file(args.from_file), changes, None
    client = apify_client()
    if args.input:
        run_input = {**json.loads(Path(args.input).read_text(encoding="utf-8")), "trackChanges": True}
        if run_input.get("maxItems") or run_input.get("maxItemsPerPostalCode"):
            print("Note: with maxItems or maxItemsPerPostalCode set, the Actor compares only the deals it saved "
                  "and does not report deals that ended.", file=sys.stderr)
        print(f"Running yugenox/flipp-flyer-deals-scraper with trackChanges, cost cap ${args.max_charge:g} "
              f"(about {deals_for_cap(args.max_charge, bool(run_input.get('includeItemDetails')))} deals) ...", file=sys.stderr)
        run, _ = run_actor(client, run_input, args.max_charge)
    elif args.task:
        run = client.task(args.task).last_run(status="SUCCEEDED").get()
        if run is None:
            sys.exit(f"Task {args.task} has no succeeded run yet")
    else:
        run = client.run(args.run).get()
        if run is None:
            sys.exit(f"Run {args.run} not found")
    finished = field(run, "finishedAt", "finished_at")
    if not args.input:
        status = field(run, "status", "status")
        print(f"Reading run {field(run, 'id', 'id')} ({getattr(status, 'value', status)})", file=sys.stderr)
    items = dataset_items(client, field(run, "defaultDatasetId", "default_dataset_id"))
    record = client.key_value_store(field(run, "defaultKeyValueStoreId", "default_key_value_store_id")).get_record("CHANGES")
    value = field(record, "value", "value") if record is not None else None
    return items, value, finished


# ---- the digest -------------------------------------------------------------------------------------


def _round(x: float, places: int) -> str:
    """Round half up on the exact binary value, like JavaScript's toFixed, so both scripts agree."""
    q = Decimal(1).scaleb(-places)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def price_of(r):
    return r.get("effective_price") if r.get("effective_price") is not None else r.get("current_price")


def cell(v) -> str:
    return re.sub(r"\s+", " ", str("" if v is None else v)).replace("|", "\\|").strip()


def shorten(s: str, n: int = 70) -> str:
    return s[: n - 1].rstrip() + "…" if len(s) > n else s


def deal_name(r) -> str:
    brand, name = r.get("brand"), r.get("name")
    show_brand = brand and str(brand).lower() not in str(name or "").lower()
    return cell(shorten(" ".join(str(x) for x in (brand if show_brand else None, name) if x)))


def _parse(v):
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None


def end_date(v) -> str:
    """The date a deal ends, in this computer's time zone (flyers usually end at 23:59 local time)."""
    d = _parse(v)
    return d.astimezone().strftime("%Y-%m-%d") if d else ""


def money(v, unit, currency, show_currency) -> str:
    if v is None or v == "":
        return ""
    per = f"/{unit}" if unit and unit != "each" else ""
    return f"${_round(float(v), 2)}{per}" + (f" {currency}" if show_currency and currency else "")


def now_price(r, m) -> str:
    """The per-item price, plus the multi-buy as printed: "$5.00 (2 for $10.00)"."""
    extra = ""
    if r.get("multi_buy_qty") and r.get("multi_buy_total") is not None:
        extra = f" ({r['multi_buy_qty']} for ${_round(float(r['multi_buy_total']), 2)})"
    return m(r, price_of(r)) + extra


def table(header, rows) -> str:
    align = ["---:" if re.fullmatch(r"Now|Before|Change|Price|Last price|Off", h) else "---" for h in header]
    return "\n".join([f"| {' | '.join(header)} |", f"|{'|'.join(align)}|"] + [f"| {' | '.join(r)} |" for r in rows])


def _num(v):
    return str(v)


def digest(rows, changes, top, min_drop, title, finished) -> str:
    currencies = list(dict.fromkeys(r.get("currency") for r in rows if r.get("currency")))
    show_cur = len(currencies) > 1

    def m(r, v):
        return money(v, r.get("price_unit"), r.get("currency"), show_cur)

    def count(t):
        return sum(1 for r in rows if r.get("change_type") == t)

    ch = changes or {}
    totals = {k: ch.get(k) if ch.get(k) is not None else count(k) for k in ("new", "price_drop", "price_up", "unchanged")}
    totals["expired"] = ch.get("expired")
    first_run = bool(ch.get("firstRun")) if changes else (len(rows) > 0 and totals["new"] == len(rows))
    when = _parse(finished) if finished else None
    if when is None:
        stamps = sorted(r.get("scraped_at") for r in rows if r.get("scraped_at"))
        when = _parse(stamps[-1]) if stamps else datetime.now().astimezone()
    out = [f"# {title or 'Flyer deals: week of ' + end_date(when)}", ""]
    terms = list(dict.fromkeys(r.get("search_term") for r in rows if r.get("search_term")))
    stores = list(dict.fromkeys(r.get("merchant") for r in rows if r.get("merchant")))
    postals = list(dict.fromkeys(r.get("postal_code") for r in rows if r.get("postal_code")))
    line = f"{len(rows)} deals from {len(stores)} store{'' if len(stores) == 1 else 's'}"
    if postals:
        line += f" near {', '.join(postals[:5])}" + (f" and {len(postals) - 5} more" if len(postals) > 5 else "")
    if terms:
        line += " for " + ", ".join(f'"{t}"' for t in terms[:8]) + ("…" if len(terms) > 8 else "")
    line += "."
    if len(currencies) == 1:
        line += f" Prices in {currencies[0]}, per item unless a unit is shown."
    out += [line, ""]

    if first_run:
        out += ["First run of this input: every deal is marked new. Run the same input again next week to see price drops, "
                "new deals and deals that ended.", ""]
        best = sorted((r for r in rows if r.get("discount_pct") is not None),
                      key=lambda r: (-r["discount_pct"], -(r.get("dollars_off") or 0)))
        if best:
            out += [f"## Biggest discounts this week ({min(top, len(best))} of {len(best)})", ""]
            out += [table(["Deal", "Store", "Price", "Off", "Ends"],
                          [[deal_name(r), cell(r.get("merchant")), now_price(r, m), f"{_num(r['discount_pct'])}%", end_date(r.get("valid_to"))]
                           for r in best[:top]]), ""]
        return "\n".join(out)

    since = f" since {str(ch['previousRunAt'])[:10]}" if ch.get("previousRunAt") else ""
    ended_txt = f", {totals['expired']} deals ended" if totals["expired"] is not None else ""
    out.append(f"Changes{since}: **{totals['price_drop']} price drops**, {totals['new']} new deals, "
               f"{totals['price_up']} price increases{ended_txt}, {totals['unchanged']} unchanged.")
    if changes and changes.get("complete") is False:
        out += ["", "_This run was capped or partial, so deals that ended are not reported._"]
    out.append("")

    drops = []
    for r in rows:
        prev, now = r.get("previous_price"), price_of(r)
        if r.get("change_type") == "price_drop" and prev is not None and float(prev) > 0 and now is not None:
            pct = (float(prev) - float(now)) / float(prev) * 100
            if pct >= min_drop:
                drops.append((r, pct))
    drops.sort(key=lambda x: -x[1])
    out += [f"## Price drops ({min(top, len(drops))} of {len(drops)}" + (f", {min_drop:g}% or more" if min_drop else "") + ")", ""]
    out += [table(["Deal", "Store", "Now", "Before", "Change", "Ends"],
                  [[deal_name(r), cell(r.get("merchant")), now_price(r, m), m(r, r.get("previous_price")),
                    f"-{_round(pct, 0)}%", end_date(r.get("valid_to"))] for r, pct in drops[:top]])
            if drops else "None.", ""]

    fresh = sorted((r for r in rows if r.get("change_type") == "new"),
                   key=lambda r: (-(r["discount_pct"] if r.get("discount_pct") is not None else -1),
                                  -(r["dollars_off"] if r.get("dollars_off") is not None else -1)))
    out += [f"## New deals ({min(top, len(fresh))} of {len(fresh)}, biggest discount first)", ""]
    out += [table(["Deal", "Store", "Price", "Off", "Ends"],
                  [[deal_name(r), cell(r.get("merchant")), now_price(r, m),
                    f"{_num(r['discount_pct'])}%" if r.get("discount_pct") is not None else "", end_date(r.get("valid_to"))]
                   for r in fresh[:top]])
            if fresh else "None.", ""]

    ups = []
    for r in rows:
        prev, now = r.get("previous_price"), price_of(r)
        if r.get("change_type") == "price_up" and prev is not None and float(prev) > 0 and now is not None:
            ups.append((r, (float(now) - float(prev)) / float(prev) * 100))
    ups.sort(key=lambda x: -x[1])
    if ups:
        out += [f"## Price increases ({min(top, len(ups))} of {len(ups)})", ""]
        out += [table(["Deal", "Store", "Now", "Before", "Change"],
                      [[deal_name(r), cell(r.get("merchant")), now_price(r, m), m(r, r.get("previous_price")), f"+{_round(pct, 0)}%"]
                       for r, pct in ups[:top]]), ""]

    ended = ch.get("expiredItems") if isinstance(ch.get("expiredItems"), list) else []
    if ended:
        total = totals["expired"] if totals["expired"] is not None else len(ended)
        out += [f"## Ended since the last run ({min(top, len(ended))} of {total})", ""]
        out += [table(["Deal", "Store", "Last price"],
                      [[cell(shorten(str(e.get("name") or ""))), cell(e.get("merchant")),
                        f"${_round(float(e['lastPrice']), 2)}" if e.get("lastPrice") is not None else ""] for e in ended[:top]]), ""]
    return "\n".join(out)


def main() -> None:
    p = argparse.ArgumentParser(
        prog="weekly.py",
        description="Weekly flyer price-drop digest (Markdown) from a change-tracking run.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    src = p.add_argument_group("where the deals come from (pick one)")
    src.add_argument("--input", metavar="FILE", help="Actor input (JSON) for a new run; trackChanges is switched on for you")
    src.add_argument("--task", metavar="ID", help="the last succeeded run of a saved Apify task (no new run starts)")
    src.add_argument("--run", metavar="ID", help="a run that already finished (no new run starts)")
    src.add_argument("--from", dest="from_file", metavar="FILE", help="offline: the run's rows as JSON or JSONL (no token needed)")
    src.add_argument("--changes", metavar="FILE", help="with --from: the run's CHANGES record (JSON)")
    o = p.add_argument_group("output")
    o.add_argument("--out", metavar="PATH", help="write the digest here (default: print it)")
    o.add_argument("--csv", metavar="PATH", help="also write the new, cheaper and pricier deals (.csv, .xlsx or .jsonl)")
    o.add_argument("--top", type=int, default=25, metavar="N", help="rows per table (default 25)")
    o.add_argument("--min-drop", type=float, default=0, metavar="PCT", help="only list price drops of at least this many percent")
    o.add_argument("--title", metavar="TEXT", help='heading (default "Flyer deals: week of <date>")')
    o.add_argument("--max-charge", type=float, default=2.0, metavar="USD", help="hard cost cap for an --input run (default 2)")
    args = p.parse_args()

    if sum(bool(x) for x in (args.input, args.task, args.run, args.from_file)) != 1:
        p.error("give exactly one of --input, --task, --run or --from")
    if args.changes and not args.from_file:
        p.error("--changes goes with --from (the other sources read the record from the run)")
    if args.top < 1:
        p.error("--top needs a number of 1 or more")
    if args.min_drop < 0:
        p.error("--min-drop needs a number of 0 or more")
    if args.max_charge < 0.01:
        p.error("--max-charge needs a number of 0.01 or more")
    if args.csv:
        check_out(p, args.csv)

    items, changes, finished = load(args)
    rows = [to_row(it) for it in items if is_deal(it)]
    if rows and all(r.get("change_type") is None for r in rows):
        sys.exit("These deals have no change_type: the run had trackChanges off. Use --input (it switches it on), "
                 'or turn on "Track week-over-week changes" in the task.')
    md = digest(rows, changes, args.top, args.min_drop, args.title, finished).rstrip() + "\n"
    if args.out:
        Path(args.out).write_text(md, encoding="utf-8")
        print(f"Wrote the digest of {len(rows)} deals to {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(md)
    if args.csv:
        changed = [r for r in rows if r.get("change_type") in ("price_drop", "new", "price_up")]
        write_rows(args.csv, changed)
        print(f"Wrote {len(changed)} new or re-priced deals to {args.csv}", file=sys.stderr)


if __name__ == "__main__":
    main()
