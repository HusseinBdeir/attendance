"""attlib.py — shared helpers for the Attendance kiosk build.

Auth rides the resort repo's MSAL cache (step3_lib.dataverse_token) — nothing
new is minted. Same Production env, same solution (ResortOperations), same
publisher prefix (bhf). Retry/skip markers copied from tlib / step164.
"""
import json
import os
import sys
import time

import requests

RESORT_SCRIPTS = os.path.join(os.path.expanduser("~"), "bhfirms", "resort-operations", "scripts")
sys.path.insert(0, RESORT_SCRIPTS)
from step3_lib import DATAVERSE_URL, dataverse_token, _token  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORTS = os.path.join(HERE, "exports")
os.makedirs(EXPORTS, exist_ok=True)

SOLUTION = "ResortOperations"
API = DATAVERSE_URL + "/api/data/v9.2"
ENV_ID = "82e89520-c274-e40c-a68f-085516c1bb43"
ROOT_BU = "8f376f08-2470-f111-ab0e-6045bde02ba6"
RID_ENTRY = "ca2a9c5b-b88c-f111-8077-70a8a52b6964"       # root Entry
RID_SUPERVISOR = "cf32c04d-e58c-f111-8077-70a8a52b6964"  # root Supervisor
OPS_APP = "06377d48-e88c-f111-8077-70a8a52b6964"
CR_DV = "bhf_sharedcommondataserviceforapps_ops"

SKIP_MARKERS = ["already exist", "duplicate", "is not unique", "0x80047013",
                "already has an option with value", "0x80048403"]
RETRY_MARKERS = ["was not found in the MetadataCache", "concurrency", "0x80060882",
                 "0x80071151", "0x80040303", "0x80060888", "0x80048d19",
                 "0x80044150", "Generic SQL error", "timed out"]

FAILS = []
_S = None


def session():
    global _S
    if _S is None:
        _S = requests.Session()
        _S.headers.update({"Authorization": "Bearer " + dataverse_token(),
                           "Content-Type": "application/json", "Accept": "application/json",
                           "OData-MaxVersion": "4.0", "OData-Version": "4.0",
                           "MSCRM.SolutionUniqueName": SOLUTION})
    return _S


def do(label, method, path, body=None, extra=None, quiet=False):
    S = session()
    for attempt in range(8):
        try:
            r = S.request(method, f"{API}/{path}", json=body, headers=extra or {}, timeout=300)
        except requests.RequestException as e:
            print(f"  retry {label}: {e}")
            time.sleep(min(45 * (attempt + 1), 180))
            continue
        text = r.text or ""
        if r.status_code == 429 or r.status_code >= 500 or \
                any(m.lower() in text.lower() for m in RETRY_MARKERS):
            print(f"  retry {label} ({attempt+1}): {r.status_code} {text[:120]}")
            time.sleep(min(45 * (attempt + 1), 180))
            continue
        if r.ok:
            if not quiet:
                print(f"OK   {label}")
            return r
        if any(m.lower() in text.lower() for m in SKIP_MARKERS):
            print(f"SKIP {label} (already exists)")
            return r
        FAILS.append(label)
        print(f"FAIL {label} -> {r.status_code}: {text[:300]}")
        return None
    FAILS.append(label)
    print(f"FAIL {label} (kept retrying)")
    return None


def get(path):
    r = session().get(f"{API}/{path}", timeout=120)
    r.raise_for_status()
    return r.json()


def L(text):
    return {"@odata.type": "Microsoft.Dynamics.CRM.Label",
            "LocalizedLabels": [{"@odata.type": "Microsoft.Dynamics.CRM.LocalizedLabel",
                                 "Label": text, "LanguageCode": 1033}]}


def attr_exists(ent, logical):
    r = session().get(f"{API}/EntityDefinitions(LogicalName='{ent}')/Attributes(LogicalName='{logical}')"
                      "?$select=LogicalName", timeout=60)
    return r.ok


def publish(ents, label="publish"):
    inner = "".join(f"<entity>{e}</entity>" for e in ents)
    do(label, "POST", "PublishXml",
       {"ParameterXml": f"<importexportxml><entities>{inner}</entities></importexportxml>"})


def stamp():
    return time.strftime("%Y%m%d_%H%M%S")


def save_json(name, obj):
    p = os.path.join(EXPORTS, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1)
    return p


def finish():
    if FAILS:
        print("\nFAILURES:", *FAILS, sep="\n  ")
        sys.exit(1)
    print("\nall OK")
