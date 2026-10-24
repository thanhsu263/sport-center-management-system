"""Build every SRS figure: python scripts/srs_diagrams/build.py [name-filter] [--no-png]"""

import sys

from lib import check, save

import context
import usecase
import activity
import sequence
import classes
import erd
import erd_logical
import screens
import architecture

GROUPS = [context, usecase, activity, sequence, erd, erd_logical, architecture, classes, screens]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    export = "--no-png" not in sys.argv
    bad = 0
    for mod in GROUPS:
        built = mod.build()
        for d in built if isinstance(built, list) else [built]:
            if args and not any(a in d.name for a in args):
                continue
            fails = check(d)
            path, _ = save(d, export=export and not fails)
            status = "ok" if not fails else f"{len(fails)} problem(s)"
            print(f"{d.name}: {status}")
            for f in fails[:25]:
                print("   -", f)
            bad += bool(fails)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
