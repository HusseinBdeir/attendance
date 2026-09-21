"""att01 — Attendance kiosk tables (2026-09-21).

Two BU-owned tables that the tablet kiosk feeds through the API flow (att02):

  bhf_punch          "Clock Event"      one row per tap at the tablet (raw IN/OUT punch,
                                        method Face/PIN/Manual, distance, audit snapshot,
                                        tablet id, idempotent on bhf_sourceref = kiosk uuid)
  bhf_faceenrolment  "Face Enrolment"   one row per enrolment sample (128-float descriptor
                                        as JSON text, consent stamp, PIN hash, tablet id;
                                        sample 0 = PIN-only row)

bhf_attendance (the payroll exceptions register) is NOT touched: a later nightly
flow derives Lateness / Overtime / Absence from bhf_punch against the employment's
work schedule and writes them there with bhf_source = Attendance device.

Phases (idempotent, run in order, one at a time — the classifier refuses combined runs):
  --phases a   schema (both entities + columns + lookups + alternate keys)
  --phases b   owningbusinessunit IsValidForCreate/Update PUT (t04 recipe, no toggle cycle)
  --phases c   roles: root Entry + Supervisor get Read/AppendTo (Local); Supervisor also Write/Delete
  --phases d   main forms
  --phases e   views (default + Inactive; Quick Find widened)
  --phases m   IsVisibleInMobileClient=True
  --phases x   AddAppComponents to the Ops app (main form + views) — sitemap entry is a
               separate, additive step per hard rule 9 (deferred until the user picks the areas)
  --phases g   verify (read-only)
  <step31 --only bhf_punch> <step49 --only bhf_punch> (+ faceenrolment) — last-editor lookup + flow
"""
import argparse
import json
import re
import sys
import time
import uuid

from attlib import (API, CR_DV, EXPORTS, FAILS, L, OPS_APP, RID_ENTRY, RID_SUPERVISOR,
                    attr_exists, do, finish, get, publish, save_json, session, stamp)

PUNCH = "bhf_punch"
FACE = "bhf_faceenrolment"
ENTS = [PUNCH, FACE]
SETS = {PUNCH: "bhf_punchs", FACE: "bhf_faceenrolments"}
ICON = "bhf_icon_reference.svg"

SOURCE_OPTS = [("Manual", 68400000), ("Migration", 68400001), ("POS", 68400002), ("Attendance device", 68400003)]
DIR_OPTS = [("In", 68400000), ("Out", 68400001)]
METHOD_OPTS = [("Face", 68400000), ("PIN", 68400001), ("Manual", 68400002)]


def picklist(schema, label, opts, desc="", required="None", default=None):
    return {"@odata.type": "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": required},
            **({"DefaultFormValue": default} if default is not None else {}),
            "OptionSet": {"@odata.type": "Microsoft.Dynamics.CRM.OptionSetMetadata",
                          "IsGlobal": False, "OptionSetType": "Picklist",
                          "Options": [{"Value": v, "Label": L(t)} for t, v in opts]}}


def text(schema, label, maxlen, desc="", required="None"):
    return {"@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": required}, "MaxLength": maxlen, "FormatName": {"Value": "Text"}}


def memo(schema, label, maxlen, desc=""):
    return {"@odata.type": "Microsoft.Dynamics.CRM.MemoAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": "None"}, "MaxLength": maxlen}


def datetime_(schema, label, desc="", required="None", dateonly=False):
    return {"@odata.type": "Microsoft.Dynamics.CRM.DateTimeAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": required},
            "Format": "DateOnly" if dateonly else "DateAndTime",
            "DateTimeBehavior": {"Value": "TimeZoneIndependent" if dateonly else "UserLocal"}}


def decimal(schema, label, desc="", prec=3, lo=0.0, hi=10.0):
    return {"@odata.type": "Microsoft.Dynamics.CRM.DecimalAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": "None"}, "Precision": prec, "MinValue": lo, "MaxValue": hi}


def integer(schema, label, desc=""):
    return {"@odata.type": "Microsoft.Dynamics.CRM.IntegerAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": "None"}, "Format": "None", "MinValue": 0, "MaxValue": 1000000}


def image(schema, label, desc=""):
    return {"@odata.type": "Microsoft.Dynamics.CRM.ImageAttributeMetadata",
            "SchemaName": schema, "DisplayName": L(label), "Description": L(desc),
            "RequiredLevel": {"Value": "None"}, "IsPrimaryImage": True, "MaxSizeInKB": 1024, "CanStoreFullImage": True}


ENTITY = {
    PUNCH: dict(display="Clock Event", plural="Clock Events",
                desc="Raw attendance punch from the tablet kiosk (att01 2026-09-21): one row per tap — "
                     "IN or OUT, recognised by face, PIN or entered by a manager. Owned by the site's BU. "
                     "Idempotent on Source Ref (the kiosk uuid). Feeds the nightly derivation into Attendance.",
                cols=[
                    datetime_("bhf_PunchTime", "Punch Time", "When the employee tapped, as the tablet saw it (user-local).", "ApplicationRequired"),
                    datetime_("bhf_Day", "Day", "Local calendar day of the punch (tablet clock).", "ApplicationRequired", dateonly=True),
                    picklist("bhf_Direction", "Direction", DIR_OPTS, "IN or OUT (auto-toggled by the kiosk, flippable).", "ApplicationRequired"),
                    picklist("bhf_Method", "Method", METHOD_OPTS, "How the person was identified.", "ApplicationRequired"),
                    decimal("bhf_Confidence", "Match Distance", "Face-descriptor distance (lower = closer; blank for PIN / manual).", 3, 0.0, 10.0),
                    datetime_("bhf_ReceivedOn", "Received On", "When the API flow received the punch (server clock)."),
                    text("bhf_Device", "Device", 100, "Tablet name from the kiosk Settings."),
                    text("bhf_SourceRef", "Source Ref", 200, "Kiosk uuid — alternate key, makes re-sends idempotent."),
                    picklist("bhf_Source", "Source", SOURCE_OPTS, "", "ApplicationRequired", default=68400003),
                    image("bhf_Photo", "Snapshot", "Audit snapshot taken at the punch (240 px JPEG)."),
                    memo("bhf_Notes", "Notes", 4000),
                ],
                lookups=[("bhf_staffmember", "bhf_Staff", "Staff", "ApplicationRequired")],
                key=("bhf_key_punch_sourceref", ["bhf_sourceref"]),
                name_fmt="{Staff} {DIR} {yyyy-MM-dd HH:mm}"),
    FACE: dict(display="Face Enrolment", plural="Face Enrolments",
               desc="One enrolment sample per row (att01 2026-09-21): the 128-number face descriptor "
                    "captured on the tablet (JSON), consent stamp, optional PIN hash. Sample 0 = PIN-only row. "
                    "Owned by the site's BU. A replaced tablet restores from these rows.",
               cols=[
                   integer("bhf_Sample", "Sample", "1..5 = face sample number; 0 = PIN-only row."),
                   memo("bhf_Descriptor", "Descriptor", 8000, "JSON array of 128 floats (face-api.js). Never a photo."),
                   datetime_("bhf_ConsentOn", "Consent On", "When the employee agreed to face-template storage (blank for PIN-only)."),
                   text("bhf_PinHash", "PIN Hash", 64, "SHA-256 of the staff PIN (kiosk fallback); blank if no PIN."),
                   text("bhf_Device", "Device", 100, "Tablet that captured the sample."),
                   text("bhf_SourceRef", "Source Ref", 200, "Kiosk uuid — alternate key, idempotent re-sends."),
                   picklist("bhf_Source", "Source", SOURCE_OPTS, "", "ApplicationRequired", default=68400003),
                   memo("bhf_Notes", "Notes", 4000),
               ],
               lookups=[("bhf_staffmember", "bhf_Staff", "Staff", "ApplicationRequired")],
               key=("bhf_key_faceenrolment_sourceref", ["bhf_sourceref"]),
               name_fmt="{Staff} sample {n}"),
}


# ---------------- a: schema ----------------
def phase_a():
    for ent in ENTS:
        spec = ENTITY[ent]
        r = session().get(f"{API}/EntityDefinitions(LogicalName='{ent}')?$select=EntitySetName", timeout=60)
        if r.ok:
            print(f"entity {ent} exists")
        else:
            do(f"entity {ent}", "POST", "EntityDefinitions", {
                "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
                "SchemaName": ent, "DisplayName": L(spec["display"]),
                "DisplayCollectionName": L(spec["plural"]), "Description": L(spec["desc"]),
                "OwnershipType": "UserOwned", "HasActivities": False, "HasNotes": False,
                "IsAuditEnabled": {"Value": True, "CanBeChanged": True},
                "IsVisibleInMobileClient": {"Value": True, "CanBeChanged": True},
                "Attributes": [{"@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
                                "SchemaName": "bhf_Name", "IsPrimaryName": True, "MaxLength": 300,
                                "RequiredLevel": {"Value": "None"}, "DisplayName": L("Name"),
                                "Description": L(f"Supplied by the API flow: {spec['name_fmt']}"),
                                "FormatName": {"Value": "Text"}}]})
            time.sleep(20)
        for col in spec["cols"]:
            logical = col["SchemaName"].lower()
            if attr_exists(ent, logical):
                print(f"exists: {ent}.{logical}")
                continue
            do(f"col {ent}.{col['SchemaName']}", "POST", f"EntityDefinitions(LogicalName='{ent}')/Attributes", col)
        for ref, lk_schema, label, req in spec["lookups"]:
            if attr_exists(ent, lk_schema.lower()):
                print(f"exists: {ent}.{lk_schema.lower()}")
                continue
            do(f"rel {ref} -> {ent} ({lk_schema})", "POST", "RelationshipDefinitions", {
                "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
                "SchemaName": f"{ref}_{ent}_{lk_schema.split('_', 1)[1]}",
                "ReferencedEntity": ref, "ReferencingEntity": ent,
                "CascadeConfiguration": {"Assign": "NoCascade", "Delete": "Restrict", "Merge": "NoCascade",
                                         "Reparent": "NoCascade", "Share": "NoCascade", "Unshare": "NoCascade"},
                "Lookup": {"@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
                           "SchemaName": lk_schema, "DisplayName": L(label),
                           "RequiredLevel": {"Value": req}}})
        keyname, keycols = spec["key"]
        keys = get(f"EntityDefinitions(LogicalName='{ent}')/Keys?$select=SchemaName")["value"]
        if any(k["SchemaName"].lower() == keyname for k in keys):
            print(f"exists: key {keyname}")
        else:
            do(f"key {ent}.{keyname}", "POST", f"EntityDefinitions(LogicalName='{ent}')/Keys", {
                "@odata.type": "Microsoft.Dynamics.CRM.EntityKeyMetadata",
                "SchemaName": keyname, "DisplayName": L("Source Ref key"), "KeyAttributes": keycols})
    publish(ENTS, "publish (schema)")


# ---------------- b: obu flags ----------------
def phase_b():
    for ent in ENTS:
        attr_url = f"EntityDefinitions(LogicalName='{ent}')/Attributes(LogicalName='owningbusinessunit')"
        j = get(attr_url + "?$select=IsValidForCreate,IsValidForUpdate")
        print(f"{ent} obu flags: create {j['IsValidForCreate']} update {j['IsValidForUpdate']}")
        if j["IsValidForCreate"] and j["IsValidForUpdate"]:
            continue
        attr = get(attr_url)
        attr.pop("@odata.context", None)
        attr["@odata.type"] = "Microsoft.Dynamics.CRM.LookupAttributeMetadata"
        attr["IsValidForCreate"] = True
        attr["IsValidForUpdate"] = True
        r = session().put(f"{API}/{attr_url}", json=attr, headers={"MSCRM.MergeLabels": "true"}, timeout=180)
        if r.status_code >= 300:
            FAILS.append(f"{ent} obu PUT {r.status_code}: {r.text[:300]}")
            continue
    publish(ENTS, "publish (obu)")
    for ent in ENTS:   # read the flags back yourself (t50 lesson)
        j = get(f"EntityDefinitions(LogicalName='{ent}')/Attributes(LogicalName='owningbusinessunit')?$select=IsValidForCreate,IsValidForUpdate")
        print(f"{ent} obu flags now: {j['IsValidForCreate']} {j['IsValidForUpdate']}")
        if not (j["IsValidForCreate"] and j["IsValidForUpdate"]):
            FAILS.append(f"{ent} obu flags still false")


# ---------------- c: roles ----------------
WANT = {"Supervisor": ["Read", "AppendTo", "Append", "Write", "Delete"], "Entry": ["Read", "AppendTo", "Append"]}
ROLES = {"Entry": RID_ENTRY, "Supervisor": RID_SUPERVISOR}


def phase_c():
    priv = {}
    url = f"{API}/privileges?$select=name,privilegeid"
    while url:
        r = session().get(url, timeout=120)
        r.raise_for_status()
        d = r.json()
        for p in d["value"]:
            priv[p["name"]] = p["privilegeid"]
        url = d.get("@odata.nextLink")
    for role, rid in ROLES.items():
        adds = []
        for ent in ENTS:
            for op in WANT[role]:
                pid = priv.get(f"prv{op}{ent}")
                if not pid:
                    FAILS.append(f"missing privilege prv{op}{ent}")
                    continue
                adds.append({"PrivilegeId": pid, "Depth": "Local"})
        r = session().post(f"{API}/roles({rid})/Microsoft.Dynamics.CRM.AddPrivilegesRole", json={"Privileges": adds}, timeout=120)
        if r.status_code >= 300 and "already" not in r.text.lower():
            FAILS.append(f"AddPrivilegesRole {role}: {r.status_code} {r.text[:200]}")
            continue
        print(f"OK {role}: granted {len(adds)}")
    for role, rid in ROLES.items():
        for ent in ENTS:
            for op in WANT[role]:
                pid = priv.get(f"prv{op}{ent}")
                m = get(f"roleprivilegescollection?$select=privilegedepthmask&$filter=roleid eq {rid} and privilegeid eq {pid}")
                masks = [x["privilegedepthmask"] for x in m.get("value", [])]
                ok = masks == [2]
                print(f"  {role} prv{op}{ent}: mask={masks} {'OK' if ok else 'FAIL'}")
                if not ok:
                    FAILS.append(f"{role} prv{op}{ent} mask={masks}")


# ---------------- d: forms ----------------
CLASS = {"lookup": "{270BD3DB-D9AF-4782-9025-509E298DEC0A}", "text": "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}",
         "decimal": "{C3EFE0C3-0EC6-42be-8349-CBD9079DFD8E}", "memo": "{E0DECE4B-6FC8-4a8f-A065-082708572369}",
         "date": "{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}", "picklist": "{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}",
         "int": "{C6D124CA-7EDA-4a60-AEA9-7FB8D318B68F}", "image": "{5C5600E0-1D6E-4205-A272-BE80DA87FD42}"}

FORMS = {
    PUNCH: [("Event", [("Staff", "bhf_staff", "lookup"), ("Site", "owningbusinessunit", "lookup"),
                       ("Punch Time", "bhf_punchtime", "date"), ("Day", "bhf_day", "date"),
                       ("Direction", "bhf_direction", "picklist"), ("Method", "bhf_method", "picklist"),
                       ("Match Distance", "bhf_confidence", "decimal"), ("Notes", "bhf_notes", "memo")]),
            ("Audit", [("Snapshot", "bhf_photo", "image"), ("Device", "bhf_device", "text"),
                       ("Received On", "bhf_receivedon", "date"), ("Source", "bhf_source", "picklist"),
                       ("Source Ref", "bhf_sourceref", "text"), ("Name", "bhf_name", "text")])],
    FACE: [("Enrolment", [("Staff", "bhf_staff", "lookup"), ("Site", "owningbusinessunit", "lookup"),
                          ("Sample", "bhf_sample", "int"), ("Consent On", "bhf_consenton", "date"),
                          ("Device", "bhf_device", "text"), ("Notes", "bhf_notes", "memo")]),
           ("Data", [("Descriptor", "bhf_descriptor", "memo"), ("PIN Hash", "bhf_pinhash", "text"),
                     ("Source", "bhf_source", "picklist"), ("Source Ref", "bhf_sourceref", "text"), ("Name", "bhf_name", "text")])],
}
LOCKED = {"bhf_confidence", "bhf_device", "bhf_receivedon", "bhf_source", "bhf_sourceref", "bhf_name", "bhf_descriptor", "bhf_pinhash", "bhf_sample"}


def phase_d():
    g = lambda: "{%s}" % uuid.uuid4()

    def cell(label, field, kind):
        dis = ' disabled="true"' if field in LOCKED else ""
        extra = ' rowspan="6"' if kind == "image" else ""
        return (f'<row><cell id="{g()}"{extra}><labels><label description="{label}" languagecode="1033" /></labels>'
                f'<control id="{field}" classid="{CLASS[kind]}" datafieldname="{field}"{dis} /></cell></row>')

    def section(title, fields):
        return (f'<section showlabel="true" showbar="false" id="{g()}" IsUserDefined="1" columns="1">'
                f'<labels><label description="{title}" languagecode="1033" /></labels>'
                f'<rows>{"".join(cell(*f) for f in fields)}</rows></section>')

    for ent in ENTS:
        xml = (f'<form><tabs><tab verticallayout="true" id="{g()}" IsUserDefined="1">'
               f'<labels><label description="General" languagecode="1033" /></labels><columns><column width="100%"><sections>'
               + "".join(section(t, f) for t, f in FORMS[ent])
               + '</sections></column></columns></tab></tabs></form>')
        forms = get(f"systemforms?$filter=objecttypecode eq '{ent}' and type eq 2&$select=formid,name,formxml")["value"]
        assert forms, f"no main form for {ent}"
        fid = forms[0]["formid"]
        save_json(f"att01_form_backup_{ent}_{stamp()}.json", forms[0])
        r = session().patch(f"{API}/systemforms({fid})", json={"formxml": xml}, timeout=120)
        if r.status_code >= 300:
            FAILS.append(f"form PATCH {ent}: {r.status_code} {r.text[:300]}")
            continue
        print(f"OK form {ent} {fid}")
    publish(ENTS, "publish (forms)")


# ---------------- e: views ----------------
VIEW_COLS = {
    PUNCH: [("bhf_name", 220), ("bhf_staff", 160), ("bhf_punchtime", 140), ("bhf_direction", 80), ("bhf_method", 90),
            ("bhf_confidence", 90), ("owningbusinessunit", 120), ("bhf_device", 140), ("bhf_lasteditedon", 130)],
    FACE: [("bhf_name", 220), ("bhf_staff", 160), ("bhf_sample", 80), ("bhf_consenton", 140),
           ("owningbusinessunit", 120), ("bhf_device", 140), ("createdon", 130)],
}
ORDER = {PUNCH: "bhf_punchtime", FACE: "createdon"}


def phase_e():
    for ent in ENTS:
        have = {a["LogicalName"] for a in get(f"EntityDefinitions(LogicalName='{ent}')/Attributes?$select=LogicalName")["value"]}
        cols = [(c, w) for c, w in VIEW_COLS[ent] if c in have]
        otc = get(f"EntityDefinitions(LogicalName='{ent}')?$select=ObjectTypeCode")["ObjectTypeCode"]
        attrs = "".join(f'<attribute name="{c}" />' for c, _ in cols)
        layout = (f'<grid name="resultset" object="{otc}" jump="bhf_name" select="1" icon="1" preview="1">'
                  f'<row name="result" id="{ent}id">{"".join(f"<cell name=\"{c}\" width=\"{w}\" />" for c, w in cols)}</row></grid>')

        def fetch(state):
            return (f'<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">'
                    f'<entity name="{ent}"><attribute name="{ent}id" />{attrs}<order attribute="{ORDER[ent]}" descending="true" />'
                    f'<filter type="and"><condition attribute="statecode" operator="eq" value="{state}" /></filter></entity></fetch>')
        views = get(f"savedqueries?$filter=returnedtypecode eq '{ent}' and querytype eq 0&$select=savedqueryid,name,fetchxml,layoutxml")["value"]
        save_json(f"att01_view_backup_{ent}_{stamp()}.json", views)
        for v in views:
            state = 1 if "inactive" in v["name"].lower() else 0
            do(f"view {ent}: {v['name']}", "PATCH", f"savedqueries({v['savedqueryid']})", {"fetchxml": fetch(state), "layoutxml": layout})
        # Quick Find: search name + staff name
        qf = get(f"savedqueries?$filter=returnedtypecode eq '{ent}' and querytype eq 4&$select=savedqueryid,name,fetchxml")["value"]
        for v in qf:
            fx = (f'<fetch version="1.0" output-format="xml-platform" mapping="logical"><entity name="{ent}">'
                  f'<attribute name="{ent}id" />{attrs}<order attribute="{ORDER[ent]}" descending="true" />'
                  f'<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>'
                  f'<filter type="or" isquickfindfields="1"><condition attribute="bhf_name" operator="like" value="{{0}}" />'
                  f'<condition attribute="bhf_device" operator="like" value="{{0}}" /></filter></entity></fetch>')
            do(f"quickfind {ent}", "PATCH", f"savedqueries({v['savedqueryid']})", {"fetchxml": fx, "layoutxml": layout})
    publish(ENTS, "publish (views)")


# ---------------- m: mobile ----------------
def phase_m():
    for ent in ENTS:
        e = get(f"EntityDefinitions(LogicalName='{ent}')")
        if e["IsVisibleInMobileClient"]["Value"] and not e["IsReadOnlyInMobileClient"]["Value"] and e.get("IconVectorName") == ICON:
            print(f"{ent}: mobile + icon already set")
            continue
        e["IsVisibleInMobileClient"]["Value"] = True
        e["IsReadOnlyInMobileClient"]["Value"] = False
        e["IconVectorName"] = ICON
        r = session().put(f"{API}/EntityDefinitions(LogicalName='{ent}')", json=e, headers={"MSCRM.MergeLabels": "true"}, timeout=180)
        if r.status_code >= 300:
            FAILS.append(f"{ent} mobile PUT {r.status_code}: {r.text[:200]}")
    publish(ENTS, "publish (mobile)")


# ---------------- x: app components ----------------
def phase_x():
    comps = []
    for ent in ENTS:
        for f in get(f"systemforms?$filter=objecttypecode eq '{ent}' and (type eq 2 or type eq 5)&$select=formid")["value"]:
            comps.append({"@odata.type": "Microsoft.Dynamics.CRM.systemform", "formid": f["formid"]})
        for v in get(f"savedqueries?$filter=returnedtypecode eq '{ent}' and querytype eq 0&$select=savedqueryid")["value"]:
            comps.append({"@odata.type": "Microsoft.Dynamics.CRM.savedquery", "savedqueryid": v["savedqueryid"]})
    do("AddAppComponents (Ops app)", "POST", "AddAppComponents", {"AppId": OPS_APP, "Components": comps})
    do("publish app", "POST", f"appmodules({OPS_APP})/Microsoft.Dynamics.CRM.PublishAppModule")  # harmless if not needed


# ---------------- g: verify ----------------
def phase_g():
    for ent in ENTS:
        d = get(f"EntityDefinitions(LogicalName='{ent}')?$select=LogicalName,EntitySetName,IsVisibleInMobileClient,IconVectorName"
                "&$expand=Attributes($select=LogicalName),Keys($select=SchemaName)")
        have = {a["LogicalName"] for a in d["Attributes"]}
        want = [c["SchemaName"].lower() for c in ENTITY[ent]["cols"]] + [lk[1].lower() for lk in ENTITY[ent]["lookups"]]
        missing = [w for w in want if w not in have]
        obu = get(f"EntityDefinitions(LogicalName='{ent}')/Attributes(LogicalName='owningbusinessunit')?$select=IsValidForCreate,IsValidForUpdate")
        print(f"{ent}: set={d['EntitySetName']} keys={[k['SchemaName'] for k in d['Keys']]} mobile={d['IsVisibleInMobileClient']['Value']} "
              f"icon={d.get('IconVectorName')} obu={obu['IsValidForCreate']}/{obu['IsValidForUpdate']} "
              f"lasteditor={'bhf_lasteditedby' in have}/{'bhf_lasteditedon' in have} missing={missing or 'NONE'}")
        if missing:
            FAILS.append(f"{ent} missing {missing}")
        n = get(f"{SETS[ent]}?$select={ent}id&$top=1&$count=true").get("@odata.count")
        print(f"  rows: {n}")


PHASES = {"a": phase_a, "b": phase_b, "c": phase_c, "d": phase_d, "e": phase_e, "m": phase_m, "x": phase_x, "g": phase_g}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--phases", default="g")
    a = ap.parse_args()
    for ph in a.phases:
        print(f"\n===== phase {ph} =====")
        PHASES[ph]()
    finish()
