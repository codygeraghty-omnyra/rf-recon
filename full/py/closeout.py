"""
Carrier closeout package (Cody 11/6: a Report section, one card per carrier, one zip per carrier).

No US carrier publishes an in-building closeout spec (the DAS course, lesson 7.11, searched 2 and 5 Nov 2026). The items
follow the fullest public list, Australia's MCF Design Guidelines 2025, with owner specs and Viavi; each carrier's own items
are added by hand when the carrier sends its spec. The page (static/dascloseout.js) builds the index from the job's own
records; this packs it with the job's files the page names, each in its item's folder, and the bill of materials. It only
reads: nothing on the job changes.
"""
import csv
import io
import os
import re
import zipfile

import das

FOLDERS = {"asbuilt": "As-builts", "bom": "Bill of materials", "sweep": "Sweeps", "pim": "PIM", "fiber": "Fiber",
           "power": "Power levels", "walk": "Walk plots", "commission": "Commissioning", "calls": "Call test and KPIs",
           "alarm": "Alarm test", "photos": "Photos", "settings": "Equipment settings", "consent": "Consent",
           "contacts": "Contacts and access", "own": "Carrier's own items"}
MAX_INDEX = 2_000_000   # the index page the browser built
MAX_FILES = 2000        # file names named across every item


def carrier_name(s):
    """A carrier's name as it can sit in a file name."""
    return re.sub(r"[^\w .,()&+-]+", "_", str(s or ""))[:80].strip(" ._") or "Carrier"


def zip_for(jid, job, body):
    """(zip bytes, file name) for one carrier. body: {carrier, index_html, files: {item: [names in the job's folder]}}.
    A name that isn't a file of this job's (or tries to leave its folder) is skipped."""
    body = body if isinstance(body, dict) else {}
    carrier = carrier_name(body.get("carrier"))
    index = str(body.get("index_html") or "")
    if len(index) > MAX_INDEX:
        raise ValueError("The closeout index is larger than 2 MB.")
    files = body.get("files") if isinstance(body.get("files"), dict) else {}
    out, seen, n = io.BytesIO(), set(), 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{carrier} closeout index.html", index)
        rows, total = das.bom_rows((job.get("data") or {}).get("bom") or [])
        if rows:
            buf = io.StringIO()
            w = csv.DictWriter(buf, fieldnames=das.BOM_FIELDS)
            w.writeheader()
            w.writerows(rows)
            z.writestr("Bill of materials/Bill of materials.csv", "﻿" + buf.getvalue())
        for item, names in files.items():
            folder = FOLDERS.get(item)
            if not folder or not isinstance(names, list):
                continue
            for name in names:
                n += 1
                if n > MAX_FILES:
                    break
                try:
                    fp = das.file_path(jid, job["name"], str(name))
                except ValueError:
                    continue
                key = (folder, os.path.basename(fp))
                if os.path.isfile(fp) and key not in seen:
                    seen.add(key)
                    z.write(fp, f"{folder}/{os.path.basename(fp)}")
    return out.getvalue(), f"{job['name']} - {carrier} closeout.zip"
