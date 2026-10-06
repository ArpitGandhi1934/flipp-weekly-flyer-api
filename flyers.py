#!/usr/bin/env python3
"""Export every item in every weekly flyer near one or more postal codes / ZIPs (or in flyers you
name) to CSV, Excel (.xlsx) or JSONL.

Calls the yugenox/flipp-flyer-deals-scraper Actor on Apify in Full-flyer mode (postal codes or
region presets) or Specific-flyer mode (flyer ids or flipp.com flyer links). Narrow it with
--stores, --categories and --keywords; each flyer shared by several postal codes is read once.

Run with --help for every option. Requires Python 3.10+ and `pip install -r requirements.txt`
(openpyxl is only needed for .xlsx). APIFY_TOKEN comes from the environment or a .env file next
to this script; --from needs no token.
"""

from __future__ import annotations

import argparse
import re
import sys

from flyerlib import PRICE_NOTE, check_out, deals_for_cap, export_deals, is_postal, split_list

PRESETS = ["ca-major-cities", "us-major-cities"]

EPILOG = f"""\
One big-city postal code has about 15,000 to 30,000 flyer items: narrow with --stores,
--categories or --keywords, or raise --max-charge. Without --details, rows carry the printed
price only (no sale text, unit or multi-buy split).

{PRICE_NOTE}

examples:
  python flyers.py "V6B 1A1" --categories Groceries --valid-now --details --out vancouver.csv
  python flyers.py --preset ca-major-cities --stores "No Frills" --max-charge 20 --out no-frills.csv
  python flyers.py --flyer <flyer_id> --out one-flyer.xlsx
"""


def main() -> None:
    p = argparse.ArgumentParser(
        prog="flyers.py",
        description="Export every item in the weekly flyers near a postal code or ZIP (or in flyers you name).",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("postals", nargs="*", metavar="POSTAL", help="full Canadian postal codes (V6B 1A1) or US ZIPs (10001)")
    w = p.add_argument_group("which flyers")
    w.add_argument("--preset", action="append", default=[], choices=PRESETS,
                   help="ca-major-cities (46 Canadian cities) or us-major-cities (50 US metros); repeatable")
    w.add_argument("--flyer", action="append", default=[], metavar="ID_OR_LINK",
                   help="only these flyers: a flyer_id from any export or a flipp.com flyer link; repeatable")
    i = p.add_argument_group("which items")
    i.add_argument("--stores", action="append", default=[], metavar="LIST", help="only these stores: names or Flipp store ids, comma-separated")
    i.add_argument("--categories", action="append", default=[], metavar="LIST", help="only these flyer categories, comma-separated (partial names work)")
    i.add_argument("--keywords", action="append", default=[], metavar="LIST",
                   help="only items matching one of these, comma-separated (every word must start a word in the name, brand or description)")
    i.add_argument("--valid-now", action="store_true", help="skip flyers that haven't started yet or have ended")
    i.add_argument("--details", action="store_true", help="add sale text, unit, size, SKU and product link (+$0.0005 per deal)")
    i.add_argument("--track", action="store_true", help="fill change_type and previous_price against the last run of the same input")
    i.add_argument("--french", action="store_true", help="French names where retailers publish them (Canadian postal codes)")
    i.add_argument("--no-dedupe", action="store_true", help="one row per deal per postal code (default: each deal once)")
    i.add_argument("--max", type=int, metavar="N", help="at most N deals for the whole run")
    i.add_argument("--per-postal", type=int, metavar="N", help="at most N deals per postal code")
    o = p.add_argument_group("output")
    o.add_argument("--out", default="flyers.csv", metavar="PATH", help="output path: .csv (default flyers.csv), .xlsx or .jsonl")
    o.add_argument("--max-charge", type=float, default=2.0, metavar="USD", help="hard cost cap for the run in USD, enforced by Apify (default 2)")
    r = p.add_argument_group("re-export without a new run")
    r.add_argument("--dataset", metavar="ID", help="export the dataset of a run you already made (no new run starts)")
    r.add_argument("--from", dest="from_file", metavar="FILE", help="convert a JSON/JSONL file of the Actor's rows or of these scripts' rows (no token needed)")
    args = p.parse_args()

    postals = [x.strip() for x in args.postals]
    flyers = [x.strip() for x in args.flyer]
    stores = [x for v in args.stores for x in split_list(v)]
    categories = [x for v in args.categories for x in split_list(v)]
    keywords = [x for v in args.keywords for x in split_list(v)]
    check_out(p, args.out)
    for flag, n in (("--max", args.max), ("--per-postal", args.per_postal)):
        if n is not None and n < 1:
            p.error(f"{flag} needs a number above 0")
    if args.max_charge <= 0:
        p.error("--max-charge needs a number above 0")
    if args.dataset or args.from_file:
        if args.dataset and args.from_file:
            p.error("use --dataset or --from, not both")
        if postals or args.preset or flyers:
            p.error("--dataset and --from export rows that already exist; leave out postal codes, --preset and --flyer")
    else:
        if flyers and (postals or args.preset):
            p.error("--flyer reads only the flyers you name; leave out postal codes and --preset")
        if not flyers and not postals and not args.preset:
            p.error("give postal codes, --preset, --flyer, --dataset <id> or --from <file>")
        bad_postal = [x for x in postals if not is_postal(x)]
        if bad_postal:
            sys.exit(f"Not a full postal code or ZIP: {'; '.join(bad_postal)}. Use e.g. V6B 1A1 or 10001; "
                     "the first three characters of a postal code are not enough.")
        bad_flyer = [f for f in flyers if not re.fullmatch(r"\d{5,10}", f) and not re.search(r"flipp\.com/.*\d{5,10}", f, re.I)]
        if bad_flyer:
            sys.exit(f"Not a flyer id or flipp.com flyer link: {'; '.join(bad_flyer)}")

    run_input = {
        "mode": "flyerIds" if flyers else "flyers",
        "onlyValidNow": args.valid_now,
        "includeItemDetails": args.details,
        "trackChanges": args.track,
        "dedupeAcrossPostalCodes": not args.no_dedupe,
        "language": "fr" if args.french else "en",
    }
    if flyers:
        run_input["flyerIds"] = flyers
    if postals:
        run_input["postalCodes"] = postals
    if args.preset:
        run_input["regionPresets"] = args.preset
    if stores:
        run_input["merchants"] = stores
    if categories:
        run_input["categories"] = categories
    if keywords:
        run_input["searchTerms"] = keywords
    if args.max:
        run_input["maxItems"] = args.max
    if args.per_postal:
        run_input["maxItemsPerPostalCode"] = args.per_postal
    if not args.from_file and not args.dataset:
        cap = deals_for_cap(args.max_charge, args.details)
        where = f"{len(flyers)} flyer(s)" if flyers else " + ".join(
            ([f"{len(postals)} postal code(s)"] if postals else []) + list(args.preset))
        most = f", at most {args.max} deals" if args.max else ""
        print(f"Running yugenox/flipp-flyer-deals-scraper: every item in the flyers for {where}{most}, "
              f"cost cap ${args.max_charge:g} (about {cap} deals) ...", file=sys.stderr)
        if not args.max or args.max > cap:
            print(f"Deals past the ${args.max_charge:g} cap are not collected. Full flyers for one big-city postal code are "
                  "about 15,000 to 30,000 items: narrow with --stores, --categories or --keywords, or raise --max-charge.",
                  file=sys.stderr)
        if not args.details:
            print("Without --details, rows carry the printed price only (no sale text, unit or multi-buy split).", file=sys.stderr)
    export_deals(args, run_input, sort=False)


if __name__ == "__main__":
    main()
