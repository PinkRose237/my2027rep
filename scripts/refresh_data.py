"""Refresh the static site's congressional roster and explicitly called results."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import html
import json
from pathlib import Path
import re
import time
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "congress.json"
CIVIC_API = "https://civicapi.org/api/v2/race"
LEGISLATORS = "https://unitedstates.github.io/congress-legislators/legislators-current.json"
HOUSE_CLERK = "https://clerk.house.gov/xml/lists/MemberData.xml"
SENATE_DIRECTORY = "https://www.senate.gov/general/contact_information/senators_cfm.xml"
VOTER_GUIDE = "https://votewiser.com"
START = datetime.fromisoformat("2027-01-03T12:00:00-05:00")
AT_LARGE = {"AK", "DE", "ND", "SD", "VT", "WY", "AS", "DC", "GU", "MP", "PR", "VI"}
DELEGATE_SOURCE = "https://pasquines.us/2026-elections/"
DELEGATES = {
    "AS": ("Aumua Amata Coleman Radewagen", "Republican", DELEGATE_SOURCE, None),
    "DC": ("Robert White", "Democratic", "https://www.fox5dc.com/election-results",
           "https://www.joinrobertwhite.com/"),
    "GU": ("Alicia Limtiaco", "Democratic", DELEGATE_SOURCE, "https://aliciaforcongress.com/"),
    "MP": ("Kimberlyn King-Hinds", "Republican", DELEGATE_SOURCE, None),
    "VI": ("Janelle Sarauw", "Democratic", DELEGATE_SOURCE, "https://sarauwforcongress.com/"),
}
CAMPAIGN_LINKS = {
    ("AL-2", "Barry Moore"): "https://barrymooreforalabama.com/",
    ("KY-2", "Andy Barr"): "https://barrforsenate.com/",
    ("LA-2", "Julia Letlow"): "https://www.julialetlow.com/",
    ("NH-2", "Chris Pappas"): "https://chrispappas.org/",
    ("OK-2", "Kevin Hern"): "https://hernforsenate.com/",
    ("WY-2", "Harriet Hageman"): "https://www.hagemanforwyoming.com/",
    ("CA-38", "Hilda Solis"): "https://www.hildasolis.com/",
    ("GA-13", "Jasmine Clark"): "https://www.jasmine4ga.com/",
    ("MO-02", "Fred Wellman"): "https://www.wellmanformo.com/",
    ("NY-18", "Pat Ryan"): "https://www.patryanforcongress.com/",
    ("TX-30", "Frederick Haynes III"): "https://www.haynesforcongress.com/",
}
PARTIES = {"D": "Democratic", "Democrat": "Democratic", "R": "Republican", "I": "Independent"}
BUILDINGS = {
    "CHOB": "Cannon House Office Building",
    "LHOB": "Longworth House Office Building",
    "RHOB": "Rayburn House Office Building",
}


def fetch(url):
    request = Request(url, headers={"User-Agent": "TheNextCongress/1.0 (public civic data lookup)"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                return response.read()
        except HTTPError as error:
            if error.code < 500 and error.code != 429:
                raise
            if attempt == 2:
                raise
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(2 ** attempt)


def get_json(url):
    return json.loads(fetch(url))


def http_url(url):
    if isinstance(url, str) and urlparse(url).scheme == "https" and urlparse(url).hostname:
        return url
    if isinstance(url, str) and url.startswith("http://"):
        return http_url("https://" + url.removeprefix("http://"))
    return None


def compact(record):
    return {key: value for key, value in record.items() if value is not None and value != ""}


def house_key(state, district):
    return f"{state}-{0 if state in AT_LARGE else int(district):02d}"


def get_roster(legislators, house_xml, senate_xml):
    terms = {p["id"]["bioguide"]: (p["name"], p["terms"][-1]) for p in legislators}
    house = {}
    for member in house_xml.findall("./members/member"):
        code = member.findtext("statedistrict")
        info = member.find("member-info")
        if not code or info is None:
            continue
        state = {"AQ": "AS"}.get(code[:2], code[:2])
        key = house_key(state, code[2:])
        bio = info.findtext("bioguideID")
        name, term = terms.get(bio, ({}, {}))
        building = BUILDINGS.get(info.findtext("office-building"))
        room = info.findtext("office-room")
        address = f"{room} {building}, Washington, DC 20515" if room and building else None
        house[key] = compact({
            "id": bio, "name": info.findtext("official-name"),
            "alias": " ".join(part for part in (name.get("first"), name.get("last")) if part),
            "party": PARTIES.get(info.findtext("party"), term.get("party")),
            "website": http_url(term.get("url")),
            "contact": http_url(term.get("contact_form")),
            "phone": info.findtext("phone") or term.get("phone"),
            "address": address or term.get("address"),
            "vacant": not bio,
        })
    # The House Clerk XML can omit the American Samoa delegate.
    if "AS-00" not in house:
        for bio, (name, term) in terms.items():
            if term["state"] == "AS" and term["type"] == "rep":
                house["AS-00"] = compact({
                    "id": bio, "name": name["official_full"],
                    "party": PARTIES.get(term["party"], term["party"]),
                    "website": http_url(term.get("url")),
                    "phone": term.get("phone"), "address": term.get("address"),
                })

    senate = {}
    for member in senate_xml.findall("./member"):
        state = member.findtext("state")
        class_number = {"Class I": 1, "Class II": 2, "Class III": 3}.get(member.findtext("class"))
        if not state or not class_number:
            continue
        bio = member.findtext("bioguide_id")
        name, term = terms.get(bio, ({}, {}))
        fallback_name = " ".join(filter(None, (member.findtext("first_name"), member.findtext("last_name"))))
        senate[f"{state}-{class_number}"] = compact({
            "id": bio, "name": name.get("official_full") or fallback_name,
            "alias": " ".join(filter(None, (name.get("first"), name.get("last")))),
            "party": PARTIES.get(member.findtext("party"), term.get("party")),
            "website": http_url(member.findtext("website") or term.get("url")),
            "contact": http_url(term.get("contact_form") or member.findtext("email")),
            "phone": member.findtext("phone") or term.get("phone"),
            "address": member.findtext("address") or term.get("address"),
        })
    return {"house": house, "senate": senate}


def race(region):
    source = f"https://civicapi.org/results/elections/{region['election_id']}"
    winners = [candidate for candidate in region["candidates"] if candidate.get("winner") is True]
    if len(winners) == 1:
        candidate = winners[0]
        return {"status": "called", "name": candidate["name"], "party": candidate["party"], "source": source}
    advancing = [candidate for candidate in region["candidates"] if candidate.get("advanced") is True]
    if advancing:
        return {"status": "runoff", "source": source}
    return {"status": "uncalled", "source": source}


def get_elections(house_data, senate_data):
    house = {}
    for district, region in house_data["region_results"].items():
        state, number = district.upper().split("-")
        house[house_key(state, number)] = race(region)

    if len(house) != 435:
        raise ValueError(f"Expected 435 voting House races, got {len(house)}")

    for state, (name, party, source, campaign) in DELEGATES.items():
        house[f"{state}-00"] = compact({
            "name": name, "party": party, "status": "called", "source": source, "campaign": campaign,
        })

    for number in (5, 6):
        key = f"LA-{number:02d}"
        if house[key]["status"] == "runoff":
            house[key]["runoffDate"] = "2026-12-12"

    if datetime.now(timezone.utc) >= datetime.fromisoformat("2026-12-12T19:00:00-06:00"):
        query = urlencode({"startDate": "2026-12-12", "endDate": "2026-12-12", "province": "LA", "limit": 200})
        for result in get_json(f"{CIVIC_API}/search?{query}").get("races", []):
            if result["type"] != "House of Representatives" or result.get("district") not in {"LA-05", "LA-06"}:
                continue
            runoff = race({"election_id": result["id"], "candidates": result["candidates"]})
            if runoff["status"] == "called":
                house[result["district"]] = runoff

    senate = {
        f"{state.upper()}-{3 if state in ('fl', 'oh') else 2}": race(region)
        for state, region in senate_data["region_results"].items()
    }
    if len(senate) != 35:
        raise ValueError(f"Expected 35 Senate races, got {len(senate)}")
    return {"house": house, "senate": senate}


def name_words(name):
    name = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode().casefold()
    words = re.findall(r"[a-z]+", re.sub(r"['’]", "", name))
    return [word for word in words if word not in {"jr", "sr", "ii", "iii", "iv"}]


FIRST_NAMES = {
    "andy": "andrew", "ben": "benjamin", "bill": "william", "bob": "robert",
    "chris": "christopher", "dan": "daniel", "dave": "david", "deb": "deborah",
    "don": "donald", "doug": "douglas", "ed": "edward", "greg": "gregory",
    "jeff": "jeffrey", "jim": "james", "joe": "joseph", "johnny": "john", "lou": "luis",
    "gil": "gilbert", "hal": "harold", "herb": "herbert", "brad": "bradley",
    "gabe": "gabriel", "bobby": "robert", "chuck": "charles",
    "jon": "jonathan", "josh": "joshua", "kate": "katherine", "matt": "matthew",
    "mike": "michael", "nick": "nicholas", "pat": "patricia", "pete": "peter",
    "rob": "robert", "ron": "ronald", "sam": "samuel", "scott": "scott",
    "steve": "steven", "stephen": "steven", "ted": "edward", "tim": "timothy",
    "tom": "thomas", "tony": "anthony", "trish": "patricia", "will": "william",
}


def match_score(left, right):
    a, b = name_words(left), name_words(right)
    if not a or not b:
        return 0
    if a == b:
        return 4
    if len(a) > 1 and len(b) > 1 and a[-1] == b[-1]:
        if a[0] == b[0]:
            return 3
        known_first = lambda word: FIRST_NAMES.get(word, word)
        if known_first(a[0]) == known_first(b[0]):
            return 2
        short, long = sorted((a, b), key=len)
        if len(short) == 2 and any(known_first(short[0]) == known_first(word) for word in long[:-1]):
            return 1
    return 0


def add_office(key, result, offices):
    if not result.get("name"):
        return
    state = key.split("-")[0]
    matches = []
    for seat, office in offices.items():
        if seat.split("-")[0] != state or not office.get("name") or result["party"] != office.get("party"):
            continue
        score = max(match_score(result["name"], office["name"]), match_score(result["name"], office.get("alias")))
        if score:
            matches.append((score, seat == key, office))
    matches.sort(key=lambda entry: entry[:2], reverse=True)
    if matches and (len(matches) == 1 or matches[0][:2] != matches[1][:2]):
        result["office"] = {key: value for key, value in matches[0][2].items() if key != "alias"}
        result["sameSeat"] = matches[0][1]


def load_campaigns(snapshot, elections, refresh):
    old = {
        (key.split("-")[0], tuple(name_words(result["name"]))): result
        for chamber in snapshot.get("elections", {}).values()
        for key, result in chamber.items() if "name" in result
    }
    missing = []
    for chamber, races in elections.items():
        for key, result in races.items():
            if "name" not in result or "office" in result or "campaign" in result:
                continue
            state = key.split("-")[0]
            override = CAMPAIGN_LINKS.get((key, result["name"]))
            if override:
                result["campaign"] = override
                continue
            cached = old.get((state, tuple(name_words(result["name"]))), {})
            for field in ("campaign", "profile"):
                if field in cached:
                    result[field] = cached[field]
            if "campaign" not in result and (refresh or "profile" not in result):
                missing.append((chamber, key, result))
    if not missing:
        return

    try:
        sitemap = ET.fromstring(fetch(f"{VOTER_GUIDE}/sitemap.xml"))
    except (URLError, TimeoutError, ET.ParseError) as error:
        print(f"Campaign directory unavailable: {error}")
        return

    profiles = {}
    for entry in sitemap:
        url = entry.findtext("{*}loc") or ""
        match = re.fullmatch(r"https://votewiser\.com/2026/([A-Z]{2})/([^/]+)", url)
        if match:
            state, slug = match.groups()
            profiles.setdefault(state, []).append((unquote(slug).replace("_", " "), url))

    def lookup(item):
        chamber, key, result = item
        state = key.split("-")[0]
        options = sorted(
            ((match_score(result["name"], label), url) for label, url in profiles.get(state, [])),
            reverse=True,
        )
        if not options or not options[0][0] or (len(options) > 1 and options[0][0] == options[1][0]):
            return
        url = options[0][1]
        try:
            page = fetch(url).decode()
        except (URLError, TimeoutError):
            return
        # Verify the profile belongs to the expected chamber before accepting its link.
        number = int(key.split("-")[1])
        if chamber == "senate":
            office_label = r"U\.S\. Senate"
        elif number == 0:
            office_label = r"District (?:0+|At[- ]Large)\b|At[- ]Large"
        else:
            office_label = rf"District 0*{number}\b"
        # On incumbent pages the office label may be inside a link.
        details = re.findall(r'<li class="text-gray-600"[^>]*>(.*?)</li>', page, re.S)
        if not any(re.search(office_label, re.sub(r"<[^>]+>", "", item), re.I) for item in details):
            return
        result["profile"] = url
        link = re.search(r'<a\b[^>]*href="([^"]+)"[^>]*>\s*Campaign Website\s*</a>', page)
        if link and (campaign := http_url(html.unescape(link[1]))):
            result["campaign"] = campaign

    with ThreadPoolExecutor(max_workers=5) as executor:
        list(executor.map(lookup, missing))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaigns", action="store_true", help="Retry candidate profiles without a campaign link.")
    args = parser.parse_args()
    previous = json.loads(DATA.read_text()) if DATA.exists() else {}
    with ThreadPoolExecutor(max_workers=5) as executor:
        legislators, house_source, senate_source, house_results, senate_results = [
            request.result() for request in (
                executor.submit(get_json, LEGISLATORS),
                executor.submit(fetch, HOUSE_CLERK),
                executor.submit(fetch, SENATE_DIRECTORY),
                executor.submit(get_json, f"{CIVIC_API}/87524"),
                executor.submit(get_json, f"{CIVIC_API}/87528"),
            )
        ]
    house_xml = ET.fromstring(house_source)
    now = datetime.now(timezone.utc)
    latest = get_roster(legislators, house_xml, ET.fromstring(senate_source))
    if len(latest["house"]) != 441 or len(latest["senate"]) != 100:
        raise ValueError(f"Incomplete office directories: {len(latest['house'])} House, {len(latest['senate'])} Senate")
    term = int(house_xml.findtext("title-info/congress-num"))
    roster = latest if term == 119 and now < START else previous.get("roster")
    if roster is None:
        raise ValueError("The archived 119th Congress roster is missing.")
    active = latest if term == 120 and now >= START else None

    elections = get_elections(house_results, senate_results)
    for chamber, results in elections.items():
        for key, result in results.items():
            add_office(key, result, (active or roster)[chamber])
    load_campaigns(previous, elections, args.campaigns)
    for directory in (roster, active or {}):
        for offices in directory.values():
            for office in offices.values():
                office.pop("alias", None)

    output = compact({
        "checkedAt": now.isoformat(timespec="seconds"),
        "electionUpdatedAt": max(house_results["last_updated"], senate_results["last_updated"]),
        "roster": roster, "active": active, "elections": elections,
    })
    DATA.parent.mkdir(exist_ok=True)
    temporary = DATA.with_suffix(".tmp")
    temporary.write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(DATA)
    winners = [r for results in elections.values() for r in results.values() if r["status"] == "called"]
    contacts = sum(any(r.get(field) for field in ("office", "campaign")) for r in winners)
    print(f"Updated {len(winners)} called races. {contacts} have an office or campaign link.")


if __name__ == "__main__":
    main()
