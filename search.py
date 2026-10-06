#!/usr/bin/env python3
"""Search every weekly flyer near a postal code or ZIP for products, and export the deals to CSV,
Excel (.xlsx) or JSONL, lowest price first.

Calls the yugenox/flipp-flyer-deals-scraper Actor on Apify in Search mode: one search per term
and postal code, past Flipp's 200-results-per-search cap (the Actor re-runs a capped search
store by store). Rows: product, store, per-item price, $/kg, the price as printed, regular
price, discount, multi-buy, valid dates, and (with --details) size, SKU and product link.

Run with --help for every option. Requires Python 3.10+ and `pip install -r requirements.txt`
(openpyxl is only needed for .xlsx). APIFY_TOKEN comes from the environment or a .env file next
to this script; --from needs no token.
"""

from __future__ import annotations

import argparse
import sys
import unicodedata

from flyerlib import PRICE_NOTE, check_out, deals_for_cap, export_deals, is_postal, read_list, split_list

TYPES = ["flyer", "store", "online"]

EPILOG = f"""\
{PRICE_NOTE}

examples:
  python search.py --postal "M5V 2T6" milk "chicken breast" --out deals.xlsx
  python search.py --postal "M5V 2T6" --postal 10001 --file basket.example.txt --valid-now
  python search.py --from samples/toronto-chicken-breast.json --out deals.csv
"""


def main() -> None:
    p = argparse.ArgumentParser(
        prog="search.py",
        description="Search weekly flyers near a postal code or ZIP; export the deals, lowest price first.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("terms", nargs="*", metavar="TERM", help='products, e.g. milk "chicken breast" tv (one search per term)')
    s = p.add_argument_group("what to search")
    s.add_argument("--file", metavar="PATH", help="one search term per line (# lines skipped)")
    s.add_argument("--postal", action="append", default=[], metavar="CODE",
                   help="full Canadian postal code (M5V 2T6) or US ZIP (10001); repeat for more")
    s.add_argument("--stores", action="append", default=[], metavar="LIST",
                   help='only these stores: names or Flipp store ids, comma-separated ("No Frills,Walmart")')
    s.add_argument("--categories", action="append", default=[], metavar="LIST",
                   help="only these flyer or product categories, comma-separated (partial names work)")
    s.add_argument("--types", metavar="LIST", help="flyer, store, online (default flyer,store)")
    s.add_argument("--valid-now", action="store_true", help="skip deals from flyers that haven't started yet or have ended")
    s.add_argument("--details", action="store_true", help="add size/description, SKU, product link and sale text (+$0.0005 per deal)")
    s.add_argument("--top-200", action="store_true", help="one plain search per term (at most 200 results), no store-by-store split")
    s.add_argument("--track", action="store_true", help="fill change_type and previous_price against the last run of the same search")
    s.add_argument("--french", action="store_true", help="French names where retailers publish them (Canadian postal codes)")
    s.add_argument("--max", type=int, metavar="N", help="at most N deals for the whole run")
    o = p.add_argument_group("output")
    o.add_argument("--out", default="deals.csv", metavar="PATH", help="output path: .csv (default deals.csv), .xlsx or .jsonl")
    o.add_argument("--keep-order", action="store_true", help="keep the Actor's order (default: lowest price first per search term)")
    o.add_argument("--max-charge", type=float, default=2.0, metavar="USD", help="hard cost cap for the run in USD, enforced by Apify (default 2)")
    r = p.add_argument_group("re-export without a new run")
    r.add_argument("--dataset", metavar="ID", help="export the dataset of a run you already made (no new run starts)")
    r.add_argument("--from", dest="from_file", metavar="FILE", help="convert a JSON/JSONL file of the Actor's rows or of these scripts' rows (no token needed)")
    args = p.parse_args()

    terms = list(args.terms) + (read_list(args.file) if args.file else [])
    postals = [x.strip() for x in args.postal]
    stores = [x for v in args.stores for x in split_list(v)]
    categories = [x for v in args.categories for x in split_list(v)]
    types = split_list(args.types) if args.types else None
    check_out(p, args.out)
    if args.max is not None and args.max < 1:
        p.error("--max needs a number above 0")
    if args.max_charge <= 0:
        p.error("--max-charge needs a number above 0")
    bad = [t for t in (types or []) if t not in TYPES]
    if bad:
        p.error(f"--types: {', '.join(bad)} isn't one of {', '.join(TYPES)}")
    if args.dataset or args.from_file:
        if args.dataset and args.from_file:
            p.error("use --dataset or --from, not both")
        if terms or postals:
            p.error("--dataset and --from export rows that already exist; leave out search terms and --postal")
    else:
        if not terms:
            p.error("give one or more search terms (or --file), --dataset <id> or --from <file>")
        if not postals:
            p.error("give --postal with a full Canadian postal code (M5V 2T6) or a US ZIP (10001)")
        bad_postal = [x for x in postals if not is_postal(x)]
        if bad_postal:
            sys.exit(f"Not a full postal code or ZIP: {'; '.join(bad_postal)}. Use e.g. M5V 2T6 or 10001; "
                     "the first three characters of a postal code are not enough.")
        # Flipp searches words with Latin letters or digits; an emoji-only term would match nothing useful.
        no_words = [t for t in terms if not any(c.isascii() and c.isalnum() for c in unicodedata.normalize("NFD", t))]
        if no_words:
            sys.exit(f"Search terms need letters or digits: {'; '.join(no_words)}")

    run_input = {
        "mode": "search",
        "postalCodes": postals,
        "searchTerms": terms,
        "itemTypes": types or ["flyer", "store"],
        "onlyValidNow": args.valid_now,
        "includeItemDetails": args.details,
        "completeCoverage": not args.top_200,
        "trackChanges": args.track,
        "language": "fr" if args.french else "en",
    }
    if stores:
        run_input["merchants"] = stores
    if categories:
        run_input["categories"] = categories
    if args.max:
        run_input["maxItems"] = args.max
    if not args.from_file and not args.dataset:
        cap = deals_for_cap(args.max_charge, args.details)
        most = f", at most {args.max} deals" if args.max else ""
        print(f"Running yugenox/flipp-flyer-deals-scraper: {len(terms)} term(s) x {len(postals)} postal code(s){most}, "
              f"cost cap ${args.max_charge:g} (about {cap} deals) ...", file=sys.stderr)
        if args.max and args.max > cap:
            print(f"--max {args.max} is more than the ${args.max_charge:g} cap pays for; deals past the cap are not collected. "
                  "Raise --max-charge to get them all.", file=sys.stderr)
    export_deals(args, run_input, sort=not args.keep_order)


if __name__ == "__main__":
    main()
