"""att02 — "Ops - Attendance kiosk API" flow (2026-09-21).

One HTTP-triggered, solution-aware flow that the tablet kiosk talks to. The
trigger URL carries its own SAS signature AND the body carries a shared key
(exports/att02_key.txt, generated once here, entered on the tablet). No
Dataverse token ever sits on a gate device.

Body (always): {key, op, site, siteBu, device, version, ...}
  op = "roster"  {restore: bool}            -> {ok, staff:[{id,name,officialName}], faces:[...], serverTime}
                 staff = active employments of the site BU (end date blank or future), expanded to staffmember
  op = "sync"    {punches:[...], faces:[...]} -> {ok, punches:[ids], faces:[ids], serverTime}
                 upsert on bhf_sourceref (= kiosk uuid): existing punch -> direction/notes updated,
                 existing enrolment -> descriptor/pinhash updated; new rows created BU-owned;
                 snapshot written to the image column in a second step whose failure is absorbed.

Phases (one at a time):
  --phases p   write exports/att02_flow_payload.json (create the skeleton via MCP create_record workflow)
  --phases d   PATCH clientdata on the existing flow + activate (step204 recipe)
  --phases u   fetch the trigger callback URL (flow API, silent token) -> exports/att02_callback_url.txt
  --phases t   e2e: roster for La Una + one sync with a test punch/enrolment against a real staff id,
               verify rows, then delete the two test rows (single-record deletes)
"""
import argparse
import json
import os
import secrets
import time
import uuid

import requests

from attlib import (API, CR_DV, ENV_ID, EXPORTS, FAILS, _token, do, finish, get, session, stamp)

FLOW_NAME = "Ops - Attendance kiosk API"
KEY_FILE = os.path.join(EXPORTS, "att02_key.txt")
URL_FILE = os.path.join(EXPORTS, "att02_callback_url.txt")
DV = {"apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
      "connectionName": "shared_commondataserviceforapps"}
SRC_DEVICE = 68400003
DIR = "if(equals(toLower(string(%s?['direction'])), 'out'), 68400001, 68400000)"
METHOD = "if(equals(%s?['method'], 'pin'), 68400001, if(equals(%s?['method'], 'manual'), 68400002, 68400000))"


def api_key():
    if os.path.exists(KEY_FILE):
        return open(KEY_FILE, encoding="utf-8").read().strip()
    k = secrets.token_hex(24)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(k)
    return k


def act(op, params, run_after=None, extra=None):
    a = {"type": "OpenApiConnection", "runAfter": run_after or {},
         "inputs": {"host": dict(DV, operationId=op), "parameters": params, "authentication": "@parameters('$authentication')"}}
    if extra:
        a.update(extra)
    return a


def response(name_status, body, run_after=None):
    return {"type": "Response", "kind": "Http", "runAfter": run_after or {},
            "inputs": {"statusCode": name_status, "headers": {"Content-Type": "application/json"}, "body": body}}


def clientdata(key):
    P = "items('Foreach_Punch')"
    F = "items('Foreach_Face')"
    local_ts = f"addMinutes({P}?['ts'], int(coalesce({P}?['tzOffsetMin'], 0)))"
    punch_name = f"@concat({P}?['staffName'], ' ', toUpper(string({P}?['direction'])), ' ', formatDateTime({local_ts}, 'yyyy-MM-dd HH:mm'))"
    face_name = f"@concat({F}?['staffName'], ' sample ', string({F}?['sample']))"
    bu_bind = "@concat('businessunits(', outputs('BU_Id'), ')')"

    create_punch = {
        "entityName": "bhf_punchs",
        "item/bhf_name": punch_name,
        "item/bhf_Staff@odata.bind": f"@concat('bhf_staffmembers(', {P}?['staffId'], ')')",
        "item/owningbusinessunit@odata.bind": bu_bind,
        "item/bhf_punchtime": f"@{P}?['ts']",
        "item/bhf_day": f"@formatDateTime({local_ts}, 'yyyy-MM-dd')",
        "item/bhf_direction": "@" + DIR % P,
        "item/bhf_method": "@" + METHOD % (P, P),
        "item/bhf_confidence": f"@if(equals({P}?['confidence'], null), null, float({P}?['confidence']))",
        "item/bhf_receivedon": "@utcNow()",
        "item/bhf_device": "@triggerBody()?['device']",
        "item/bhf_sourceref": f"@{P}?['id']",
        "item/bhf_source": SRC_DEVICE,
        "item/bhf_notes": f"@{P}?['note']",
    }
    update_punch = {
        "entityName": "bhf_punchs",
        "recordId": "@first(outputs('Find_Punch')?['body/value'])?['bhf_punchid']",
        "item/bhf_direction": "@" + DIR % P,
        "item/bhf_name": punch_name,
        "item/bhf_notes": f"@{P}?['note']",
    }
    create_face = {
        "entityName": "bhf_faceenrolments",
        "item/bhf_name": face_name,
        "item/bhf_Staff@odata.bind": f"@concat('bhf_staffmembers(', {F}?['staffId'], ')')",
        "item/owningbusinessunit@odata.bind": bu_bind,
        "item/bhf_sample": f"@int({F}?['sample'])",
        "item/bhf_descriptor": f"@string(coalesce({F}?['descriptor'], json('[]')))",
        "item/bhf_consenton": f"@if(empty({F}?['consentAt']), null, {F}?['consentAt'])",
        "item/bhf_pinhash": f"@{F}?['pinhash']",
        "item/bhf_device": "@triggerBody()?['device']",
        "item/bhf_sourceref": f"@{F}?['id']",
        "item/bhf_source": SRC_DEVICE,
    }
    update_face = {
        "entityName": "bhf_faceenrolments",
        "recordId": "@first(outputs('Find_Face')?['body/value'])?['bhf_faceenrolmentid']",
        "item/bhf_descriptor": f"@string(coalesce({F}?['descriptor'], json('[]')))",
        "item/bhf_pinhash": f"@{F}?['pinhash']",
    }

    definition = {
        "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
        "contentVersion": "1.0.0.0",
        "parameters": {"$connections": {"defaultValue": {}, "type": "Object"},
                       "$authentication": {"defaultValue": {}, "type": "SecureObject"}},
        "triggers": {"manual": {"type": "Request", "kind": "Http",
                                "inputs": {"schema": {"type": "object", "properties": {
                                    "key": {"type": "string"}, "op": {"type": "string"}, "site": {"type": "string"},
                                    "siteBu": {"type": "string"}, "device": {"type": "string"}, "version": {"type": "string"},
                                    "restore": {"type": "boolean"}, "punches": {"type": "array"}, "faces": {"type": "array"}}}}}},
        "actions": {
            "Bad_Key": {
                "type": "If", "runAfter": {},
                "expression": {"not": {"equals": ["@triggerBody()?['key']", key]}},
                "actions": {
                    "Response_401": response(401, {"ok": False, "error": "bad key"}),
                    "Stop": {"type": "Terminate", "runAfter": {"Response_401": ["Succeeded"]}, "inputs": {"runStatus": "Cancelled"}}},
                "else": {"actions": {}}},
            "Find_BU": act("ListRecords", {"entityName": "businessunits", "$select": "businessunitid,name",
                                           "$filter": "@concat('name eq ''', triggerBody()?['siteBu'], '''')", "$top": 1},
                           {"Bad_Key": ["Succeeded"]}),
            "BU_Id": {"type": "Compose", "runAfter": {"Find_BU": ["Succeeded"]},
                      "inputs": "@first(outputs('Find_BU')?['body/value'])?['businessunitid']"},
            "No_BU": {
                "type": "If", "runAfter": {"BU_Id": ["Succeeded"]},
                "expression": {"equals": ["@outputs('BU_Id')", None]},
                "actions": {
                    "Response_400_BU": response(400, {"ok": False, "error": "unknown site"}),
                    "Stop_BU": {"type": "Terminate", "runAfter": {"Response_400_BU": ["Succeeded"]}, "inputs": {"runStatus": "Cancelled"}}},
                "else": {"actions": {}}},
            "Switch_Op": {
                "type": "Switch", "runAfter": {"No_BU": ["Succeeded"]},
                "expression": "@triggerBody()?['op']",
                "cases": {
                    "roster": {"case": "roster", "actions": {
                        "List_Employments": act("ListRecords", {
                            "entityName": "bhf_employments",
                            "$select": "bhf_employmentid,bhf_enddate",
                            "$filter": "@concat('_owningbusinessunit_value eq ', outputs('BU_Id'), ' and statecode eq 0 and (bhf_enddate eq null or bhf_enddate ge ', formatDateTime(utcNow(), 'yyyy-MM-dd'), ')')",
                            "$expand": "bhf_Staff($select=bhf_staffmemberid,bhf_name,bhf_officialname,bhf_status)",
                            "$top": 500}),
                        "Select_Staff": {"type": "Select", "runAfter": {"List_Employments": ["Succeeded"]},
                                         "inputs": {"from": "@outputs('List_Employments')?['body/value']",
                                                    "select": {"id": "@item()?['bhf_Staff']?['bhf_staffmemberid']",
                                                               "name": "@item()?['bhf_Staff']?['bhf_name']",
                                                               "officialName": "@item()?['bhf_Staff']?['bhf_officialname']"}}},
                        "List_Faces": act("ListRecords", {
                            "entityName": "bhf_faceenrolments",
                            "$select": "bhf_faceenrolmentid,bhf_sourceref,_bhf_staff_value,bhf_sample,bhf_descriptor,bhf_consenton,bhf_pinhash,createdon",
                            "$filter": "@concat('_owningbusinessunit_value eq ', outputs('BU_Id'), ' and statecode eq 0')",
                            "$top": "@if(equals(triggerBody()?['restore'], true), 5000, 1)"},
                            {"Select_Staff": ["Succeeded"]}),
                        "Select_Faces": {"type": "Select", "runAfter": {"List_Faces": ["Succeeded"]},
                                         "inputs": {"from": "@outputs('List_Faces')?['body/value']",
                                                    "select": {"id": "@item()?['bhf_sourceref']", "staffId": "@item()?['_bhf_staff_value']",
                                                               "sample": "@item()?['bhf_sample']",
                                                               "descriptor": "@json(coalesce(item()?['bhf_descriptor'], '[]'))",
                                                               "consentAt": "@item()?['bhf_consenton']", "pinhash": "@item()?['bhf_pinhash']",
                                                               "ts": "@item()?['createdon']"}}},
                        "Response_Roster": response(200, {
                            "ok": True, "site": "@triggerBody()?['siteBu']", "bu": "@outputs('BU_Id')",
                            "staff": "@body('Select_Staff')",
                            "faces": "@if(equals(triggerBody()?['restore'], true), body('Select_Faces'), json('[]'))",
                            "serverTime": "@utcNow()"}, {"Select_Faces": ["Succeeded"]})}},
                    "sync": {"case": "sync", "actions": {
                        "Foreach_Punch": {
                            "type": "Foreach", "runAfter": {},
                            "foreach": "@coalesce(triggerBody()?['punches'], json('[]'))",
                            "runtimeConfiguration": {"concurrency": {"repetitions": 1}},
                            "actions": {
                                "Find_Punch": act("ListRecords", {"entityName": "bhf_punchs", "$select": "bhf_punchid",
                                                                  "$filter": f"@concat('bhf_sourceref eq ''', {P}?['id'], '''')", "$top": 1}),
                                "If_Punch_Exists": {
                                    "type": "If", "runAfter": {"Find_Punch": ["Succeeded"]},
                                    "expression": {"greater": ["@length(outputs('Find_Punch')?['body/value'])", 0]},
                                    "actions": {"Update_Punch": act("UpdateRecord", update_punch)},
                                    "else": {"actions": {
                                        "Create_Punch": act("CreateRecord", create_punch),
                                        "If_Snapshot": {
                                            "type": "If", "runAfter": {"Create_Punch": ["Succeeded"]},
                                            "expression": {"greater": [f"@length(coalesce({P}?['snapshot'], ''))", 100]},
                                            "actions": {
                                                "Set_Photo": act("UpdateRecord", {
                                                    "entityName": "bhf_punchs",
                                                    "recordId": "@outputs('Create_Punch')?['body/bhf_punchid']",
                                                    "item/bhf_photo": f"@replace({P}?['snapshot'], 'data:image/jpeg;base64,', '')"}),
                                                "Photo_Failed": {"type": "Compose", "runAfter": {"Set_Photo": ["Failed", "TimedOut"]},
                                                                 "inputs": "@string(actions('Set_Photo')?['error'])"}},
                                            "else": {"actions": {}}}}}}}},
                        "Foreach_Face": {
                            "type": "Foreach", "runAfter": {"Foreach_Punch": ["Succeeded"]},
                            "foreach": "@coalesce(triggerBody()?['faces'], json('[]'))",
                            "runtimeConfiguration": {"concurrency": {"repetitions": 1}},
                            "actions": {
                                "Find_Face": act("ListRecords", {"entityName": "bhf_faceenrolments", "$select": "bhf_faceenrolmentid",
                                                                 "$filter": f"@concat('bhf_sourceref eq ''', {F}?['id'], '''')", "$top": 1}),
                                "If_Face_Exists": {
                                    "type": "If", "runAfter": {"Find_Face": ["Succeeded"]},
                                    "expression": {"greater": ["@length(outputs('Find_Face')?['body/value'])", 0]},
                                    "actions": {"Update_Face": act("UpdateRecord", update_face)},
                                    "else": {"actions": {"Create_Face": act("CreateRecord", create_face)}}}}},
                        "Select_PunchIds": {"type": "Select", "runAfter": {"Foreach_Face": ["Succeeded"]},
                                            "inputs": {"from": "@coalesce(triggerBody()?['punches'], json('[]'))", "select": "@item()?['id']"}},
                        "Select_FaceIds": {"type": "Select", "runAfter": {"Select_PunchIds": ["Succeeded"]},
                                           "inputs": {"from": "@coalesce(triggerBody()?['faces'], json('[]'))", "select": "@item()?['id']"}},
                        "Response_Sync": response(200, {"ok": True, "punches": "@body('Select_PunchIds')", "faces": "@body('Select_FaceIds')",
                                                        "serverTime": "@utcNow()"}, {"Select_FaceIds": ["Succeeded"]})}}},
                "default": {"actions": {"Response_400_Op": response(400, {"ok": False, "error": "bad op"})}}},
        },
        "outputs": {}}
    return {"properties": {
        "connectionReferences": {"shared_commondataserviceforapps": {
            "runtimeSource": "embedded", "connection": {"connectionReferenceLogicalName": CR_DV},
            "api": {"name": "shared_commondataserviceforapps"}}},
        "definition": definition},
        "schemaVersion": "1.0.0.0"}


def find_flow():
    return get(f"workflows?$select=workflowid,statecode,resourceid,workflowidunique,clientdata&$filter=category eq 5 and name eq '{FLOW_NAME}'")["value"]


def phase_p():
    key = api_key()
    payload = {"name": FLOW_NAME, "category": 5, "type": 1, "primaryentity": "none",
               "description": "att02 (2026-09-21): HTTP API for the attendance tablet kiosk — roster pull + punch/enrolment upsert (bhf_punch / bhf_faceenrolment).",
               "clientdata": json.dumps(clientdata(key))}
    p = os.path.join(EXPORTS, "att02_flow_payload.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=1)
    ex = find_flow()
    print("flow exists:", [w["workflowid"] for w in ex] or "NO", "-> payload", p)
    print("api key ->", KEY_FILE)


def phase_d():
    ex = find_flow()
    if not ex:
        FAILS.append("flow missing — create the skeleton via MCP create_record(workflow) first (name, category 5, type 1, primaryentity none, minimal clientdata)")
        return
    w = ex[0]
    cd = clientdata(api_key())
    cur = json.loads(w["clientdata"] or "{}")
    if cur.get("properties", {}).get("definition") != cd["properties"]["definition"]:
        with open(os.path.join(EXPORTS, f"att02_flow_backup_{stamp()}.json"), "w", encoding="utf-8") as f:
            f.write(w["clientdata"] or "")
        if w["statecode"] == 1:
            do("deactivate", "PATCH", f"workflows({w['workflowid']})", {"statecode": 0, "statuscode": 1})
        if do("clientdata", "PATCH", f"workflows({w['workflowid']})", {"clientdata": json.dumps(cd)}) is None:
            return
        w["statecode"] = 0
    else:
        print("definition unchanged")
    if w["statecode"] != 1:
        r = do("activate", "PATCH", f"workflows({w['workflowid']})", {"statecode": 1, "statuscode": 2})
        if r is None:
            return
    else:
        print("already active")
    print("flow id:", w["workflowid"], "resourceid:", w.get("resourceid"))


def phase_u():
    ex = find_flow()
    assert ex, "flow missing"
    w = ex[0]
    tok = _token(["https://service.flow.microsoft.com/.default"])
    H = {"Authorization": "Bearer " + tok, "Content-Type": "application/json"}
    for fid in (w.get("resourceid"), w.get("workflowidunique"), w["workflowid"]):
        if not fid:
            continue
        url = (f"https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/{ENV_ID}"
               f"/flows/{fid}/triggers/manual/listCallbackUrl?api-version=2016-11-01")
        r = requests.post(url, headers=H, timeout=60)
        print(f"listCallbackUrl via {fid}: {r.status_code}")
        if r.ok:
            cb = r.json()["response"]["value"]
            with open(URL_FILE, "w", encoding="utf-8") as f:
                f.write(cb)
            print("callback URL ->", URL_FILE)
            return
        print("  ", r.text[:300])
    FAILS.append("could not fetch the callback URL — copy it from the flow's HTTP trigger in make.powerautomate.com into exports/att02_callback_url.txt")


def phase_t():
    key = api_key()
    url = open(URL_FILE, encoding="utf-8").read().strip()
    base = {"key": key, "site": "LAUNA", "siteBu": "La Una", "device": "att02-e2e", "version": "0.1.0"}
    r = requests.post(url, json=dict(base, op="roster", restore=False), timeout=120)
    print("roster:", r.status_code, r.text[:300])
    assert r.ok and r.json().get("ok"), "roster failed"
    staff = r.json()["staff"]
    print(f"  {len(staff)} staff for La Una; first: {staff[:2]}")
    assert staff, "empty roster"
    sid = staff[0]["id"]
    pid, fid = str(uuid.uuid4()), str(uuid.uuid4())
    ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    # 1x1 white JPEG (smallest valid) so the image path is exercised
    snap = ("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==")
    body = dict(base, op="sync",
                punches=[{"id": pid, "staffId": sid, "staffName": staff[0]["name"], "ts": ts, "tzOffsetMin": 180,
                          "direction": "in", "method": "face", "confidence": 0.321, "snapshot": snap, "note": "att02 e2e"}],
                faces=[{"id": fid, "staffId": sid, "staffName": staff[0]["name"], "sample": 1, "descriptor": [0.01] * 128,
                        "consentAt": ts, "pinhash": "a" * 64, "ts": ts}])
    r = requests.post(url, json=body, timeout=300)
    print("sync:", r.status_code, r.text[:300])
    assert r.ok and r.json().get("ok") and pid in r.json()["punches"] and fid in r.json()["faces"], "sync failed"
    # second send = upsert, must not duplicate
    body["punches"][0]["direction"] = "out"
    r = requests.post(url, json=body, timeout=300)
    print("re-sync:", r.status_code, r.text[:200])
    time.sleep(3)
    P = get(f"bhf_punchs?$select=bhf_punchid,bhf_name,bhf_direction,bhf_method,bhf_confidence,bhf_day,_owningbusinessunit_value,bhf_device,bhf_photo&$filter=bhf_sourceref eq '{pid}'")["value"]
    Fc = get(f"bhf_faceenrolments?$select=bhf_faceenrolmentid,bhf_name,bhf_sample,bhf_pinhash,_owningbusinessunit_value&$filter=bhf_sourceref eq '{fid}'")["value"]
    print("punch rows:", len(P), json.dumps([{k: (v if k != 'bhf_photo' else (len(v or '') and 'photo ok')) for k, v in p.items() if not k.startswith('@')} for p in P]))
    print("face rows:", len(Fc), json.dumps([{k: v for k, v in f.items() if not k.startswith('@')} for f in Fc]))
    ok = len(P) == 1 and P[0]["bhf_direction"] == 68400001 and P[0]["bhf_method"] == 68400000 and len(Fc) == 1
    if not ok:
        FAILS.append("e2e verify")
    if P[0].get("bhf_photo") is None:
        print("  WARNING: snapshot did not land in the image column (Set_Photo absorbed) — check the run in the maker portal")
    for p in P:
        do("delete e2e punch", "DELETE", f"bhf_punchs({p['bhf_punchid']})")
    for f in Fc:
        do("delete e2e enrolment", "DELETE", f"bhf_faceenrolments({f['bhf_faceenrolmentid']})")


PHASES = {"p": phase_p, "d": phase_d, "u": phase_u, "t": phase_t}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="p")
    a = ap.parse_args()
    for ph in a.phases:
        print(f"\n===== phase {ph} =====")
        PHASES[ph]()
    finish()
